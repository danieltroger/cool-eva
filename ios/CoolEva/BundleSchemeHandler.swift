import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the bundled dashboard (`public/`, copied into the app as a folder) under
/// `cooleva://app/…`.
///
/// A custom scheme rather than `loadFileURL`: WebKit gives `file://` pages an opaque
/// origin, which refuses ES module imports — and the dashboard is nothing but ES
/// modules. The scheme is registered secure by WebKit, which is what gives the page
/// `crypto.subtle` for the BLE session's sealing. docs/ios-app.md §"Loading the page".
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "cooleva"
    static let startURL = URL(string: "\(scheme)://app/index.html")!

    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" {
            path = "/index.html"
        }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        // A `..` in the path must not walk out of the bundled folder.
        guard file.path.hasPrefix(root.path + "/") else {
            respond(task, url: url, status: 403, body: Data("forbidden\n".utf8), mimeType: "text/plain")
            return
        }
        do {
            let body = try Data(contentsOf: file)
            respond(task, url: url, status: 200, body: body, mimeType: Self.mimeType(for: file))
        } catch {
            print("cool-eva: no bundled file for \(path): \(error.localizedDescription)")
            respond(task, url: url, status: 404, body: Data("not found\n".utf8), mimeType: "text/plain")
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, body: Data, mimeType: String) {
        let headers = [
            "Content-Type": mimeType,
            "Content-Length": String(body.count),
            "Cache-Control": "no-store",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    /// Module scripts are refused unless served as JavaScript, so this is not cosmetic.
    private static func mimeType(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "js", "mjs": return "text/javascript"
        case "html": return "text/html; charset=utf-8"
        case "css": return "text/css"
        case "json", "webmanifest": return "application/json"
        case "svg": return "image/svg+xml"
        default:
            return UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
