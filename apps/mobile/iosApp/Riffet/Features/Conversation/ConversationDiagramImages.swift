import SwiftUI
import UIKit
import WebKit
import RiffetKit

/// Identity of one diagram or HTML/SVG preview picture. Colours follow the scheme, so they are not
/// part of it; the origin is, so switching servers never shows another server's content.
struct ConversationDiagramRequest: Hashable, Sendable {
    let origin: URL
    let source: String
    let language: String
    let dark: Bool
    /// Width of the page the picture is drawn from, in points.
    let width: Int

    /// The most the transcript preview draws as a picture: diagrams, and the HTML and SVG blocks that
    /// were shown through a web view of their own before.
    static func supports(_ language: String?) -> Bool {
        let value = language?.lowercased() ?? ""
        return ConversationCodePreview.isDiagram(value) || ["html", "htm", "svg"].contains(value)
    }

    var key: String { "\(sizeKey)|\(dark)" }
    /// The size does not depend on the scheme, so a picture drawn in one is reserved room in the other.
    var sizeKey: String { "\(origin.absoluteString)|\(language)|\(width)|\(source.utf8.count)|\(source.hashValue)" }
    /// Where `#diagram` sits in its page (the server's content-preview page pads its body).
    var inset: CGFloat { ["html", "htm", "svg"].contains(language) ? 12 : 0 }
}

/// Pictures of diagrams and previews for the transcript: a block never owns a web view. One shared
/// renderer draws them one at a time, and the lookups below are safe to call from any thread.
enum ConversationDiagramImages {
    /// Diagram pictures share a quarter of the decoded-image budget; one picture holds at most half of that.
    private static let costLimit = CacheRegistry.Budget.images / 4
    fileprivate static let itemLimit = costLimit / 2
    /// Larger than this is not drawn as a picture.
    fileprivate static let sourceLimit = 100_000
    private static let retryDelay: TimeInterval = 10
    private static let sizeLimit = 2_000

    private static let images: NSCache<NSString, UIImage> = CacheRegistry.cache("conversation.diagrams", bytes: costLimit)
    private static let lock = NSLock()
    // perf-rules: allow capped at sizeLimit entries, emptied when full
    nonisolated(unsafe) private static var sizes: [String: CGSize] = [:]
    // perf-rules: allow capped at sizeLimit entries, emptied when full
    nonisolated(unsafe) private static var failures: [String: Date] = [:]

    /// The picture, if it was drawn and is still held.
    static func cachedImage(for request: ConversationDiagramRequest) -> UIImage? {
        images.object(forKey: request.key as NSString)
    }

    /// The size [request]'s source was drawn at before (in this launch), so a row reserves its final
    /// room before the picture lands; nil when it was not.
    static func size(for request: ConversationDiagramRequest) -> CGSize? {
        lock.lock(); defer { lock.unlock() }
        return sizes[request.sizeKey]
    }

    /// The picture for [request], drawing it when needed; nil when it cannot be drawn. A failure is
    /// not tried again for a few seconds unless [retrying].
    static func image(for request: ConversationDiagramRequest, workbench: Workbench, retrying: Bool = false) async -> UIImage? {
        if let image = cachedImage(for: request) { return image }
        guard request.source.utf8.count <= sourceLimit else { return nil }
        if !retrying, recentlyFailed(request) { return nil }
        let image = await ConversationDiagramRenderer.shared.render(request, workbench: workbench)
        store(request, image: image)
        return image
    }

    private static func recentlyFailed(_ request: ConversationDiagramRequest) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let at = failures[request.key] else { return false }
        if Date().timeIntervalSince(at) < retryDelay { return true }
        failures.removeValue(forKey: request.key)
        return false
    }

    private static func store(_ request: ConversationDiagramRequest, image: UIImage?) {
        lock.lock(); defer { lock.unlock() }
        guard let image else {
            if failures.count >= sizeLimit { failures.removeAll() }
            failures[request.key] = Date(); return
        }
        failures.removeValue(forKey: request.key)
        if sizes.count >= sizeLimit { sizes.removeAll() }
        sizes[request.sizeKey] = image.size
        images.setObject(image, forKey: request.key as NSString, cost: cost(image))
    }

    fileprivate static func cost(_ image: UIImage) -> Int {
        image.cgImage.map { $0.bytesPerRow * $0.height } ?? Int(image.size.width * image.size.height * image.scale * image.scale * 4)
    }
}

/// One off-screen page at a time, as for formulas. The server's page is fetched with the workbench's
/// credentials and shown through `ConversationPreviewDocument` (an opaque-origin sandbox and the page's
/// own CSP), never loaded by URL; the page reports its size to the host document, which forwards the
/// numbers to native code. The picture is a PDF of that rectangle, which needs no visible window.
@MainActor
final class ConversationDiagramRenderer: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    static let shared = ConversationDiagramRenderer()
    private static let handlerName = "riffetDiagram"
    private static let timeout: Duration = .seconds(20)
    /// How long the web view (and its content process) outlives the last picture.
    private static let idleDelay: Duration = .seconds(60)

    private var waiting: [ConversationDiagramRequest: [UUID: CheckedContinuation<UIImage?, Never>]] = [:]
    private var queue: [(request: ConversationDiagramRequest, workbench: Workbench)] = []
    private var current: ConversationDiagramRequest?
    private var generation = 0
    private var web: WKWebView?
    private var load: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var idleRelease: Task<Void, Never>?

    func render(_ request: ConversationDiagramRequest, workbench: Workbench) async -> UIImage? {
        guard !Task.isCancelled else { return nil }
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let exists = waiting[request] != nil
                waiting[request, default: [:]][id] = continuation
                if !exists { queue.append((request, workbench)) }
                pump()
            }
        } onCancel: {
            Task { @MainActor in self.cancel(request, id: id) }
        }
    }

    /// A row that left or changed its source stops waiting; a picture nobody waits for is not drawn.
    private func cancel(_ request: ConversationDiagramRequest, id: UUID) {
        guard let continuation = waiting[request]?.removeValue(forKey: id) else { return }
        continuation.resume(returning: nil)
        guard waiting[request]?.isEmpty == true else { return }
        waiting.removeValue(forKey: request)
        if current == request { finish(nil) } else { queue.removeAll { $0.request == request } }
    }

    private func pump() {
        guard current == nil, !queue.isEmpty else { return }
        let (request, workbench) = queue.removeFirst()
        idleRelease?.cancel(); idleRelease = nil
        current = request
        generation += 1
        let token = generation
        deadline = Task { [weak self] in
            try? await Task.sleep(for: Self.timeout)
            guard !Task.isCancelled, let self, self.generation == token, self.current != nil else { return }
            self.finish(nil)
        }
        load = Task { [weak self] in
            guard let url = ConversationCodePreview.url(base: request.origin, source: request.source, language: request.language, dark: request.dark),
                  let data = try? await workbench.resources.data(for: url) else { self?.fail(token); return }
            let document = await Task.detached(priority: .userInitiated) { () -> String? in
                guard let text = String(data: data, encoding: .utf8) else { return nil }
                return Self.document(ConversationPreviewDocument.html(source: text, url: url), generation: token)
            }.value
            guard !Task.isCancelled, let self, self.generation == token, self.current != nil else { return }
            guard let document else { self.finish(nil); return }
            let view = self.ensureWebView()
            view.frame = CGRect(x: 0, y: 0, width: request.width, height: 1_024)
            view.loadHTMLString(document, baseURL: nil)
        }
    }

    private func fail(_ token: Int) {
        guard generation == token, current != nil else { return }
        finish(nil)
    }

    /// Adds the bridge to the host document of the sandbox: the page posts its size to its parent. The
    /// message is read as four numbers; nothing from the page is ever evaluated or interpolated.
    nonisolated private static func document(_ html: String, generation: Int) -> String {
        let bridge = "<script>addEventListener('message',function(e){var d=e.data,f=document.querySelector('iframe');if(!f||e.source!==f.contentWindow||!d||d.type!=='riffet-mermaid')return;webkit.messageHandlers.\(handlerName).postMessage([\(generation),d.status==='ready'?1:0,Number(d.width)||0,Number(d.height)||0]);});</script>"
        guard let head = html.range(of: "</head>") else { return html }
        return html.replacingCharacters(in: head, with: bridge + "</head>")
    }

    private func ensureWebView() -> WKWebView {
        if let web { return web }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(WeakHandler(self), name: Self.handlerName)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false; view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.navigationDelegate = self
        web = view
        return view
    }

    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: ConversationDiagramRenderer?
        init(_ target: ConversationDiagramRenderer) { self.target = target }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            target?.userContentController(controller, didReceive: message)
        }
    }

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the host document speaks for the page; the sandboxed frame has the handler too.
        guard message.frameInfo.isMainFrame, let values = message.body as? [Double], values.count == 4 else { return }
        Task { @MainActor in self.received(values) }
    }

    private func received(_ values: [Double]) {
        guard let request = current, Int(values[0]) == generation, let view = web else { return }
        guard values[1] == 1 else { finish(nil); return }
        let width = values[2], height = values[3]
        // The server page's own limits (2 000 000 px) apply; a picture is bounded by the cache budget below.
        guard width.isFinite, height.isFinite, width > 0, height > 0, width <= 4_096, height <= 4_096, width * height <= 2_000_000 else { finish(nil); return }
        let token = generation
        let inset = request.inset
        let rect = CGRect(x: inset, y: inset, width: ceil(width), height: ceil(height))
        view.frame = CGRect(x: 0, y: 0, width: CGFloat(request.width), height: max(1, rect.maxY + inset))
        let configuration = WKPDFConfiguration()
        configuration.rect = rect
        configuration.allowTransparentBackground = true
        Task { [weak self, weak view] in
            guard let view else { return }
            let pdf = try? await view.pdf(configuration: configuration)
            guard let self, self.generation == token, self.current != nil else { return }
            guard let pdf else { self.finish(nil); return }
            let scale = view.traitCollection.displayScale
            let image = await Task.detached(priority: .userInitiated) { Self.image(pdf, scale: scale) }.value
            guard self.generation == token, self.current != nil else { return }
            self.finish(image)
        }
    }

    /// Rasterizes the cropped PDF at the display scale, or less when the picture would exceed its share
    /// of the cache.
    nonisolated private static func image(_ data: Data, scale: CGFloat) -> UIImage? {
        guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider), let page = document.page(at: 1) else { return nil }
        let box = page.getBoxRect(.mediaBox)
        guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0 else { return nil }
        let size = CGSize(width: ceil(box.width), height: ceil(box.height))
        let fit = (Double(ConversationDiagramImages.itemLimit) / (4 * Double(size.width * size.height))).squareRoot()
        let format = UIGraphicsImageRendererFormat()
        format.opaque = false
        format.scale = max(0.5, min(scale, CGFloat(fit)))
        let image = UIGraphicsImageRenderer(size: size, format: format).image { renderer in
            let context = renderer.cgContext
            context.translateBy(x: 0, y: size.height); context.scaleBy(x: 1, y: -1)
            context.concatenate(page.getDrawingTransform(.mediaBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true))
            context.drawPDFPage(page)
        }
        return ConversationDiagramImages.cost(image) <= ConversationDiagramImages.itemLimit ? image : nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The same policy as `RestrictedResourcePage`: only the trusted host and its sandbox frame.
        decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    private func navigationFailed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled, current != nil else { return }
        finish(nil)
    }

    private func finish(_ image: UIImage?) {
        guard let request = current else { return }
        deadline?.cancel(); deadline = nil
        load?.cancel(); load = nil
        current = nil
        // Late messages and suspended snapshots of this job are ignored from here on.
        generation += 1
        web?.stopLoading()
        let callbacks = waiting.removeValue(forKey: request) ?? [:]
        for callback in callbacks.values { callback.resume(returning: image) }
        pump()
        if current == nil { scheduleRelease() }
    }

    private func scheduleRelease() {
        idleRelease?.cancel()
        idleRelease = Task { [weak self] in
            try? await Task.sleep(for: Self.idleDelay)
            guard !Task.isCancelled, let self, self.current == nil, self.queue.isEmpty, let view = self.web else { return }
            view.navigationDelegate = nil
            view.stopLoading()
            view.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
            self.web = nil
            self.idleRelease = nil
        }
    }
}
