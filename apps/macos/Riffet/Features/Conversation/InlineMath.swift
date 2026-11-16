import AppKit
import WebKit
import RiffetKit

/// One formula as the transcript asks for it: its TeX, the theme and appearance that colour it, and
/// whether it is a block (`$$…$$`) or inline formula.
struct MathRequest: Hashable, Sendable {
    let tex: String
    let theme: String
    let dark: Bool
    let display: Bool
    /// The reader's text scale; the snapshot is sized to it.
    let scale: CGFloat
    /// The text colour, as `#rrggbb`.
    let color: String

    /// `color` is part of the identity: a custom theme keeps its id when edited, and the snapshot is
    /// painted in that colour.
    var key: String { "\(display ? "D" : "I")|\(theme)|\(dark ? 1 : 0)|\(scale)|\(color)|\(tex)" }
}

/// Rendered formulas, readable from the layout queue. A miss queues the formula on the renderer;
/// when it lands, `TranscriptResources` names its key and rows that waited for it lay out again.
enum MathImages {
    struct Rendered: @unchecked Sendable {
        let image: NSImage
        /// Distance from the image's bottom to the text baseline, in points.
        let descent: CGFloat
    }

    private static let lock = NSLock()
    private final class Box { let rendered: Rendered; init(_ rendered: Rendered) { self.rendered = rendered } }

    /// Snapshots are small; a quarter of the decoded-image budget holds thousands of formulas.
    private static let imageLimit = Int(BudgetsKt.IMAGE_CACHE_MAC_DECODED_BYTES) / 4
    /// The last few renders, held strongly: a formula too big for the cache, or a share export that
    /// reads back what it just waited for, still finds its image.
    private static let recentLimit = 32
    nonisolated(unsafe) private static var recent: [(key: String, rendered: Rendered)] = []
    private static let failedLimit = 2_000
    private static let images: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.totalCostLimit = imageLimit
        CacheRegistry.shared.register("math.images", limit: Int64(imageLimit)) {
            cache.removeAllObjects()
            lock.withLock { recent.removeAll() }
        }
        return cache
    }()
    nonisolated(unsafe) private static var failed: Set<String> = []
    nonisolated(unsafe) private static var requested: Set<String> = []

    /// The image for [request], or nil while it renders (or when it cannot be rendered).
    static func image(_ request: MathRequest) -> Rendered? {
        let key = request.key
        if let hit = images.object(forKey: key as NSString) { return hit.rendered }
        lock.lock()
        if let hit = images.object(forKey: key as NSString) { lock.unlock(); return hit.rendered }
        if let held = recent.first(where: { $0.key == key }) { lock.unlock(); return held.rendered }
        let start = !failed.contains(key) && requested.insert(key).inserted
        lock.unlock()
        if start {
            DispatchQueue.main.async { MainActor.assumeIsolated { InlineMathRenderer.shared.enqueue(request) } }
        }
        return nil
    }

    static func token(_ request: MathRequest) -> String { "math:\(request.key)" }

    /// [request] could not be rendered: its TeX shows instead.
    static func isFailed(_ request: MathRequest) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return failed.contains(request.key)
    }

    /// Sizes of formulas rendered before, at text size 1 (a snapshot scales with the text size, and
    /// colours do not change it), in this launch or an earlier one.
    private static let sizes = SizeMemory(name: "formula-sizes", limit: 6000)

    private static func sizeKey(_ request: MathRequest) -> String { "\(request.display ? "D" : "I")|\(stableHash(request.tex))" }

    /// The size and descent [request]'s snapshot will have, when the formula was rendered before:
    /// the room a layout holds for it while it renders.
    static func size(_ request: MathRequest) -> (size: CGSize, descent: CGFloat)? {
        guard request.scale > 0, let value = sizes.value(sizeKey(request)), value.count >= 3, value[0] > 0, value[1] > 0 else { return nil }
        let scale = Double(request.scale)
        return (CGSize(width: value[0] * scale, height: value[1] * scale), CGFloat(value[2] * scale))
    }

    /// Records the outcome and tells the rows that waited for it, rendered or not.
    fileprivate static func finish(_ request: MathRequest, _ rendered: Rendered?) {
        let key = request.key
        lock.lock()
        if let rendered {
            let image = rendered.image
            images.setObject(Box(rendered), forKey: key as NSString, cost: min(imageLimit / 2, max(1, Int(image.size.width * image.size.height * 16))))
            recent.removeAll { $0.key == key }
            recent.append((key, rendered))
            if recent.count > recentLimit { recent.removeFirst() }
        } else {
            if failed.count >= failedLimit { failed.removeAll() }
            failed.insert(key)
        }
        requested.remove(key)
        lock.unlock()
        if let rendered, request.scale > 0 {
            let scale = Double(request.scale)
            sizes.store(sizeKey(request), [Double(rendered.image.size.width) / scale, Double(rendered.image.size.height) / scale, Double(rendered.descent) / scale])
        }
        TranscriptResources.ready(token(request))
    }
}

/// Renders formulas with the server's KaTeX page (docs/MOBILE.md, "数学公式") in one off-screen web
/// view, one at a time, and keeps the snapshots. The formula travels in the URL fragment, so it never
/// reaches the server's request log.
@MainActor
final class InlineMathRenderer: NSObject, WKNavigationDelegate {
    static let shared = InlineMathRenderer()

    private var queue: [(request: MathRequest, url: URL)] = []
    private var current: MathRequest?
    private var currentURL: URL?
    /// Formulas whose page already timed out once; a second timeout shows their TeX.
    private var retried: Set<String> = []
    /// The navigation of the formula being rendered; callbacks for any other one are ignored.
    private var navigation: WKNavigation?
    private var generation = 0
    /// A page that never finishes gives up after a while, so the formulas behind it still render
    /// and the one that hung shows its TeX rather than its room.
    private var timeout: Task<Void, Never>?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var idleRelease: Task<Void, Never>?
    /// How long the web view (and its content process) outlives its last formula.
    private static let idleDelay: Duration = .seconds(60)

    /// The math page lays body text out at 15px; formulas are scaled to the transcript's size.
    private static let pageFontSize: CGFloat = 15

    func enqueue(_ request: MathRequest) {
        guard let base = AppModel.shared.host.api?.baseUrl else {
            MathImages.finish(request, nil)
            return
        }
        let encoded = request.tex.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? request.tex
        let color = request.color.replacingOccurrences(of: "#", with: "%23")
        guard let url = URL(string: "\(base)/math#tex=\(encoded)&d=\(request.display ? 1 : 0)&c=\(color)&s=\(request.dark ? "dark" : "light")") else {
            MathImages.finish(request, nil)
            return
        }
        queue.append((request, url))
        pump()
    }

    private func pump() {
        guard current == nil, !queue.isEmpty else { return }
        let next = queue.removeFirst()
        idleRelease?.cancel()
        idleRelease = nil
        current = next.request
        currentURL = next.url
        generation += 1
        // A different fragment on the same page does not reload it, so each formula gets a query too:
        // a fresh document that reads its formula once.
        var components = URLComponents(url: next.url, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "n", value: String(generation))]
        let expected = generation
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled, let self, self.generation == expected, self.current != nil else { return }
            self.timedOut()
        }
        navigation = ensureWebView().load(URLRequest(url: components?.url ?? next.url))
    }

    private func ensureWebView() -> WKWebView {
        if let webView { return webView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 400), configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = self
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1200, height: 400), styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.alphaValue = 0
        window.orderBack(nil)
        self.window = window
        webView = view
        return view
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let finished = ObjectIdentifier(navigation)
        Task { @MainActor in
            guard let current = self.navigation, ObjectIdentifier(current) == finished, self.current != nil else { return }
            let generation = self.generation
            // KaTeX's fonts arrive after load and change the metrics.
            try? await Task.sleep(for: .milliseconds(180))
            guard generation == self.generation else { return }
            await capture(webView, generation: generation)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(navigation, error)
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(navigation, error)
    }

    nonisolated private func failed(_ navigation: WKNavigation, _ error: Error) {
        let failed = ObjectIdentifier(navigation)
        let cancelled = (error as NSError).code == NSURLErrorCancelled
        Task { @MainActor in
            guard !cancelled, let current = self.navigation, ObjectIdentifier(current) == failed else { return }
            finish(nil)
        }
    }

    private func capture(_ webView: WKWebView, generation: Int) async {
        let script = """
        (function(){var f=document.getElementById('formula');var r=f.getBoundingClientRect();
        var b=document.createElement('span');b.style.display='inline-block';b.style.height='0';f.parentNode.appendChild(b);
        var base=b.getBoundingClientRect().top;b.remove();
        return [r.x,r.y,r.width,r.height,base];})()
        """
        guard let value = try? await webView.evaluateJavaScript(script) as? [Double], value.count == 5,
              value[2] > 0, value[3] > 0, generation == self.generation else {
            if generation == self.generation { finish(nil) }
            return
        }
        let rect = CGRect(x: value[0], y: value[1], width: ceil(value[2]), height: ceil(value[3]))
        let configuration = WKSnapshotConfiguration()
        configuration.rect = rect
        configuration.afterScreenUpdates = true
        guard let image = try? await webView.takeSnapshot(configuration: configuration), generation == self.generation, let current else {
            if generation == self.generation { finish(nil) }
            return
        }
        let scale = (current.display ? 15 : 14.5) * current.scale / Self.pageFontSize
        image.size = NSSize(width: rect.width * scale, height: rect.height * scale)
        let descent = current.display ? 0 : max(0, (rect.maxY - value[4])) * scale
        finish(MathImages.Rendered(image: image, descent: descent))
    }

    /// The page did not finish in time, which a cold web content process can cause for the first
    /// formulas: each gets one more try behind the rest of the queue before its TeX shows.
    private func timedOut() {
        guard let current, let currentURL, retried.insert(current.key).inserted else {
            finish(nil)
            return
        }
        timeout?.cancel()
        timeout = nil
        self.current = nil
        self.currentURL = nil
        navigation = nil
        queue.append((current, currentURL))
        pump()
    }

    private func finish(_ rendered: MathImages.Rendered?) {
        timeout?.cancel()
        timeout = nil
        if let current { MathImages.finish(current, rendered) }
        current = nil
        currentURL = nil
        navigation = nil
        pump()
        if current == nil { scheduleRelease() }
    }

    /// Drops the web view after a quiet minute; the next formula makes a new one.
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
