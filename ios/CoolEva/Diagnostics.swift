import WebKit

/// What the page can and cannot do inside this WKWebView, printed to the device log on
/// every load. The BLE session needs all of it (crypto.subtle and CompressionStream for
/// public/lib/ble-wire.js, a secure context for the first), and a page missing one would
/// otherwise just look like a link that never connects.
enum Diagnostics {
    /// Forwards uncaught errors and failed module loads to the native log — otherwise
    /// invisible without a Mac attached to Safari's inspector.
    static let errorReporter = """
        window.addEventListener("error", event => {
          window.webkit.messageHandlers.diagnostics.postMessage(
            "error: " + (event.message || "") + " at " + (event.filename || (event.target && event.target.src) || "?") + ":" + (event.lineno || 0)
          );
        }, true);
        window.addEventListener("unhandledrejection", event => {
          window.webkit.messageHandlers.diagnostics.postMessage("unhandled rejection: " + String(event.reason));
        });
        """

    static func reportCapabilities(of webView: WKWebView) {
        let probe = """
            JSON.stringify({
              href: location.href,
              secureContext: window.isSecureContext,
              subtle: typeof crypto !== "undefined" && typeof crypto.subtle === "object",
              compression: typeof CompressionStream === "function",
              bluetooth: typeof navigator.bluetooth === "object",
              nativeShell: typeof window.coolEvaNative === "object",
            })
            """
        webView.evaluateJavaScript(probe) { result, error in
            if let error {
                print("cool-eva: capability probe failed: \(error.localizedDescription)")
                return
            }
            print("cool-eva: capabilities \(result ?? "nil")")
        }
        #if targetEnvironment(simulator)
            // The simulator has no Bluetooth, so this must come back NotSupportedError —
            // which proves the whole bridge round trip and the shim's error-name mapping.
            webView.callAsyncJavaScript(
                """
                try { await navigator.bluetooth.requestDevice({ filters: [{ services: ["7c0e0001-5f3a-4c8e-9d2b-c00e7a000001"] }] }); return "resolved?!"; }
                catch (error) { return error.name + ": " + error.message; }
                """,
                arguments: [:], in: nil, in: .page
            ) { result in
                print("cool-eva: bridge round trip \(result)")
            }
        #endif
    }
}
