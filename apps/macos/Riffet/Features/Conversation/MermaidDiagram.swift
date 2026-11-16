import AppKit
import WebKit
import RiffetKit

/// Diagram snapshots use the same resource notifications as formulas; their identity includes the
/// complete source so a layout never substitutes a previous version of a streaming diagram.
struct MermaidRequest: Hashable, Sendable {
    let source: String
    let dark: Bool
    let scale: CGFloat
    let color: String
    let background: String
    let line: String
    let accent: String
    var language: String = "mermaid"

    static func supports(_ language: String?) -> Bool {
        guard let language = language?.lowercased() else { return false }
        return ["mermaid", "mmd", "dot", "graphviz", "gv", "plantuml", "puml", "uml", "wsd", "d2", "vega", "vega-lite", "vegalite", "vl", "html", "htm", "svg"].contains(language)
    }

    var key: String { "\(language)|\(dark)|\(scale)|\(color)|\(background)|\(line)|\(accent)|\(source)" }
}

enum MermaidImages {
    enum Result {
        case image(NSImage)
        case pending(String)
        case failed
    }

    private struct Entry {
        let image: NSImage?
        let cost: Int
        let retryAt: Date?
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var entries: [String: Entry] = [:]
    nonisolated(unsafe) private static var recent: [String] = []
    nonisolated(unsafe) private static var requested: Set<String> = []
    nonisolated(unsafe) private static var cost = 0
    /// Diagram snapshots are pictures: a quarter of the decoded-image budget.
    private static let costLimit = Int(BudgetsKt.IMAGE_CACHE_MAC_DECODED_BYTES) / 4
    /// The most one snapshot may hold, so a few diagrams fit at once.
    fileprivate static let itemLimit = costLimit / 2
    private static let registered: Void = {
        CacheRegistry.shared.register("mermaid.images", limit: Int64(costLimit), size: { lock.withLock { Int64(cost) } }) {
            lock.withLock { entries.removeAll(); recent.removeAll(); cost = 0 }
        }
    }()
    private static let capacityToken = "mermaid-capacity"
    private static let retryDelay: TimeInterval = 10

    static func image(_ request: MermaidRequest) -> Result {
        _ = registered
        let key = request.key
        lock.lock()
        defer { lock.unlock() }
        if let entry = entries[key] {
            recent.removeAll { $0 == key }
            if let retryAt = entry.retryAt, retryAt <= Date() {
                entries.removeValue(forKey: key)
                cost -= entry.cost
            } else {
                recent.append(key)
                if entry.retryAt != nil { return .pending(token(request)) }
                return entry.image.map(Result.image) ?? .failed
            }
        }
        guard request.source.utf8.count <= 100_000 else { return .failed }
        if requested.contains(key) { return .pending(token(request)) }
        // Rows waiting for capacity retry when any in-flight diagram frees a slot.
        guard requested.count < 24 else { return .pending(capacityToken) }
        requested.insert(key)
        DispatchQueue.main.async { MainActor.assumeIsolated { MermaidRenderer.shared.enqueue(request) } }
        return .pending(token(request))
    }

    static func token(_ request: MermaidRequest) -> String { "mermaid:\(request.key)" }

    /// Sizes of diagrams drawn before, by source and text size (colours do not change the size), in
    /// this launch or an earlier one: a diagram on its way is given its room before it lands.
    private static let sizes = SizeMemory(name: "diagram-sizes", limit: 2000)

    private static func sizeKey(_ request: MermaidRequest) -> String { "\(request.language)|\(request.scale)|\(stableHash(request.source))" }

    /// The size [request] was drawn at before; nil when it was not, or while a failed attempt waits
    /// to be retried (its source shows meanwhile).
    static func size(_ request: MermaidRequest) -> CGSize? {
        lock.lock()
        let retrying = entries[request.key]?.retryAt != nil
        lock.unlock()
        guard !retrying, let value = sizes.value(sizeKey(request)), value.count >= 2, value[0] > 0, value[1] > 0 else { return nil }
        return CGSize(width: value[0], height: value[1])
    }

    fileprivate static func finish(_ request: MermaidRequest, image: NSImage?, permanentFailure: Bool) {
        let key = request.key
        let imageCost = image.map { $0.cgImage(forProposedRect: nil, context: nil, hints: nil).map { $0.bytesPerRow * $0.height } ?? Int(ceil($0.size.width) * ceil($0.size.height) * 16) } ?? 0
        let retained = imageCost <= costLimit ? image : nil
        if let retained, retained.size.width > 0, retained.size.height > 0 {
            sizes.store(sizeKey(request), [Double(retained.size.width), Double(retained.size.height)])
        }
        let retryAt = retained == nil && !permanentFailure && imageCost <= costLimit ? Date().addingTimeInterval(retryDelay) : nil
        let entry = Entry(image: retained, cost: retained == nil ? 0 : imageCost, retryAt: retryAt)
        lock.lock()
        while !recent.isEmpty && (entries.count >= 48 || cost + entry.cost > costLimit) {
            let oldest = recent.removeFirst()
            cost -= entries.removeValue(forKey: oldest)?.cost ?? 0
        }
        entries[key] = entry
        recent.append(key)
        cost += entry.cost
        requested.remove(key)
        lock.unlock()
        let requestToken = token(request)
        TranscriptResources.ready(requestToken)
        TranscriptResources.ready(capacityToken)
        if retryAt != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay) {
                TranscriptResources.ready(requestToken)
            }
        }
    }
}

/// One local page at a time, off screen, as for KaTeX above. Mermaid readiness is asynchronous;
/// navigation, JS readiness and snapshot capture share a deadline so a bad diagram cannot stall it.
@MainActor
private final class MermaidRenderer: NSObject, WKNavigationDelegate {
    static let shared = MermaidRenderer()
    private var queue: [MermaidRequest] = []
    private var current: MermaidRequest?
    private var navigation: WKNavigation?
    private var initialURL: URL?
    private var generation = 0
    private var timeout: Task<Void, Never>?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var idleRelease: Task<Void, Never>?
    /// How long the web view (a 1600-px surface and its content process) outlives its last diagram.
    private static let idleDelay: Duration = .seconds(60)

    func enqueue(_ request: MermaidRequest) {
        queue.append(request)
        pump()
    }

    private func pump() {
        guard current == nil, !queue.isEmpty else { return }
        let request = queue.removeFirst()
        idleRelease?.cancel()
        idleRelease = nil
        current = request
        generation += 1
        let page = ["html", "htm", "svg"].contains(request.language) ? "content-preview" : "diagram"
        guard let base = AppModel.shared.host.api?.baseUrl,
              var url = URLComponents(string: "\(base)/\(page)") else { finish(nil); return }
        let parameters = [
            URLQueryItem(name: "language", value: request.language),
            URLQueryItem(name: "source", value: request.source),
            URLQueryItem(name: "scheme", value: request.dark ? "dark" : "light"),
            URLQueryItem(name: "fontSize", value: String(Double(14 * request.scale))),
            URLQueryItem(name: "color", value: request.color),
            URLQueryItem(name: "background", value: request.background),
            URLQueryItem(name: "line", value: request.line),
            URLQueryItem(name: "accent", value: request.accent),
        ]
        var fragment = URLComponents()
        fragment.queryItems = parameters
        url.percentEncodedFragment = fragment.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        url.queryItems = [URLQueryItem(name: "n", value: String(generation))]
        if page == "diagram" { url.queryItems?.append(URLQueryItem(name: "engine", value: request.language)) }
        guard let address = url.url else { finish(nil); return }
        let view: WKWebView
        if let existing = webView { view = existing } else {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1600), configuration: configuration)
            view.setValue(false, forKey: "drawsBackground")
            view.navigationDelegate = self
            let host = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1600, height: 1600), styleMask: .borderless, backing: .buffered, defer: false)
            host.isReleasedWhenClosed = false
            host.contentView = view
            host.alphaValue = 0
            host.orderBack(nil)
            window = host
            webView = view
        }
        view.setFrameSize(NSSize(width: 1600, height: 1600))
        let expected = generation
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(12))
            guard !Task.isCancelled, let self, self.generation == expected, self.current != nil else { return }
            self.finish(nil)
        }
        initialURL = address
        navigation = view.load(URLRequest(url: address))
        if navigation == nil { finish(nil) }
    }

    nonisolated func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        Task { @MainActor in
            guard action.targetFrame?.isMainFrame == true, let target = action.request.url,
                  let initialURL = self.initialURL,
                  Self.samePage(target, initialURL) else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }

    nonisolated func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        Task { @MainActor in
            let status = (response.response as? HTTPURLResponse)?.statusCode ?? 0
            guard response.isForMainFrame, let target = response.response.url,
                  let initialURL = self.initialURL,
                  Self.samePage(target, initialURL), (200..<300).contains(status),
                  ["text/html", "application/xhtml+xml"].contains(response.response.mimeType ?? "") else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }

    private static func samePage(_ lhs: URL, _ rhs: URL) -> Bool {
        guard var left = URLComponents(url: lhs, resolvingAgainstBaseURL: false),
              var right = URLComponents(url: rhs, resolvingAgainstBaseURL: false) else { return false }
        left.fragment = nil
        right.fragment = nil
        return left.url == right.url
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let navigation else { return }
        let identity = ObjectIdentifier(navigation)
        Task { @MainActor in
            guard let active = self.navigation, ObjectIdentifier(active) == identity else { return }
            await capture(webView, generation: generation)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(navigation) }
    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(navigation) }

    nonisolated private func failed(_ navigation: WKNavigation?) {
        guard let navigation else { return }
        let identity = ObjectIdentifier(navigation)
        Task { @MainActor in
            guard let active = self.navigation, ObjectIdentifier(active) == identity else { return }
            finish(nil)
        }
    }

    private func capture(_ view: WKWebView, generation expected: Int) async {
        let script = """
        (() => { const state = document.documentElement.getAttribute('data-riffet-mermaid');
          if (state !== 'ready') return state === 'error' ? [-1] : [];
          const element = document.getElementById('diagram');
          if (!element || !element.firstElementChild) return null;
          const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()
        """
        for _ in 0..<100 {
            guard expected == generation, current != nil else { return }
            let result = try? await view.evaluateJavaScript(script) as? [Double]
            // Every suspension checks the generation before touching the shared renderer again.
            guard expected == generation, current != nil else { return }
            guard let bounds = result else { finish(nil); return }
            if bounds.isEmpty {
                try? await Task.sleep(for: .milliseconds(100))
                continue
            }
            if bounds == [-1] { finish(nil, permanentFailure: true); return }
            guard bounds.count == 4, bounds.allSatisfy({ $0.isFinite }), bounds[2] > 0, bounds[3] > 0 else { finish(nil); return }
            guard bounds[2] <= 4096, bounds[3] <= 4096, bounds[2] * bounds[3] <= 2_000_000 else { finish(nil, permanentFailure: true); return }
            let rect = CGRect(x: bounds[0], y: bounds[1], width: ceil(bounds[2]), height: ceil(bounds[3]))
            view.setFrameSize(NSSize(width: max(1600, rect.maxX), height: max(1600, rect.maxY)))
            let configuration = WKSnapshotConfiguration()
            configuration.rect = rect
            configuration.afterScreenUpdates = true
            // A big diagram is drawn with fewer pixels than points so one snapshot stays within half the cache.
            let area = Double(rect.width * rect.height)
            let maxArea = Double(MermaidImages.itemLimit) / 16
            if area > maxArea { configuration.snapshotWidth = NSNumber(value: Double(rect.width) * (maxArea / area).squareRoot()) }
            let image = try? await view.takeSnapshot(configuration: configuration)
            guard expected == generation, current != nil else { return }
            image?.size = rect.size
            finish(image)
            return
        }
        if expected == generation { finish(nil) }
    }

    private func finish(_ image: NSImage?, permanentFailure: Bool = false) {
        guard let request = current else { return }
        timeout?.cancel()
        timeout = nil
        navigation = nil
        initialURL = nil
        current = nil
        // Invalidate any suspended readiness / snapshot callbacks before starting the next job.
        generation += 1
        webView?.stopLoading()
        MermaidImages.finish(request, image: image, permanentFailure: permanentFailure)
        pump()
        if current == nil { scheduleRelease() }
    }

    /// Drops the web view after a quiet minute; the next diagram makes a new one.
    private func scheduleRelease() {
        idleRelease?.cancel()
        idleRelease = Task { [weak self] in
            try? await Task.sleep(for: Self.idleDelay)
            guard !Task.isCancelled, let self, self.current == nil, self.queue.isEmpty else { return }
            self.webView?.navigationDelegate = nil
            self.webView?.stopLoading()
            self.window?.contentView = nil
            self.window?.close()
            self.window = nil
            self.webView = nil
            self.idleRelease = nil
        }
    }
}
