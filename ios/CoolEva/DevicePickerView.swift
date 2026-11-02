import SwiftUI

/// The app's stand-in for Chrome's Bluetooth chooser: every Pi advertising the dashboard
/// service, strongest first. Dismissing it answers the page's `requestDevice` with
/// NotFoundError, which ble-link.js treats as the rider changing their mind.
struct DevicePickerView: View {
    @ObservedObject var bridge: BleBridge

    var body: some View {
        NavigationStack {
            List {
                if bridge.candidates.isEmpty {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Looking for the Pi… it advertises as “cool-eva” while BLE_SECRET is set.")
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(bridge.candidates.sorted { $0.rssi > $1.rssi }) { candidate in
                    Button {
                        bridge.choose(candidate)
                    } label: {
                        HStack {
                            Text(candidate.name)
                            Spacer()
                            Text("\(candidate.rssi) dBm").foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
                }
            }
            .navigationTitle("Connect to the Pi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { bridge.choose(nil) }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
