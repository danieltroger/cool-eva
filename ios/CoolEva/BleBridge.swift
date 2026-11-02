import CoreBluetooth
import UIKit
import WebKit

/// One device the picker can offer.
struct BleCandidate: Identifiable, Equatable {
    let id: UUID
    let name: String
    let rssi: Int
}

/// An error the shim turns into a DOMException of the same name.
struct BridgeError: Error {
    let name: String
    let message: String

    static func notFound(_ message: String) -> BridgeError { BridgeError(name: "NotFoundError", message: message) }
    static func network(_ message: String) -> BridgeError { BridgeError(name: "NetworkError", message: message) }
    static func notSupported(_ message: String) -> BridgeError { BridgeError(name: "NotSupportedError", message: message) }
    static func invalidState(_ message: String) -> BridgeError { BridgeError(name: "InvalidStateError", message: message) }
}

/// The page's Bluetooth, over CoreBluetooth: what `web-bluetooth-shim.js` calls into.
///
/// Everything runs on the main queue — CBCentralManager is created with `queue: nil`, and
/// WebKit delivers script messages on main — so the pending-operation tables below need
/// no locking. One peripheral at a time, the same as the Pi accepts one session.
final class BleBridge: NSObject, ObservableObject {
    @Published private(set) var candidates: [BleCandidate] = []
    @Published var picking = false

    weak var webView: WKWebView?
    /// Where the share sheet for a saved file is presented from.
    var presenter: () -> UIViewController? = { nil }

    private lazy var central = CBCentralManager(delegate: self, queue: nil)
    private var discovered: [UUID: CBPeripheral] = [:]
    private var peripheral: CBPeripheral?
    private var characteristics: [String: CBCharacteristic] = [:]

    private var poweredOnWaiters: [CheckedContinuation<Void, Error>] = []
    private var pickContinuation: CheckedContinuation<CBPeripheral, Error>?
    private var connectContinuation: CheckedContinuation<Void, Error>?
    private var discoveryContinuation: CheckedContinuation<Void, Error>?
    private var readContinuations: [String: CheckedContinuation<Data, Error>] = [:]
    private var writeContinuations: [String: CheckedContinuation<Void, Error>] = [:]
    private var notifyContinuations: [String: CheckedContinuation<Void, Error>] = [:]

    // MARK: - The page's calls

    func handle(op: String, body: [String: Any]) async throws -> Any? {
        switch op {
        case "requestDevice":
            let services = (body["services"] as? [String] ?? []).map { CBUUID(string: $0) }
            let chosen = try await requestDevice(services: services)
            return ["id": chosen.identifier.uuidString, "name": chosen.name ?? ""]
        case "connect":
            try await connect()
            return nil
        case "disconnect":
            if let peripheral {
                central.cancelPeripheralConnection(peripheral)
            }
            return nil
        case "service":
            guard let uuid = body["service"] as? String,
                  peripheral?.services?.contains(where: { $0.uuid == CBUUID(string: uuid) }) == true
            else {
                throw BridgeError.notFound("the Pi does not offer that service")
            }
            return nil
        case "characteristic":
            _ = try characteristic(named: body["characteristic"])
            return nil
        case "read":
            let key = try key(of: body["characteristic"])
            let data = try await read(key: key)
            return data.base64EncodedString()
        case "write":
            let key = try key(of: body["characteristic"])
            guard let text = body["value"] as? String, let data = Data(base64Encoded: text) else {
                throw BridgeError.invalidState("write carried no value")
            }
            try await write(data, key: key)
            return nil
        case "startNotifications":
            try await startNotifications(key: try key(of: body["characteristic"]))
            return nil
        case "saveFile":
            guard let name = body["name"] as? String, let text = body["value"] as? String,
                  let data = Data(base64Encoded: text)
            else {
                throw BridgeError.invalidState("saveFile carried no file")
            }
            try presentShareSheet(for: data, named: name)
            return nil
        default:
            throw BridgeError.notSupported("unknown bridge call \(op)")
        }
    }

    /// The picker's answer. `nil` is the rider dismissing it.
    func choose(_ candidate: BleCandidate?) {
        central.stopScan()
        picking = false
        guard let continuation = pickContinuation else { return }
        pickContinuation = nil
        guard let candidate, let chosen = discovered[candidate.id] else {
            continuation.resume(throwing: BridgeError.notFound("no Pi chosen"))
            return
        }
        continuation.resume(returning: chosen)
    }

    // MARK: - Operations

    private func requestDevice(services: [CBUUID]) async throws -> CBPeripheral {
        try await waitForPoweredOn()
        if let earlier = pickContinuation {
            pickContinuation = nil
            earlier.resume(throwing: BridgeError.notFound("superseded by a newer request"))
        }
        candidates = []
        discovered = [:]
        central.scanForPeripherals(withServices: services, options: nil)
        picking = true
        let chosen = try await withCheckedThrowingContinuation { pickContinuation = $0 }
        if peripheral !== chosen {
            if let old = peripheral {
                central.cancelPeripheralConnection(old)
            }
            peripheral = chosen
            characteristics = [:]
            chosen.delegate = self
        }
        return chosen
    }

    private func connect() async throws {
        guard let peripheral else { throw BridgeError.invalidState("no Pi chosen") }
        try await waitForPoweredOn()
        if peripheral.state != .connected {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                connectContinuation = continuation
                central.connect(peripheral, options: nil)
            }
        }
        // Rediscovered on every connect: a Pi that restarted its GATT application has new
        // handles, and stale CBCharacteristic objects would write into nothing.
        characteristics = [:]
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            discoveryContinuation = continuation
            peripheral.discoverServices(nil)
        }
    }

    private func read(key: String) async throws -> Data {
        guard let peripheral else { throw BridgeError.network("not connected") }
        let target = try characteristic(named: key)
        return try await withCheckedThrowingContinuation { continuation in
            readContinuations[key]?.resume(throwing: BridgeError.network("superseded by a newer read"))
            readContinuations[key] = continuation
            peripheral.readValue(for: target)
        }
    }

    private func write(_ data: Data, key: String) async throws {
        guard let peripheral else { throw BridgeError.network("not connected") }
        let target = try characteristic(named: key)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            writeContinuations[key]?.resume(throwing: BridgeError.network("a write was already pending"))
            writeContinuations[key] = continuation
            peripheral.writeValue(data, for: target, type: .withResponse)
        }
    }

    private func startNotifications(key: String) async throws {
        guard let peripheral else { throw BridgeError.network("not connected") }
        let target = try characteristic(named: key)
        if target.isNotifying { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            notifyContinuations[key] = continuation
            peripheral.setNotifyValue(true, for: target)
        }
    }

    private func waitForPoweredOn() async throws {
        switch central.state {
        case .poweredOn:
            return
        case .unsupported:
            throw BridgeError.notSupported("this device has no Bluetooth LE (the simulator never does)")
        case .unauthorized:
            throw BridgeError.notSupported("Bluetooth permission is off — Settings → Cool Eva → Bluetooth")
        case .poweredOff:
            throw BridgeError.notSupported("Bluetooth is turned off")
        default:
            try await withCheckedThrowingContinuation { poweredOnWaiters.append($0) }
        }
    }

    private func key(of value: Any?) throws -> String {
        guard let text = value as? String else { throw BridgeError.invalidState("no characteristic named") }
        return text.lowercased()
    }

    private func characteristic(named value: Any?) throws -> CBCharacteristic {
        let key = try key(of: value)
        guard let found = characteristics[key] else {
            throw BridgeError.notFound("the Pi does not offer characteristic \(key)")
        }
        return found
    }

    private func presentShareSheet(for data: Data, named name: String) throws {
        let safeName = name.replacingOccurrences(of: "/", with: "_")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(safeName)
        try data.write(to: file, options: .atomic)
        guard let presenter = presenter() else {
            throw BridgeError.invalidState("nowhere to present the share sheet from")
        }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = presenter.view
        presenter.present(sheet, animated: true)
    }

    /// Every pending call fails together when the link goes, so the page never waits on a
    /// reply that cannot come.
    private func failEverything(_ error: BridgeError) {
        connectContinuation?.resume(throwing: error)
        connectContinuation = nil
        discoveryContinuation?.resume(throwing: error)
        discoveryContinuation = nil
        for continuation in readContinuations.values { continuation.resume(throwing: error) }
        readContinuations = [:]
        for continuation in writeContinuations.values { continuation.resume(throwing: error) }
        writeContinuations = [:]
        for continuation in notifyContinuations.values { continuation.resume(throwing: error) }
        notifyContinuations = [:]
    }

    private func sendToPage(_ script: String, arguments: [String: Any]) {
        guard let webView else { return }
        webView.callAsyncJavaScript(script, arguments: arguments, in: nil, in: .page) { result in
            if case let .failure(error) = result {
                print("cool-eva: could not deliver to the page: \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - CoreBluetooth

extension BleBridge: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        print("cool-eva: Bluetooth state \(central.state.rawValue)")
        guard central.state != .unknown, central.state != .resetting else { return }
        let waiters = poweredOnWaiters
        poweredOnWaiters = []
        for waiter in waiters {
            if central.state == .poweredOn {
                waiter.resume()
            } else {
                waiter.resume(throwing: BridgeError.notSupported("Bluetooth is unavailable (state \(central.state.rawValue))"))
            }
        }
        if central.state != .poweredOn {
            failEverything(.network("Bluetooth went away"))
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        discovered[peripheral.identifier] = peripheral
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? "Unnamed Pi"
        let candidate = BleCandidate(id: peripheral.identifier, name: name, rssi: RSSI.intValue)
        if let index = candidates.firstIndex(where: { $0.id == candidate.id }) {
            candidates[index] = candidate
        } else {
            candidates.append(candidate)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        connectContinuation?.resume()
        connectContinuation = nil
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connectContinuation?.resume(throwing: BridgeError.network(error?.localizedDescription ?? "connection failed"))
        connectContinuation = nil
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }
        print("cool-eva: disconnected: \(error?.localizedDescription ?? "on request")")
        failEverything(.network(error?.localizedDescription ?? "disconnected"))
        sendToPage("window.__coolEvaBle.disconnected()", arguments: [:])
    }
}

extension BleBridge: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            discoveryContinuation?.resume(throwing: BridgeError.network(error.localizedDescription))
            discoveryContinuation = nil
            return
        }
        let services = peripheral.services ?? []
        if services.isEmpty {
            discoveryContinuation?.resume()
            discoveryContinuation = nil
            return
        }
        for service in services {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for characteristic in service.characteristics ?? [] {
            characteristics[characteristic.uuid.uuidString.lowercased()] = characteristic
        }
        let allDiscovered = (peripheral.services ?? []).allSatisfy { $0.characteristics != nil }
        if let error {
            discoveryContinuation?.resume(throwing: BridgeError.network(error.localizedDescription))
            discoveryContinuation = nil
        } else if allDiscovered {
            discoveryContinuation?.resume()
            discoveryContinuation = nil
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let key = characteristic.uuid.uuidString.lowercased()
        // A read and a notification arrive through this same callback. A pending read
        // claims it; anything else is a notification for the page.
        if let read = readContinuations.removeValue(forKey: key) {
            if let error {
                read.resume(throwing: BridgeError.network(error.localizedDescription))
            } else {
                read.resume(returning: characteristic.value ?? Data())
            }
            return
        }
        guard error == nil, let value = characteristic.value else {
            print("cool-eva: notification error on \(key): \(error?.localizedDescription ?? "no value")")
            return
        }
        sendToPage(
            "window.__coolEvaBle.notification(uuid, value)",
            arguments: ["uuid": key, "value": value.base64EncodedString()]
        )
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        let key = characteristic.uuid.uuidString.lowercased()
        guard let write = writeContinuations.removeValue(forKey: key) else { return }
        if let error {
            write.resume(throwing: BridgeError.network(error.localizedDescription))
        } else {
            write.resume()
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        let key = characteristic.uuid.uuidString.lowercased()
        guard let waiter = notifyContinuations.removeValue(forKey: key) else { return }
        if let error {
            waiter.resume(throwing: BridgeError.network(error.localizedDescription))
        } else {
            waiter.resume()
        }
    }
}

// MARK: - The script message handler

extension BleBridge: WKScriptMessageHandlerWithReply {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "InvalidStateError: malformed bridge call")
            return
        }
        Task { @MainActor in
            do {
                replyHandler(try await self.handle(op: op, body: body), nil)
            } catch let error as BridgeError {
                replyHandler(nil, "\(error.name): \(error.message)")
            } catch {
                replyHandler(nil, "NetworkError: \(error.localizedDescription)")
            }
        }
    }
}
