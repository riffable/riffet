import SwiftUI
import WebKit

/// A project HTML page served with its folder as the site, so relative styles, scripts, images and
/// links resolve as they do in a browser. Mirrors `HtmlPagePreview` on the web.
struct ProjectHTMLSite: UIViewRepresentable {
    let workbench: Workbench
    let projectID: String
    let entry: String
    let reload: Int
    let onPage: (String) -> Void
    let failed: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        let coordinator = context.coordinator
        coordinator.attach(view, workbench: workbench, projectID: projectID, onPage: onPage, failed: failed)
        coordinator.reload = reload
        coordinator.root(entry)
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onPage = onPage
        coordinator.failed = failed
        if coordinator.reload != reload { coordinator.reload = reload; coordinator.open(coordinator.showing) }
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { coordinator.close() }

    /// The project path of a page the web view reports, for a site opened from `entry`.
    static func pagePath(entry: String, url: URL) -> String? {
        guard let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
              let marker = encoded.range(of: "/api/file-sites/") else { return nil }
        let rest = encoded[marker.upperBound...]
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let segments = rest[rest.index(after: slash)...].split(separator: "/", omittingEmptySubsequences: false).map { $0.removingPercentEncoding }
        guard !segments.contains(where: { $0 == nil }) else { return nil }
        var relative = segments.compactMap { $0 }.joined(separator: "/")
        if relative.isEmpty || relative.hasSuffix("/") { relative += "index.html" }
        guard let cut = entry.lastIndex(of: "/") else { return relative }
        return entry[..<cut] + "/" + relative
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        var onPage: (String) -> Void = { _ in }
        var failed: (String) -> Void = { _ in }
        var reload = 0
        /// The page the web view shows now, as far as it has said.
        private(set) var showing = ""
        private var entry = ""
        private var renewed: String?
        private var rejected: URL?
        private weak var view: WKWebView?
        private var workbench: Workbench?
        private var projectID = ""
        private var mint: Task<Void, Never>?
        private var observation: NSKeyValueObservation?

        func attach(_ view: WKWebView, workbench: Workbench, projectID: String, onPage: @escaping (String) -> Void, failed: @escaping (String) -> Void) {
            self.view = view; self.workbench = workbench; self.projectID = projectID; self.onPage = onPage; self.failed = failed
            observation = view.observe(\.url, options: [.new]) { [weak self] web, _ in
                MainActor.assumeIsolated { self?.urlChanged(web.url) }
            }
        }
        func close() { mint?.cancel(); observation = nil }

        /// Roots the site at the folder of `file` and opens it.
        func root(_ file: String) { entry = file; open(file) }

        /// Mints the site rooted at the folder of `entry` and opens `page` in it, so a page reopened after a
        /// link keeps its `../` links and assets; the minted address holds no device credential.
        func open(_ page: String) {
            showing = page
            let entry = entry
            let relative: String? = page == entry ? nil : {
                guard let cut = entry.lastIndex(of: "/") else { return page }
                let folder = entry[..<cut] + "/"
                return page.hasPrefix(folder) ? String(page.dropFirst(folder.count)) : nil
            }()
            mint?.cancel()
            mint = Task { [weak self] in
                guard let self, let workbench = self.workbench else { return }
                do {
                    let url = try await workbench.resources.siteURL(projectID: self.projectID, path: entry, page: relative)
                    guard !Task.isCancelled else { return }
                    self.view?.load(URLRequest(url: url))
                } catch {
                    guard !Task.isCancelled else { return }
                    self.failed(error.riffetMessage)
                }
            }
        }

        private func isSite(_ url: URL?) -> Bool {
            guard let url, let base = workbench?.baseURL else { return false }
            return ServerAddress.sameOrigin(url, base) && url.path.contains("/api/file-sites/")
        }

        private func urlChanged(_ url: URL?) {
            guard let url, url != rejected, isSite(url), let page = ProjectHTMLSite.pagePath(entry: entry, url: url), page != showing else { return }
            showing = page
            onPage(page)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = action.request.url
            if action.targetFrame == nil {
                // A new-window link opens in place; no second web view is ever made.
                if isSite(url), action.request.httpMethod == "GET" { webView.load(action.request) }
                decisionHandler(.cancel); return
            }
            if action.targetFrame?.isMainFrame == false, url?.scheme == "about" { decisionHandler(.allow); return }
            decisionHandler(isSite(url) ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            guard response.isForMainFrame, let http = response.response as? HTTPURLResponse, let url = http.url, isSite(url),
                  let page = ProjectHTMLSite.pagePath(entry: entry, url: url) else { decisionHandler(.allow); return }
            switch http.statusCode {
            case 401 where renewed != page:
                // The token expired: mint once more for this page; a second expiry in a row stays on screen.
                renewed = page; rejected = nil
                decisionHandler(.cancel)
                open(page)
            case 200..<300:
                renewed = nil; rejected = nil
                decisionHandler(.allow)
            default:
                // A missing page: the web view says so, the title keeps the last page that loaded.
                rejected = url
                decisionHandler(.allow)
            }
        }
    }
}
