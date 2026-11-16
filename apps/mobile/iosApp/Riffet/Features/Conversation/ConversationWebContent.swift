import SwiftUI
import WebKit

struct ConversationMath: View {
    let tex: String
    let workbench: Workbench
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .body) private var fontSize = 17.0
    @State private var height: CGFloat?
    @State private var error: String?
    private var memoKey: String { "math|\(fontSize)|\(tex)" }
    /// Before the page reports: the height this formula settled to before, else one line per `\\` row.
    private var reservedHeight: CGFloat {
        if let known = ConversationLayoutMemo.shared.height(memoKey) { return known }
        let rows = max(1, tex.components(separatedBy: "\\\\").count)
        let tall = ["\\frac", "\\sum", "\\int", "\\prod", "\\begin"].contains { tex.contains($0) }
        return CGFloat(rows) * (tall ? 40 : 30) + 14
    }
    var body: some View {
        let encoded = tex.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let color = scheme == .dark ? "%23eeeeee" : "%23222222"
        if error == nil, let url = URL(string: "math#tex=\(encoded)&d=1&c=\(color)&s=\(scheme == .dark ? "dark" : "light")", relativeTo: workbench.baseURL.appendingPathComponent("/"))?.absoluteURL {
            ConversationPublicMathPage(url: url, fontSize: fontSize, heightChanged: { value in
                height = value; ConversationLayoutMemo.shared.setHeight(value, for: memoKey)
            }, failed: { error = $0 })
                .frame(height: height ?? reservedHeight).accessibilityLabel("公式：\(tex)")
                .onChange(of: tex) { _, _ in error = nil }
        } else {
            Text(tex).riffetFont(.mono).textSelection(.enabled)
                .onChange(of: tex) { _, _ in error = nil }
        }
    }
}

struct ConversationCodePreview: View {
    static func isDiagram(_ language: String?) -> Bool {
        ["mermaid", "mmd", "dot", "graphviz", "gv", "plantuml", "puml", "uml", "wsd", "d2", "vega", "vega-lite", "vegalite", "vl"].contains(language?.lowercased() ?? "")
    }

    let source: String
    let language: String
    let workbench: Workbench
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if var components = URLComponents(url: workbench.baseURL, resolvingAgainstBaseURL: false) {
            let diagram = Self.isDiagram(language)
            let _ = components.path = diagram ? "/diagram" : "/content-preview"
            let _ = components.queryItems = diagram ? [URLQueryItem(name: "engine", value: language.lowercased())] : nil
            let _ = components.fragment = nil
            var fragment = URLComponents()
            let _ = fragment.queryItems = ConversationPreviewDocument.theme(dark: scheme == .dark) + [URLQueryItem(name: "language", value: language.lowercased()), URLQueryItem(name: "source", value: source)]
            let _ = components.percentEncodedFragment = fragment.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            if let url = components.url {
                ConversationWebPage(workbench: workbench, url: url).frame(height: 320)
            }
        }
    }
}

struct ConversationVisualization: View {
    let workbench: Workbench
    let projectID: String
    let path: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if let raw = workbench.resources.fileURL(projectID: projectID, path: path), var components = URLComponents(url: raw, resolvingAgainstBaseURL: false) {
            let _ = components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "render", value: "visualize"), URLQueryItem(name: "scheme", value: scheme == .dark ? "dark" : "light")]
            if let url = components.url { ConversationWebPage(workbench: workbench, url: url) }
        } else { ContentUnavailableView("无法打开预览", systemImage: "doc.badge.exclamationmark") }
    }
}

/// A specialized resource page, isolated from the web app and from the system cookie store.
struct ConversationWebPage: View {
    let workbench: Workbench
    let url: URL
    @State private var html: String?
    @State private var error: String?
    @State private var retry = 0
    var body: some View {
        Group {
            if let error { ContentUnavailableView { Label("预览加载失败", systemImage: "exclamationmark.triangle") } description: { Text(error) } actions: { Button("重试") { self.error = nil; html = nil; retry += 1 } } }
            else if url.path == "/math" { ConversationPublicMathPage(url: url) { error = $0 }.id(retry) }
            else if let html { RestrictedResourcePage(html: html, baseURL: url) { error = $0 }.id(retry) }
            else { ProgressView() }
        }.task(id: "\(url.absoluteString)|\(retry)") { guard url.path != "/math" else { return }; error = nil; html = nil; do { let data = try await workbench.resources.data(for: url); guard let text = String(data: data, encoding: .utf8) else { throw ClientFailure(String(localized: "预览内容不是有效的 HTML", bundle: .riffet)) }; html = text } catch { self.error = error.riffetMessage } }
    }
}

/// The HTTP preview CSP would be lost by loadHTMLString. Install an equivalent trusted policy
/// before any server-supplied bytes, and enforce the sandbox with an actual opaque-origin iframe.
enum ConversationPreviewDocument {
    static func previewURL(_ raw: URL, dark: Bool) -> URL? {
        guard var components = URLComponents(url: raw, resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = (components.queryItems ?? []).filter { !["render", "scheme", "color", "background", "line", "accent"].contains($0.name) } + theme(dark: dark) + [URLQueryItem(name: "render", value: "preview")]
        return components.url
    }
    static func theme(dark: Bool) -> [URLQueryItem] {
        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        func hex(_ color: UIColor) -> String {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
            return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
        }
        return [URLQueryItem(name: "scheme", value: dark ? "dark" : "light"),
            URLQueryItem(name: "color", value: hex(.label)), URLQueryItem(name: "background", value: hex(.systemBackground)),
            URLQueryItem(name: "line", value: hex(.separator)), URLQueryItem(name: "accent", value: hex(.systemBlue))]
    }
    static let visualizationResources = "data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://fonts.bunny.net https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com"
    static func html(source: String, url: URL) -> String {
        let isMath = url.path == "/math"
        let parameters = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let generated = parameters.contains { $0.name == "render" && $0.value == "preview" } || ["/diagram", "/mermaid", "/content-preview"].contains(url.path)
        var origin = URLComponents(url: url, resolvingAgainstBaseURL: false)
        origin?.path = ""; origin?.query = nil; origin?.fragment = nil
        let assets = (origin?.url?.absoluteString ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/katex/"
        let resources = isMath ? assets : (generated ? "data: blob:" : visualizationResources)
        let scripts = isMath ? "'unsafe-inline' \(assets)" : (generated ? "'unsafe-inline' 'wasm-unsafe-eval' blob:" : "'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' \(resources)")
        let shared = "default-src 'none'; script-src \(scripts); style-src 'unsafe-inline' \(resources); img-src \(isMath ? "data:" : resources); font-src \(resources); media-src \(isMath ? "'none'" : resources); worker-src \(isMath ? "'none'" : "blob:"); connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        var content = source
        var prelude = ""
        if isMath {
            // The math endpoint uses root-relative public assets. The sandbox has no application
            // origin, so make only that explicit asset directory absolute.
            content = content.replacingOccurrences(of: "\"/katex/", with: "\"" + assets)
        }
        if isMath || ["/diagram", "/mermaid", "/content-preview"].contains(url.path) {
            if let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedFragment,
               let encoded = try? JSONEncoder().encode("#" + fragment), let value = String(data: encoded, encoding: .utf8) {
                prelude = "<script>location.hash=" + value.replacingOccurrences(of: "<", with: "\\u003c") + ";</script>"
            }
        }
        let child = "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"" + escape(shared + "; frame-src 'none'") + "\"><meta name=\"referrer\" content=\"no-referrer\"></head><body>" + prelude + content + "</body></html>"
        let parentCSP = shared + "; frame-src 'self'"
        return "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"" + escape(parentCSP) + "\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"referrer\" content=\"no-referrer\"><style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;background:transparent}iframe{display:block}</style></head><body><iframe sandbox=\"allow-scripts\" referrerpolicy=\"no-referrer\" srcdoc=\"" + escape(child) + "\"></iframe></body></html>"
    }
    private static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}

private struct RestrictedResourcePage: UIViewRepresentable {
    let html: String
    let baseURL: URL
    let failed: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(failed: failed) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        let document = ConversationPreviewDocument.html(source: html, url: baseURL)
        context.coordinator.document = document
        view.loadHTMLString(document, baseURL: nil)
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {
        let document = ConversationPreviewDocument.html(source: html, url: baseURL)
        guard context.coordinator.document != document else { return }
        context.coordinator.document = document
        uiView.loadHTMLString(document, baseURL: nil)
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var document: String?
        let failed: (String) -> Void
        init(failed: @escaping (String) -> Void) { self.failed = failed }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // about:blank/srcdoc are the trusted host and its opaque sandbox; no page can navigate
            // to the server, an external site, a form target, or another application scheme.
            decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { failed(error.localizedDescription) } }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { failed(error.localizedDescription) } }
    }
}

/// /math is a fixed, public, credential-free KaTeX page. Loading the URL directly preserves its
/// HTTP CSP and the asset origin required by the fonts. TeX is fragment data and KaTeX trust=false.
private struct ConversationPublicMathPage: UIViewRepresentable {
    let url: URL
    var fontSize: Double = 17
    var heightChanged: (CGFloat) -> Void = { _ in }
    let failed: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(url: url, fontSize: fontSize, heightChanged: heightChanged, failed: failed) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = ConversationMathWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.widthChanged = { [weak coordinator = context.coordinator, weak web] in
            guard let web else { return }; coordinator?.measure(web)
        }
        web.isOpaque = false; web.backgroundColor = .clear
        web.scrollView.isScrollEnabled = true
        web.scrollView.bounces = false
        context.coordinator.load(web)
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.heightChanged = heightChanged
        let newURL = coordinator.url != url
        let newFont = coordinator.fontSize != fontSize
        coordinator.url = url
        coordinator.fontSize = fontSize
        if newURL {
            // /math reads the fragment once. A source/theme change must load that page again;
            // leaving updateUIView empty silently kept the previous streamed formula on screen.
            coordinator.load(web)
        } else if newFont { coordinator.measure(web) }
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var url: URL
        var fontSize: Double
        var heightChanged: (CGFloat) -> Void
        var loaded = false
        private var measureGeneration = 0
        private var loadGeneration = 0
        private var navigation: WKNavigation?
        let failed: (String) -> Void
        init(url: URL, fontSize: Double, heightChanged: @escaping (CGFloat) -> Void, failed: @escaping (String) -> Void) {
            self.url = url; self.fontSize = fontSize; self.heightChanged = heightChanged; self.failed = failed
        }
        func load(_ web: WKWebView) {
            loaded = false; loadGeneration += 1; measureGeneration += 1
            navigation = web.load(URLRequest(url: ConversationMathPolicy.reloadURL(url, generation: loadGeneration)))
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = action.request.url, ConversationMathPolicy.allows(target, expected: url) else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            guard let target = response.response.url, ConversationMathPolicy.allows(target, expected: url), let http = response.response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  http.value(forHTTPHeaderField: "Content-Security-Policy") != nil else {
                failed(String(localized: "公式页面不可用，或缺少必需的内容安全策略。", bundle: .riffet))
                decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { guard navigation === self.navigation else { return }; loaded = true; measure(webView) }
        func measure(_ webView: WKWebView) {
            guard loaded else { return }
            measureGeneration += 1
            let generation = measureGeneration
            // Only this fixed, CSP-validated, credential-free page gets native JS evaluation.
            // TeX never becomes executable source: it continues to travel as URL fragment data.
            webView.callAsyncJavaScript("""
            document.body.style.fontSize = size + 'px';
            await document.fonts.ready;
            return Math.ceil(document.getElementById('formula').getBoundingClientRect().height);
            """, arguments: ["size": fontSize], in: nil, in: .page) { [weak self] result in
                guard let self, generation == self.measureGeneration, case let .success(value) = result, let number = value as? NSNumber else { return }
                let height = ConversationMathPolicy.height(number.doubleValue)
                self.heightChanged(height)
            }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { failed(error.localizedDescription) } }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { failed(error.localizedDescription) } }
    }
}

/// Width changes (rotation, Split View, Dynamic Type) happen after SwiftUI's updateUIView.
private final class ConversationMathWebView: WKWebView {
    var widthChanged: (() -> Void)?
    private var measuredWidth: CGFloat = 0
    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, abs(bounds.width - measuredWidth) > 0.5 else { return }
        measuredWidth = bounds.width
        widthChanged?()
    }
}

enum ConversationMathPolicy {
    static func allows(_ target: URL, expected: URL) -> Bool {
        ServerAddress.sameOrigin(expected, target) && target.path == "/math" && target.user == nil && target.password == nil
    }
    static func hasGeneration(_ url: URL, generation: Int) -> Bool {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "_nativeMath" })?.value == String(generation)
    }
    static func reloadURL(_ url: URL, generation: Int) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        components.queryItems = (components.queryItems ?? []).filter { $0.name != "_nativeMath" } + [URLQueryItem(name: "_nativeMath", value: String(generation))]
        return components.url ?? url
    }
    static func height(_ measured: Double) -> CGFloat {
        guard measured.isFinite else { return 44 }
        // A malformed formula may be enormous. Keep an inner scroll surface in that exceptional
        // case, rather than allocating an unbounded transcript row or clipping normal fractions.
        return CGFloat(min(640, max(28, ceil(measured) + 8)))
    }
}

/// Formula data never enters script source or an HTTP query; only the public page sees it as a
/// fragment. The cache is origin-specific so switching Mac servers cannot reuse remote content.
struct ConversationInlineMathRequest: Hashable {
    let origin: URL
    let tex: String
    let fontSize: Double
    let dark: Bool
    var url: URL? {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false), ["http", "https"].contains(components.scheme?.lowercased() ?? ""), components.user == nil, components.password == nil else { return nil }
        components.path = "/math"; components.query = nil
        let fragment = URLComponents(string: "https://fragment.invalid")!
        var values = fragment
        values.queryItems = [URLQueryItem(name: "tex", value: tex), URLQueryItem(name: "d", value: "0"), URLQueryItem(name: "c", value: dark ? "#eeeeee" : "#222222")]
        components.percentEncodedFragment = values.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }
    var cacheKey: String { "\(origin.absoluteString)|\(fontSize)|\(dark)|\(tex)" }
}

/// Mirrors macOS InlineMathRenderer: one shared WebKit renderer produces native text attachments.
/// iOS exports a small vector PDF and rasterizes it, so no visible or off-screen window is needed.
/// A paragraph never owns a web view. Bounded images are reusable across visible rows and queries.
@MainActor
final class ConversationInlineMathRenderer: NSObject, WKNavigationDelegate {
    static let shared = ConversationInlineMathRenderer()
    struct Rendered {
        let image: UIImage
        let descent: CGFloat
    }
    private final class Box { let rendered: Rendered; init(_ rendered: Rendered) { self.rendered = rendered } }
    private let cache: NSCache<NSString, Box> = CacheRegistry.cache("conversation.math", bytes: CacheRegistry.Budget.math)
    private var waiting: [ConversationInlineMathRequest: [CheckedContinuation<Rendered?, Never>]] = [:]
    private var queue: [ConversationInlineMathRequest] = []
    private var current: ConversationInlineMathRequest?
    private var navigation: WKNavigation?
    private var generation = 0
    private var web: WKWebView?
    private var deadline: Task<Void, Never>?
    private(set) var webViewCreationCount = 0
    private(set) var renderCount = 0
    private(set) var lastFailure: String?

    func cached(_ request: ConversationInlineMathRequest) -> Rendered? { cache.object(forKey: request.cacheKey as NSString)?.rendered }
    func image(_ request: ConversationInlineMathRequest) async -> Rendered? {
        if let cached = cache.object(forKey: request.cacheKey as NSString) { return cached.rendered }
        guard !Task.isCancelled, request.url != nil, request.tex.utf16.count <= 4_096, waiting.count < 64 || waiting[request] != nil else { return nil }
        return await withCheckedContinuation { continuation in
            let exists = waiting[request] != nil
            waiting[request, default: []].append(continuation)
            if !exists { queue.append(request) }
            pump()
        }
    }
    private func pump() {
        guard current == nil, !queue.isEmpty else { return }
        let request = queue.removeFirst()
        current = request; generation += 1; lastFailure = nil
        let token = generation
        guard let url = request.url else { finish(nil); return }
        let web = ensureWebView()
        // A non-sensitive query generation forces a fresh document when only TeX fragments differ.
        navigation = web.load(URLRequest(url: ConversationMathPolicy.reloadURL(url, generation: generation)))
        deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, token == self.generation, self.current != nil else { return }
            self.lastFailure = "navigation.timeout"
            self.finish(nil)
        }
    }
    private func ensureWebView() -> WKWebView {
        if let web { return web }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 2_048, height: 512), configuration: config)
        view.isOpaque = false; view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.navigationDelegate = self
        webViewCreationCount += 1; web = view
        return view
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let expected = current?.url, let target = action.request.url, ConversationMathPolicy.allows(target, expected: expected) else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // A timed-out page can answer after the queue advanced to a different formula. Reject its
        // callback without completing that new formula's continuations.
        guard let responseURL = response.response.url, ConversationMathPolicy.hasGeneration(responseURL, generation: generation) else { decisionHandler(.cancel); return }
        guard let expected = current?.url, let target = response.response.url, ConversationMathPolicy.allows(target, expected: expected),
              let http = response.response as? HTTPURLResponse, (200..<300).contains(http.statusCode), http.value(forHTTPHeaderField: "Content-Security-Policy") != nil else {
            lastFailure = "response.rejected.\((response.response as? HTTPURLResponse)?.statusCode ?? 0)"
            decisionHandler(.cancel); finish(nil); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let active = self.navigation, navigation === active, let request = current else { return }
        let token = generation
        Task { [weak self, weak webView] in
            guard let self, let webView else { return }
            // This script runs only in the already CSP-validated fixed KaTeX page. It measures
            // layout and baseline; source TeX remains fragment data, never interpolated code.
            let script = """
            document.body.style.fontSize = size + 'px';
            document.body.style.margin = '0';
            const f = document.getElementById('formula');
            f.style.display = 'inline-block'; f.style.maxWidth = 'none'; f.style.overflow = 'visible';
            await document.fonts.ready;
            const marker = document.createElement('span');
            marker.style.display = 'inline-block'; marker.style.width = '1px'; marker.style.height = '0';
            f.parentNode.appendChild(marker);
            const r = f.getBoundingClientRect(), baseline = marker.getBoundingClientRect().top;
            marker.remove();
            return [r.x, r.y, r.width, r.height, baseline];
            """
            let values: [Double]
            do {
                let measured = try await webView.callAsyncJavaScript(script, arguments: ["size": request.fontSize], in: nil, contentWorld: .page)
                guard let numbers = measured as? [Double] else {
                    if token == self.generation { self.lastFailure = "measure.invalid-result"; self.finish(nil) }; return
                }
                values = numbers
            } catch {
                if token == self.generation { let value = error as NSError; self.lastFailure = "measure.error.\(value.domain).\(value.code)"; self.finish(nil) }; return
            }
            guard token == self.generation else { return }
            guard values.count == 5, values[2] > 0, values[3] > 0, values[2] <= 2_048, values[3] <= 512 else {
                self.lastFailure = "measure.invalid-bounds"; self.finish(nil); return
            }
            let rect = CGRect(x: floor(values[0]), y: floor(values[1]), width: ceil(values[2]) + 1, height: ceil(values[3]) + 1)
            // PDF export asks WebKit to paint the region directly. A composited snapshot can be
            // completely transparent when a view is detached or occluded by the app's root view.
            // This path has no dependency on a key window, screen visibility, or another overlay.
            let configuration = WKPDFConfiguration(); configuration.rect = rect
            configuration.allowTransparentBackground = true
            let pdf: Data
            do { pdf = try await webView.pdf(configuration: configuration) }
            catch {
                if token == self.generation { let value = error as NSError; self.lastFailure = "pdf.error.\(value.domain).\(value.code)"; self.finish(nil) }; return
            }
            guard token == self.generation else { return }
            guard let image = ConversationFormulaPDF.image(pdf) else {
                self.lastFailure = "pdf.invalid-document"; self.finish(nil); return
            }
            self.finish(Rendered(image: image, descent: max(0, rect.maxY - values[4])))
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(navigation, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(navigation, error) }
    private func failed(_ navigation: WKNavigation?, _ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled, let navigation, navigation === self.navigation else { return }
        let value = error as NSError; lastFailure = "navigation.error.\(value.domain).\(value.code)"
        finish(nil)
    }
    private func finish(_ rendered: Rendered?) {
        deadline?.cancel(); deadline = nil
        guard let request = current else { return }
        if let rendered {
            renderCount += 1
            let pixels = rendered.image.cgImage.map { $0.bytesPerRow * $0.height } ?? Int(rendered.image.size.width * rendered.image.size.height * 4)
            cache.setObject(Box(rendered), forKey: request.cacheKey as NSString, cost: pixels)
        }
        let callbacks = waiting.removeValue(forKey: request) ?? []
        current = nil; navigation = nil
        for callback in callbacks { callback.resume(returning: rendered) }
        pump()
    }
}


/// Rasterize the already-cropped formula PDF. Keep the media-box aspect and transparent background,
/// using the renderer's device scale rather than the low-resolution screenshot of a hidden surface.
enum ConversationFormulaPDF {
    static func image(_ data: Data) -> UIImage? {
        guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider), let page = document.page(at: 1) else { return nil }
        let box = page.getBoxRect(.mediaBox)
        guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0, box.width <= 2_050, box.height <= 514 else { return nil }
        let size = CGSize(width: ceil(box.width), height: ceil(box.height))
        let format = UIGraphicsImageRendererFormat(); format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { renderer in
            let context = renderer.cgContext
            context.translateBy(x: 0, y: size.height); context.scaleBy(x: 1, y: -1)
            context.concatenate(page.getDrawingTransform(.mediaBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true))
            context.drawPDFPage(page)
        }
    }
}
