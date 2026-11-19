import SwiftUI
import WebKit

/// A project HTML page served with its folder as the site, so relative styles, scripts and links
/// resolve as in a browser. The server mints a site token through an authorized request that
/// redirects into `/api/file-sites/<token>/…`; the token in the path is the only credential, so
/// the bearer token never reaches the page. Mirrors `HtmlPagePreview.tsx`.
struct HtmlSitePreview: NSViewRepresentable {
    let projectId: String
    let entry: String
    let version: String
    let reload: Int
    let onPage: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        context.coordinator.attach(view)
        context.coordinator.update(projectId: projectId, entry: entry, version: version, reload: reload, onPage: onPage)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.update(projectId: projectId, entry: entry, version: version, reload: reload, onPage: onPage)
    }

    /// `page` relative to the folder of `site`, as the mint's `page` parameter takes it.
    static func relative(_ page: String, site: String) -> String? {
        guard let cut = site.lastIndex(of: "/") else { return page }
        let folder = site[..<cut] + "/"
        return page.hasPrefix(folder) ? String(page.dropFirst(folder.count)) : nil
    }

    /// The project path of a page the web view reports, for a site minted from `entry`.
    static func pagePath(entry: String, url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let marker = components.percentEncodedPath.range(of: "/api/file-sites/") else { return nil }
        let rest = components.percentEncodedPath[marker.upperBound...]
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        var segments: [String] = []
        for part in rest[rest.index(after: slash)...].split(separator: "/", omittingEmptySubsequences: false) {
            guard let decoded = part.removingPercentEncoding else { return nil }
            segments.append(decoded)
        }
        var relative = segments.joined(separator: "/")
        if relative.isEmpty || relative.hasSuffix("/") { relative += "index.html" }
        guard let cut = entry.lastIndex(of: "/") else { return relative }
        return "\(entry[..<cut])/\(relative)"
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private weak var view: WKWebView?
        private var projectId = ""
        private var version = ""
        private var reload = 0
        private var requested: (projectId: String, entry: String)?
        private var onPage: (String) -> Void = { _ in }
        /// The file the current site was minted for; page paths resolve against its folder.
        private var minted = ""
        private var showing = ""
        /// The page last reopened because its token expired; a second expiry in a row stays on screen.
        private var renewed: String?
        private var mintURL: URL?

        func attach(_ view: WKWebView) { self.view = view }

        func update(projectId: String, entry: String, version: String, reload: Int, onPage: @escaping (String) -> Void) {
            self.onPage = onPage
            let opened = requested.map { $0.projectId == projectId && $0.entry == entry } ?? false
            let edited = opened && self.version != version
            let refreshed = self.reload != reload
            self.version = version
            self.reload = reload
            if !opened || edited {
                requested = (projectId, entry)
                self.projectId = projectId
                minted = entry
                open(entry)
            } else if refreshed {
                open(showing)
            }
        }

        /// Opens `page` of the site rooted at the folder of `minted`, so a page reopened after a link keeps
        /// its `../` links and assets.
        private func open(_ page: String) {
            guard let view, var components = ProjectDownloads.rawURL(projectId: projectId, path: minted).flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) else { return }
            var items = components.queryItems ?? []
            items.append(URLQueryItem(name: "render", value: "site"))
            if page != minted, let relative = HtmlSitePreview.relative(page, site: minted) { items.append(URLQueryItem(name: "page", value: relative)) }
            components.queryItems = items
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            guard let url = components.url else { return }
            showing = page
            mintURL = url
            view.load(ProjectDownloads.authorized(url))
        }

        private static func isSitePath(_ url: URL) -> Bool { url.path.contains("/api/file-sites/") }

        private func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
            lhs.scheme?.lowercased() == rhs.scheme?.lowercased() && lhs.host?.lowercased() == rhs.host?.lowercased() && lhs.port == rhs.port
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = action.request.url else { decisionHandler(.cancel); return }
            guard let frame = action.targetFrame else { decisionHandler(.cancel); return }
            if !frame.isMainFrame { decisionHandler(.allow); return }
            if let mintURL, target.path == mintURL.path, target.query?.contains("render=site") == true, sameOrigin(target, mintURL) {
                decisionHandler(.allow)
            } else if let mintURL, sameOrigin(target, mintURL), Self.isSitePath(target) {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            guard response.isForMainFrame, let http = response.response as? HTTPURLResponse,
                  let url = http.url, Self.isSitePath(url), let page = HtmlSitePreview.pagePath(entry: minted, url: url) else {
                decisionHandler(.allow)
                return
            }
            switch http.statusCode {
            case 401:
                if renewed == page { decisionHandler(.allow); return }
                renewed = page
                decisionHandler(.cancel)
                open(page)
            case 200:
                renewed = nil
                decisionHandler(.allow)
                if page != showing { showing = page }
                onPage(page)
            default:
                decisionHandler(.allow)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    }
}
