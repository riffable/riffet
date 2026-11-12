import Foundation
import WebKit

/// Serves the one page of a plugin's web view under `riffet-plugin://<pluginId>/index.html`: the
/// bootstrap document around the package's entry script. Every other path is a 404, so the page can
/// load nothing else through this scheme.
@MainActor
final class PluginSchemeHandler: NSObject, WKURLSchemeHandler {
    struct Page {
        let html: String
        let policy: String
    }

    private let pluginId: String
    private let page: @MainActor () async throws -> Page
    private var running: [ObjectIdentifier: (task: WKURLSchemeTask, work: Task<Void, Never>)] = [:]

    /// `page` reads the entry and builds the document each time the page is requested.
    init(pluginId: String, page: @escaping @MainActor () async throws -> Page) {
        self.pluginId = pluginId
        self.page = page
    }

    /// Ends the requests in flight without answering them.
    func cancelAll() {
        for entry in running.values { entry.work.cancel() }
        running = [:]
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let request = urlSchemeTask.request
        guard let url = request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        guard (request.httpMethod ?? "GET") == "GET", PluginPageDocument.isPage(url, pluginId: pluginId, allowRoot: true) else {
            if let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain; charset=utf-8", "Content-Length": "0"]) {
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didFinish()
            } else {
                urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            }
            return
        }
        let key = ObjectIdentifier(urlSchemeTask)
        let work = Task {
            let outcome: Result<Page, Error>
            do { outcome = .success(try await self.page()) } catch { outcome = .failure(error) }
            // A task that was stopped must not be called again.
            guard let entry = self.running.removeValue(forKey: key), entry.task === urlSchemeTask else { return }
            switch outcome {
            case .success(let page):
                let body = Data(page.html.utf8)
                let headers = [
                    "Content-Type": "text/html; charset=utf-8", "Content-Length": String(body.count),
                    "Content-Security-Policy": page.policy, "Cache-Control": "no-store",
                ]
                guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
                    urlSchemeTask.didFailWithError(URLError(.cannotParseResponse))
                    return
                }
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(body)
                urlSchemeTask.didFinish()
            case .failure(let error):
                // Only the description survives the trip through WebKit, so it is what the view reports.
                urlSchemeTask.didFailWithError(NSError(domain: "io.github.riffable.plugin", code: 1, userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]))
            }
        }
        running[key] = (urlSchemeTask, work)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.work.cancel()
    }
}
