import AppKit
import QuartzCore
import SwiftUI

/// The in-app image viewer: opens at once on the image the row already drew, then swaps in the full
/// resolution. Pinch or ⌘-scroll to zoom, double-click for fit / 1:1, esc or a click outside to close.
@MainActor
@Observable
final class ImageViewer {
    static let shared = ImageViewer()

    struct Item {
        let id = UUID()
        var image: NSImage
        let source: TimelineImageSource
        let projectId: String?
        let label: String
        let origin: Origin?
        weak var window: NSWindow?

        @MainActor
        init(image: NSImage, source: TimelineImageSource, projectId: String?, label: String, origin: Origin? = nil) {
            self.image = image
            self.source = source
            self.projectId = projectId
            self.label = label
            self.origin = origin
            window = origin?.view?.window ?? NSApp.keyWindow
        }
    }

    private(set) var item: Item?
    private(set) var closing = false

    func show(image: NSImage, source: TimelineImageSource, projectId: String?, label: String, origin: Origin? = nil) {
        show(Item(image: image, source: source, projectId: projectId, label: label, origin: origin))
    }

    func show(_ item: Item) {
        self.item?.origin?.restore()
        closing = false
        self.item = item
        Task {
            guard let full = await ImageLoader.shared.original(for: item.source, projectId: item.projectId), self.item?.id == item.id else { return }
            self.item?.image = full
        }
    }

    func close() { if item != nil { closing = true } }

    func finishClose(_ id: UUID) {
        guard item?.id == id else { return }
        item?.origin?.restore()
        item = nil
        closing = false
    }

    /// A thumbnail's live location, weakly held so recycled or removed rows cannot become a close
    /// target. The same geometry bridge is used by native transcript rows and SwiftUI previews.
    @MainActor
    final class Origin {
        weak var view: NSView?
        private weak var window: NSWindow?
        private let initialFrame: CGRect
        private let initialVisible: CGRect
        let cropped: Bool
        private let isCurrent: () -> Bool
        private let visibility: ((Bool) -> Void)?
        private var hidden = false

        init(view: NSView, cropped: Bool = false, isCurrent: @escaping () -> Bool = { true }, visibility: ((Bool) -> Void)? = nil) {
            self.view = view
            window = view.window
            initialFrame = view.convert(view.bounds, to: nil)
            initialVisible = view.convert(view.visibleRect.intersection(view.bounds), to: nil)
            self.cropped = cropped
            self.isCurrent = isCurrent
            self.visibility = visibility
        }

        func geometry(in container: NSView, initial: Bool = false) -> (frame: CGRect, visible: CGRect)? {
            guard isCurrent(), let view, let window, view.window === window, window === container.window,
                  !view.isHiddenOrHasHiddenAncestor, !view.visibleRect.isEmpty else { return nil }
            let frame = initial ? container.convert(initialFrame, from: nil) : container.convert(view.bounds, from: view)
            let visible = (initial ? container.convert(initialVisible, from: nil) : container.convert(view.visibleRect.intersection(view.bounds), from: view)).intersection(container.bounds)
            guard frame.width > 0, frame.height > 0, !visible.isEmpty else { return nil }
            return (frame, visible)
        }

        func hide() {
            guard !hidden, isCurrent() else { return }
            hidden = true
            updateVisibility()
        }

        func restore() {
            guard hidden else { return }
            hidden = false
            updateVisibility()
        }

        private func updateVisibility() {
            if let visibility {
                let visible = !hidden
                // An origin can be hidden from updateNSView/layout; publish SwiftUI state only
                // after that update, and discard a hide that was already reversed by Escape.
                DispatchQueue.main.async { [weak self] in
                    guard self?.hidden == !visible else { return }
                    visibility(visible)
                }
            } else {
                view?.alphaValue = hidden ? 0 : 1
            }
        }
    }

    @MainActor
    @Observable
    final class Anchor {
        @ObservationIgnored weak var view: NSView?
        weak var window: NSWindow?

        func origin(cropped: Bool = false, visibility: ((Bool) -> Void)? = nil) -> Origin? {
            guard let view, view.window != nil else { return nil }
            return Origin(view: view, cropped: cropped, isCurrent: { [weak self, weak view] in
                view != nil && self?.view === view
            }, visibility: visibility)
        }
    }
}

struct ImageViewerAnchorView: NSViewRepresentable {
    let anchor: ImageViewer.Anchor

    func makeNSView(context: Context) -> View {
        let view = View()
        view.anchor = anchor
        anchor.view = view
        return view
    }

    func updateNSView(_ view: View, context: Context) { anchor.view = view }

    final class View: NSView {
        weak var anchor: ImageViewer.Anchor?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let window = window
            DispatchQueue.main.async { [weak self, weak window] in
                guard let self, self.anchor?.view === self else { return }
                self.anchor?.window = window
            }
        }
    }
}

struct ImageViewerOverlay: View {
    @State private var notice: String?
    @State private var anchor = ImageViewer.Anchor()

    var body: some View {
        let viewer = ImageViewer.shared
        ZStack {
            if let item = viewer.item, let window = anchor.window, item.window === window {
                ZoomableImage(item: item, closing: viewer.closing, close: { viewer.close() }, didClose: { viewer.finishClose(item.id) })
                    .id(item.id)
                    .ignoresSafeArea()
                VStack {
                    HStack(spacing: Space.sm) {
                        Spacer()
                        viewerButton("doc.on.doc", help: String(localized: "复制图片")) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.writeObjects([item.image])
                        }
                        viewerButton("square.and.arrow.down", help: String(localized: "存储…")) { Task { await save(item) } }
                        viewerButton("arrow.up.forward.app", help: String(localized: "用预览打开")) {
                            Task {
                                if let url = await ImageLoader.shared.file(for: item.source, projectId: item.projectId, name: item.label) {
                                    NSWorkspace.shared.open(url)
                                }
                            }
                        }
                        viewerButton("xmark", help: String(localized: "关闭 (esc)")) { viewer.close() }
                            .keyboardShortcut(.cancelAction)
                    }
                    .padding(.horizontal, Space.lg)
                    .padding(.top, Space.md)
                    Spacer()
                    // No caption: an attachment's name is a temporary path or "image.png". Only what a
                    // save reports shows, centred, and only once there is something to say.
                    if let notice {
                        Text(notice).font(.riffet(size: S(12))).foregroundStyle(.white.opacity(0.9)).lineLimit(1)
                            .padding(.horizontal, Space.md)
                            .padding(.vertical, Space.xs + 2)
                            .background(.white.opacity(0.12), in: Capsule())
                            .padding(.bottom, Space.lg)
                            .transition(.opacity)
                    }
                }
                .opacity(viewer.closing ? 0 : 1)
                .animation(Motion.fast, value: viewer.closing)
                .transition(.opacity)
                .onChange(of: item.id, initial: true) { _, _ in notice = nil }
                .onDisappear { viewer.finishClose(item.id) }
            }
        }
        .background(ImageViewerAnchorView(anchor: anchor).allowsHitTesting(false))
    }

    private func viewerButton(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(icon: symbol)
                .font(.riffet(size: S(13), weight: .medium))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(.white.opacity(0.12), in: Circle())
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private func save(_ item: ImageViewer.Item) async {
        guard let file = await ImageLoader.shared.file(for: item.source, projectId: item.projectId, name: item.label) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = file.lastPathComponent
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            try await Task.detached(priority: .userInitiated) {
                try Data(contentsOf: file, options: .mappedIfSafe).write(to: destination, options: .atomic)
            }.value
            if ImageViewer.shared.item?.id == item.id { notice = nil }
        } catch {
            if ImageViewer.shared.item?.id == item.id { notice = error.localizedDescription }
        }
    }
}

/// An `NSScrollView` magnifying an image view: the system's own pinch, smart zoom and inertia.
private struct ZoomableImage: NSViewRepresentable {
    let item: ImageViewer.Item
    let closing: Bool
    let close: () -> Void
    let didClose: () -> Void

    func makeNSView(context: Context) -> Canvas {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.allowsMagnification = true
        scroll.minMagnification = 0.05
        scroll.maxMagnification = 8
        let clip = CenteringClipView()
        clip.onBackgroundClick = close
        // A fresh clip view paints its own background; `scroll.drawsBackground` only reached the old one.
        clip.drawsBackground = false
        scroll.contentView = clip
        let imageView = DoubleClickImageView()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.wantsLayer = true
        imageView.layer?.masksToBounds = true
        imageView.layer?.cornerCurve = .continuous
        imageView.onDoubleClick = { [weak scroll] point in
            guard let scroll else { return }
            context.coordinator.toggleZoom(scroll, at: point)
        }
        scroll.documentView = imageView
        context.coordinator.imageView = imageView
        context.coordinator.observe(scroll)
        let canvas = Canvas(scroll: scroll, imageView: imageView)
        canvas.fit = { [coordinator = context.coordinator] in coordinator.fit(scroll) }
        return canvas
    }

    func updateNSView(_ canvas: Canvas, context: Context) {
        let scroll = canvas.scroll
        guard let imageView = context.coordinator.imageView else { return }
        let first = imageView.image == nil
        let size = imageView.image?.size
        imageView.image = item.image
        // A sharper copy of the same picture replaces the first one without moving it.
        if first || size == nil {
            imageView.frame = NSRect(origin: .zero, size: item.image.size)
        } else if let size, size != item.image.size {
            let magnification = scroll.magnification
            imageView.frame = NSRect(origin: .zero, size: item.image.size)
            scroll.magnification = magnification * size.width / max(item.image.size.width, 1)
        }
        canvas.configure(item: item, closing: closing, close: close, didClose: didClose)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    static func dismantleNSView(_ canvas: Canvas, coordinator: Coordinator) { canvas.cancel() }

    /// Only the image's native layers animate. The transcript and its layout remain still while
    /// a clipped copy travels from the thumbnail to the fitted image (and back from a live zoom).
    final class Canvas: NSView {
        let scroll: NSScrollView
        private let imageView: NSImageView
        private let dimming = Background()
        private let picture = Clip()
        private let pixels = NSView()
        private var item: ImageViewer.Item?
        private enum Phase { case waiting, opening, open, closing }
        private var phase = Phase.waiting
        private var generation = 0
        private var closing = false
        private var didClose: (() -> Void)?
        private var lastSize = CGSize.zero
        var fit: (() -> Void)?

        override var isFlipped: Bool { true }

        init(scroll: NSScrollView, imageView: NSImageView) {
            self.scroll = scroll
            self.imageView = imageView
            super.init(frame: .zero)
            wantsLayer = true
            dimming.wantsLayer = true
            dimming.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.62).cgColor
            picture.wantsLayer = true
            picture.layer?.masksToBounds = true
            picture.layer?.cornerCurve = .continuous
            pixels.wantsLayer = true
            picture.addSubview(pixels)
            addSubview(dimming)
            addSubview(scroll)
            addSubview(picture)
            scroll.isHidden = true
            picture.isHidden = true
            dimming.alphaValue = 0
        }

        required init?(coder: NSCoder) { fatalError() }

        func configure(item: ImageViewer.Item, closing: Bool, close: @escaping () -> Void, didClose: @escaping () -> Void) {
            self.item = item
            self.closing = closing
            self.didClose = didClose
            dimming.close = close
            needsLayout = true
            if closing, phase != .waiting, phase != .closing { dismiss() }
        }

        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); needsLayout = true }

        override func layout() {
            super.layout()
            dimming.frame = bounds
            scroll.frame = NSRect(x: 48, y: 56, width: max(1, bounds.width - 96), height: max(1, bounds.height - 128))
            guard window != nil, bounds.width > 0, bounds.height > 0, item != nil else { return }
            if lastSize != bounds.size {
                lastSize = bounds.size
                scroll.layoutSubtreeIfNeeded()
                fit?()
                scroll.layoutSubtreeIfNeeded()
            }
            if phase == .waiting {
                if closing { didClose?() } else { present() }
            }
        }

        private var fittedFrame: CGRect {
            let size = imageView.frame.size
            let area = scroll.frame
            let scale = min(1, min(area.width / max(size.width, 1), area.height / max(size.height, 1)))
            let fitted = CGSize(width: size.width * scale, height: size.height * scale)
            return CGRect(x: area.midX - fitted.width / 2, y: area.midY - fitted.height / 2, width: fitted.width, height: fitted.height)
        }

        private func place(frame: CGRect, visible: CGRect) {
            picture.frame = visible
            pixels.frame = frame.offsetBy(dx: -visible.minX, dy: -visible.minY)
        }

        private func present() {
            guard let item else { return }
            phase = .opening
            picture.isHidden = false
            pixels.layer?.contents = item.image
            pixels.layer?.contentsGravity = item.origin?.cropped == true ? .resizeAspectFill : .resizeAspect
            let source = item.origin?.geometry(in: self, initial: true)
            let moves = source != nil && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            if moves, let source {
                place(frame: source.frame, visible: source.visible)
                picture.layer?.cornerRadius = 8
            } else {
                place(frame: fittedFrame, visible: fittedFrame)
                picture.layer?.cornerRadius = 12
                picture.alphaValue = 0
            }
            // Keep the thumbnail hidden until the viewer closes, including a reduced-motion fade.
            item.origin?.hide()
            if moves { roundCorners(to: 12, duration: 0.28) }
            animate(duration: moves ? 0.28 : 0.14, changes: {
                self.placeAnimated(frame: self.fittedFrame, visible: self.fittedFrame)
                self.picture.animator().alphaValue = 1
                self.dimming.animator().alphaValue = 1
            }, completion: {
                self.phase = .open
                self.scroll.isHidden = false
                self.picture.isHidden = true
            })
        }

        private func dismiss() {
            guard let item else { return }
            if phase == .opening {
                // Escape can arrive before opening finishes. Resume from the rendered frame,
                // and invalidate that animation's completion before starting the reverse trip.
                freeze(picture)
                freeze(pixels)
                freeze(dimming)
            } else {
                let frame = convert(imageView.bounds, from: imageView)
                place(frame: frame, visible: frame.intersection(scroll.frame))
                pixels.layer?.contents = item.image
                picture.alphaValue = 1
            }
            phase = .closing
            picture.isHidden = false
            scroll.isHidden = true
            pixels.layer?.contentsGravity = item.origin?.cropped == true ? .resizeAspectFill : .resizeAspect
            // The hidden copy still has its previous fitted presentation layer. Commit the live
            // zoom/crop geometry before AppKit chooses the reverse animation's starting frame.
            CATransaction.flush()
            let target = item.origin?.geometry(in: self)
            let moves = target != nil && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            let exitTiming = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
            if moves {
                item.origin?.hide()
                roundCorners(to: 8, duration: 0.20, timing: exitTiming)
            }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.14
                context.timingFunction = exitTiming
                context.allowsImplicitAnimation = true
                self.dimming.animator().alphaValue = 0
            }
            animate(duration: moves ? 0.20 : 0.14, timing: exitTiming, changes: {
                if moves, let target { self.placeAnimated(frame: target.frame, visible: target.visible) }
                else { self.picture.animator().alphaValue = 0 }
            }, completion: {
                item.origin?.restore()
                self.didClose?()
            })
        }

        private func placeAnimated(frame: CGRect, visible: CGRect) {
            picture.animator().frame = visible
            pixels.animator().frame = frame.offsetBy(dx: -visible.minX, dy: -visible.minY)
        }

        private func roundCorners(to radius: CGFloat, duration: TimeInterval, timing: CAMediaTimingFunction = CAMediaTimingFunction(name: .easeInEaseOut)) {
            guard let layer = picture.layer else { return }
            let animation = CABasicAnimation(keyPath: "cornerRadius")
            animation.fromValue = layer.presentation()?.cornerRadius ?? layer.cornerRadius
            animation.toValue = radius
            animation.duration = duration
            animation.timingFunction = timing
            layer.cornerRadius = radius
            layer.add(animation, forKey: "cornerRadius")
        }

        private func freeze(_ view: NSView) {
            guard let layer = view.layer, let current = layer.presentation() else { return }
            let frame = current.frame
            let opacity = current.opacity
            layer.removeAllAnimations()
            view.frame = frame
            view.alphaValue = CGFloat(opacity)
        }

        private func animate(duration: TimeInterval, timing: CAMediaTimingFunction = CAMediaTimingFunction(name: .easeInEaseOut), changes: @escaping () -> Void, completion: @escaping () -> Void) {
            generation += 1
            let current = generation
            NSAnimationContext.runAnimationGroup { context in
                context.duration = duration
                context.timingFunction = timing
                context.allowsImplicitAnimation = true
                changes()
            } completionHandler: { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.generation == current else { return }
                    completion()
                }
            }
        }

        func cancel() {
            generation += 1
            item?.origin?.restore()
        }

        private final class Background: NSView {
            var close: (() -> Void)?
            override func mouseUp(with event: NSEvent) { close?() }
        }

        private final class Clip: NSView {
            override var isFlipped: Bool { true }
        }
    }

    @MainActor
    final class Coordinator {
        weak var imageView: NSImageView?
        private var fitted: CGFloat = 1
        nonisolated(unsafe) private var observer: NSObjectProtocol?
        /// On screen; the layer sits inside the magnification, so its radius is divided by it.
        private let cornerRadius: CGFloat = 12

        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

        func observe(_ scroll: NSScrollView) {
            scroll.contentView.postsBoundsChangedNotifications = true
            observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self, weak scroll] _ in
                MainActor.assumeIsolated {
                    guard let self, let scroll else { return }
                    self.roundCorners(scroll)
                }
            }
        }

        private func roundCorners(_ scroll: NSScrollView) {
            imageView?.layer?.cornerRadius = cornerRadius / max(scroll.magnification, 0.01)
        }

        func fit(_ scroll: NSScrollView) {
            guard let size = imageView?.frame.size, size.width > 0, size.height > 0 else { return }
            let bounds = scroll.bounds.size
            fitted = min(1, min(bounds.width / size.width, bounds.height / size.height))
            scroll.minMagnification = min(0.05, fitted)
            scroll.magnification = fitted
            roundCorners(scroll)
        }

        func toggleZoom(_ scroll: NSScrollView, at point: NSPoint) {
            let actual = (imageView?.window?.backingScaleFactor ?? 2) >= 2 ? 1.0 : 1.0
            if abs(scroll.magnification - fitted) < 0.01, fitted < actual {
                scroll.animator().setMagnification(actual, centeredAt: point)
            } else {
                scroll.animator().magnification = fitted
            }
        }
    }
}

/// Keeps a smaller-than-viewport document in the middle instead of the bottom-left corner. A click
/// on the empty space around the image closes the viewer, like a click on the dimming.
private final class CenteringClipView: NSClipView {
    var onBackgroundClick: (() -> Void)?
    private var down: NSPoint?

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let document = documentView, !document.frame.contains(point) { down = point } else { super.mouseDown(with: event) }
    }

    override func mouseUp(with event: NSEvent) {
        defer { down = nil }
        guard let down else { return super.mouseUp(with: event) }
        let point = convert(event.locationInWindow, from: nil)
        if hypot(point.x - down.x, point.y - down.y) < 4 { onBackgroundClick?() }
    }

    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var rect = super.constrainBoundsRect(proposedBounds)
        guard let document = documentView else { return rect }
        if rect.width > document.frame.width { rect.origin.x = (document.frame.width - rect.width) / 2 }
        if rect.height > document.frame.height { rect.origin.y = (document.frame.height - rect.height) / 2 }
        return rect
    }
}

private final class DoubleClickImageView: NSImageView {
    var onDoubleClick: ((NSPoint) -> Void)?

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onDoubleClick?(convert(event.locationInWindow, from: nil)) } else { super.mouseDown(with: event) }
    }
}
