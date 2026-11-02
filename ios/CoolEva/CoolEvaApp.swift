import SwiftUI
import UIKit

@main
struct CoolEvaApp: App {
    @StateObject private var bridge = BleBridge()

    var body: some Scene {
        WindowGroup {
            DashboardView(bridge: bridge)
                .ignoresSafeArea(.container, edges: .bottom)
                .background(Color(red: 0x0f / 255, green: 0x17 / 255, blue: 0x2a / 255))
                .sheet(isPresented: $bridge.picking, onDismiss: { bridge.choose(nil) }) {
                    DevicePickerView(bridge: bridge)
                }
                .onAppear {
                    bridge.presenter = topViewController
                }
        }
    }
}

/// The view controller a share sheet can be presented from: the key window's root, or
/// whatever it is already presenting.
private func topViewController() -> UIViewController? {
    let window = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
        .first(where: \.isKeyWindow)
    var top = window?.rootViewController
    while let presented = top?.presentedViewController {
        top = presented
    }
    return top
}
