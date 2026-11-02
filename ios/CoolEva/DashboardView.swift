import SwiftUI
import WebKit

/// The dashboard: one full-screen WKWebView on the bundled `public/`, with the BLE bridge
/// installed before the page's first script runs.
struct DashboardView: UIViewRepresentable {
    let bridge: BleBridge

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        guard let root = Bundle.main.url(forResource: "public", withExtension: nil) else {
            fatalError("public/ is missing from the app bundle — check the folder reference in the Xcode project")
        }
        configuration.setURLSchemeHandler(BundleSchemeHandler(root: root), forURLScheme: BundleSchemeHandler.scheme)
        configuration.userContentController.add(context.coordinator, name: "diagnostics")
        configuration.userContentController.addUserScript(
            WKUserScript(source: Diagnostics.errorReporter, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "coolEvaBle")
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.shimSource(), injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x0f / 255, green: 0x17 / 255, blue: 0x2a / 255, alpha: 1)
        #if DEBUG
            webView.isInspectable = true
        #endif
        bridge.webView = webView
        webView.load(URLRequest(url: BundleSchemeHandler.startURL))
        return webView
    }

    private static func shimSource() -> String {
        guard let url = Bundle.main.url(forResource: "web-bluetooth-shim", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8)
        else {
            fatalError("web-bluetooth-shim.js is missing from the app bundle")
        }
        return source
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Diagnostics.reportCapabilities(of: webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("cool-eva: navigation failed: \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("cool-eva: page did not load: \(error.localizedDescription)")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            print("cool-eva[page]: \(message.body)")
        }
    }
}
