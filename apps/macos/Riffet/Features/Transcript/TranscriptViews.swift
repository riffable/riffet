import AppKit
import QuartzCore
import UniformTypeIdentifiers
import RiffetKit

/// Where fragment views send clicks: the cell, which adds its row and asks the transcript.
@MainActor
protocol FragmentHost: AnyObject {
    func perform(_ action: TranscriptAction)
    var style: TranscriptStyle { get }
    var rowMessage: String? { get }
    /// The row's menu; [view] is the text block right-clicked, whose selection and highlights it may act on.
    func messageMenu(selection: String?, in view: TextLayoutView?) -> NSMenu?
    /// Whether finished answers offer fork / rewind (the main conversation does, a subagent's does not).
    var turnActionsEnabled: Bool { get }
    /// The menu of fragment view [view]: the row's, plus saving the picture or file it shows.
    func fragmentMenu(_ view: NSView) -> NSMenu?
}

extension FragmentHost {
    var turnActionsEnabled: Bool { false }
    func fragmentMenu(_ view: NSView) -> NSMenu? { messageMenu(selection: nil, in: nil) }
}

/// A flipped, layer-backed view that draws only when told to.
class FragmentView: NSView {
    weak var host: FragmentHost?
    /// The tooltip, shown by the transcript for the view under the pointer. `toolTip` would add a
    /// tracking area to every view, and tracking areas moving with the list re-set the cursor.
    var help: String?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    override func menu(for event: NSEvent) -> NSMenu? {
        host?.fragmentMenu(self) ?? super.menu(for: event)
    }
}

// MARK: Drawing helpers

/// SF Symbols configured once per name, size, weight and colour: an image made per draw would be
/// rendered again every time, since its cached representations go with it.
func symbolImage(_ name: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor) -> NSImage? {
    SymbolCache.image(name, size: size, weight: weight, color: color)
}

enum SymbolCache {
    /// Rendered symbols, main thread only (see `NSImage.drawSymbol`).
    @MainActor static var bitmaps: [String: CGImage] = [:]
    private static let lock = NSLock()
    nonisolated(unsafe) private static var images: [String: NSImage] = [:]

    static func image(_ name: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSImage? {
        let key = "\(IconPack.asset(for: name) ?? name)|\(size)|\(weight.rawValue)|\(ObjectIdentifier(color).hashValue)"
        lock.lock()
        if let hit = images[key] {
            lock.unlock()
            return hit
        }
        lock.unlock()
        let configuration = NSImage.SymbolConfiguration(pointSize: size, weight: weight).applying(.init(paletteColors: [color]))
        guard let image = NSImage.icon(name, accessibilityDescription: nil)?.withSymbolConfiguration(configuration) else { return nil }
        lock.lock()
        if images.count > 600 { images.removeAll() }
        images[key] = image
        lock.unlock()
        return image
    }
}

extension NSImage {
    /// Draws a symbol image from a bitmap rendered once per appearance and scale: a symbol drawn as
    /// is rasterizes its vector representation on every draw.
    @MainActor
    func drawSymbol(in rect: NSRect, of view: NSView) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let scale = view.window?.backingScaleFactor ?? 2
        let key = "\(ObjectIdentifier(self).hashValue)|\(view.effectiveAppearance.name.rawValue)|\(scale)|\(rect.width)x\(rect.height)"
        var bitmap = SymbolCache.bitmaps[key]
        if bitmap == nil {
            var proposed = NSRect(origin: .zero, size: rect.size)
            view.effectiveAppearance.performAsCurrentDrawingAppearance {
                bitmap = self.cgImage(forProposedRect: &proposed, context: nil, hints: [.ctm: NSAffineTransform(transform: AffineTransform(scaleByX: scale, byY: scale))])
            }
            if SymbolCache.bitmaps.count > 800 { SymbolCache.bitmaps.removeAll() }
            SymbolCache.bitmaps[key] = bitmap
        }
        guard let bitmap else { return draw(in: rect) }
        context.saveGState()
        context.translateBy(x: rect.minX, y: rect.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(bitmap, in: CGRect(origin: .zero, size: rect.size))
        context.restoreGState()
    }
}

/// A view that tints under the pointer. The transcript tracks the pointer once for the whole list and
/// tells the view under it, so rows carry no tracking areas of their own.
@MainActor
protocol HoverTarget: AnyObject {
    func setHovered(_ on: Bool)
    /// The cursor over [point], in the view's coordinates.
    func cursor(at point: NSPoint) -> NSCursor
}

extension NSAttributedString {
    /// One line in [rect] of a flipped view, truncated at its tail (or middle), vertically centred.
    /// Core Text's truncation, not the string-drawing engine's, which justifies the line first.
    /// [optical] centres the glyphs themselves rather than the line's ascent and descent: a line of
    /// only CJK takes its metrics from the fallback font and sat about a point below its neighbours.
    func drawLine(in rect: NSRect, middle: Bool = false, optical: Bool = false) {
        guard length > 0, rect.width > 0, let context = NSGraphicsContext.current?.cgContext else { return }
        let line = CTLineCreateWithAttributedString(self)
        var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
        let width = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
        var shown = line
        if width > rect.width + 0.5 {
            let attributes = self.attributes(at: middle ? 0 : length - 1, effectiveRange: nil)
            let token = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: attributes))
            shown = CTLineCreateTruncatedLine(line, Double(rect.width), middle ? .middle : .end, token) ?? line
        }
        context.saveGState()
        context.textMatrix = .identity
        let baseline = optical ? rect.midY + CTLineGetBoundsWithOptions(shown, .useGlyphPathBounds).midY : rect.midY + (ascent - descent) / 2
        context.translateBy(x: rect.minX, y: baseline.rounded())
        context.scaleBy(x: 1, y: -1)
        context.textPosition = .zero
        CTLineDraw(shown, context)
        context.restoreGState()
    }

    /// The width of one line of this text.
    var lineWidth: CGFloat {
        CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(self), nil, nil, nil))
    }
}

/// Moves a bright band across [layer] by masking it: the content reads dimmer except under the band.
@MainActor
func applyShimmer(_ layer: CALayer?, on: Bool) {
    guard let layer else { return }
    if !on || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
        layer.mask = nil
        return
    }
    guard layer.mask == nil else {
        layer.mask?.frame = layer.bounds.insetBy(dx: -layer.bounds.width, dy: 0)
        return
    }
    let mask = CAGradientLayer()
    mask.startPoint = CGPoint(x: 0, y: 0.5)
    mask.endPoint = CGPoint(x: 1, y: 0.5)
    let dim = NSColor.black.withAlphaComponent(0.55).cgColor
    mask.colors = [dim, dim, NSColor.black.cgColor, dim, dim]
    mask.locations = [0, 0.4, 0.5, 0.6, 1]
    mask.frame = layer.bounds.insetBy(dx: -layer.bounds.width, dy: 0)
    let animation = CABasicAnimation(keyPath: "locations")
    animation.fromValue = [0, 0.0, 0.1, 0.2, 1]
    animation.toValue = [0, 0.8, 0.9, 1.0, 1]
    animation.duration = 1.6
    // motion-loop: in-progress text shimmer, skipped under Reduce Motion
    animation.repeatCount = .infinity
    mask.add(animation, forKey: "shimmer")
    layer.mask = mask
}

extension TextLayoutView: HoverTarget {
    func setHovered(_ on: Bool) {}
}

// MARK: Box

/// A rounded fill and stroke, drawn by the layer itself (no backing store).
final class BoxView: FragmentView {
    private var spec = BoxSpec()

    override var wantsUpdateLayer: Bool { true }

    func configure(_ spec: BoxSpec) {
        self.spec = spec
        needsDisplay = true
    }

    override func updateLayer() {
        guard let layer else { return }
        layer.backgroundColor = spec.fill?.cgColor
        layer.borderColor = spec.stroke?.cgColor
        layer.borderWidth = spec.stroke == nil ? 0 : 1
        layer.cornerRadius = spec.radius
        layer.cornerCurve = .continuous
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// MARK: Label

/// One line of text drawn in its bounds, optionally shimmering.
final class LabelView: FragmentView {
    var text = NSAttributedString() {
        didSet { if !text.isEqual(to: oldValue) { needsDisplay = true } }
    }
    var middle = false

    override func draw(_ dirtyRect: NSRect) {
        text.drawLine(in: bounds, middle: middle)
    }

    override func layout() {
        super.layout()
        if layer?.mask != nil { applyShimmer(layer, on: true) }
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// MARK: Icon button

/// A small borderless symbol button that tints under the pointer (`IconButtonStyle`).
final class IconButton: FragmentView, HoverTarget {
    var symbol = "doc.on.doc" { didSet { needsDisplay = true } }
    var active = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    private var hovering = false
    private var pressed = false
    private var copyTiming: FeedbackTiming?
    private var copyTask: Task<Void, Never>?
    private var copyObservers: [NSObjectProtocol] = []
    private var copyVisible: Bool?

    deinit {
        copyTask?.cancel()
        copyObservers.forEach(NotificationCenter.default.removeObserver)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil, copyTiming != nil {
            copyTask?.cancel()
            copyTask = nil
            copyTiming = nil
            copyVisible = nil
            symbol = "doc.on.doc"
            copyObservers.forEach(NotificationCenter.default.removeObserver)
            copyObservers = []
        }
        scheduleCopyFeedback()
    }

    func showCopyFeedback() {
        copyTask?.cancel()
        copyTask = nil
        copyVisible = nil
        copyTiming = FeedbackTiming(minimumVisibleMillis: feedbackMinimumVisibleMillis())
        symbol = "checkmark"
        if copyObservers.isEmpty {
            for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
                         NSWindow.didResizeNotification, NSWindow.didMiniaturizeNotification,
                         NSWindow.didDeminiaturizeNotification, NSWindow.didChangeOcclusionStateNotification] {
                copyObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.scheduleCopyFeedback()
                })
            }
            var parent = superview
            while let current = parent {
                if let clip = current as? NSClipView {
                    clip.postsBoundsChangedNotifications = true
                    copyObservers.append(NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in
                        self?.scheduleCopyFeedback()
                    })
                }
                parent = current.superview
            }
        }
        scheduleCopyFeedback()
    }

    private func scheduleCopyFeedback() {
        guard let timing = copyTiming else { return }
        let visible = window?.isVisible == true && window?.isMiniaturized == false && window?.occlusionState.contains(.visible) == true && !isHiddenOrHasHiddenAncestor &&
            visibleRect.contains(bounds) && NSApp.isActive
        if copyVisible == visible, copyTask != nil { return }
        copyTask?.cancel()
        copyTask = nil
        copyVisible = visible
        let remaining = timing.update(nowMillis: ProcessInfo.processInfo.systemUptime * 1000, visible: visible)
        guard visible else { return }
        copyTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(max(1, remaining))) } catch { return }
            guard !Task.isCancelled, let self, self.copyTiming === timing else { return }
            self.copyTask = nil
            _ = timing.update(nowMillis: ProcessInfo.processInfo.systemUptime * 1000, visible: true)
            guard timing.complete else { self.scheduleCopyFeedback(); return }
            self.copyTiming = nil
            self.copyVisible = nil
            self.symbol = "doc.on.doc"
            self.copyObservers.forEach(NotificationCenter.default.removeObserver)
            self.copyObservers = []
        }
    }


    func setHovered(_ on: Bool) {
        guard hovering != on else { return }
        hovering = on
        needsDisplay = true
    }

    func cursor(at point: NSPoint) -> NSCursor { .arrow }

    override func mouseDown(with event: NSEvent) { pressed = true; needsDisplay = true }
    override func mouseUp(with event: NSEvent) {
        pressed = false
        needsDisplay = true
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
    }

    override func accessibilityPerformPress() -> Bool {
        guard let onClick else { return false }
        onClick()
        return true
    }

    // A button to VoiceOver, named by its tooltip unless given a label of its own.
    override func isAccessibilityElement() -> Bool { !isHidden }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { super.accessibilityLabel() ?? help }

    override func draw(_ dirtyRect: NSRect) {
        guard let style = host?.style else { return }
        if pressed || active || hovering {
            (pressed || active ? style.color(\.bgActive) : style.color(\.bgHover)).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: style.radii.control, yRadius: style.radii.control).fill()
        }
        let color = hovering || active ? style.color(\.fg) : style.color(\.fg3)
        guard let image = symbolImage(symbol, size: style.s(10.5), color: color) else { return }
        image.drawSymbol(in: NSRect(x: (bounds.width - image.size.width) / 2, y: (bounds.height - image.size.height) / 2, width: image.size.width, height: image.size.height), of: self)
    }
}

/// Copies [text]; a check mark for a moment afterwards.
@MainActor
enum CopyIcon {
    static func make() -> IconButton {
        let button = IconButton(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
        button.symbol = "doc.on.doc"
        button.help = String(localized: "复制")
        button.setAccessibilityElement(true)
        button.setAccessibilityRole(.button)
        button.setAccessibilityLabel(String(localized: "复制"))
        return button
    }

    @MainActor
    static func copy(_ text: String, from button: IconButton) {
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.setString(text, forType: .string) else { return }
        button.showCopyFeedback()
    }
}

// MARK: Disclosure header

final class DisclosureView: FragmentView, HoverTarget {
    private var spec: DisclosureSpec?
    private var hovering = false
    private var pressed = false
    private let title = LabelView()
    private var spinner: NSProgressIndicator?
    private var elapsed: String?
    /// The Claude list's padding from its border, less the border the row is inset by.
    private static let listPad: CGFloat = 15

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(title)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ spec: DisclosureSpec) {
        var spec = spec
        spec.title = Self.oneLine(spec.title)
        if let detail = spec.detail { spec.detail = .init(text: Self.oneLine(detail.text), font: detail.font, color: detail.color, quiet: detail.quiet, quietColor: detail.quietColor) }
        if let current = self.spec, current.looksLike(spec) {
            // Same header: keep the drawing, take the new action and clock.
            self.spec = spec
            if spec.clock != nil { tick() }
            return
        }
        self.spec = spec
        cached = nil
        elapsed = nil
        hovering = false
        help = spec.help
        title.middle = spec.truncateMiddle
        if case .spinner = spec.icon {
            if spinner == nil {
                let indicator = NSProgressIndicator()
                indicator.style = .spinning
                indicator.controlSize = .mini
                indicator.isIndeterminate = true
                indicator.usesThreadedAnimation = true
                addSubview(indicator)
                spinner = indicator
            }
            spinner?.isHidden = false
            spinner?.startAnimation(nil)
        } else {
            spinner?.stopAnimation(nil)
            spinner?.isHidden = true
        }
        tick()
        setAccessibilityLabel(spec.title)
        needsLayout = true
        needsDisplay = true
    }

    /// A header shows one line; typesetting a multi-kilobyte command to truncate it costs a frame.
    private static func oneLine(_ text: String) -> String {
        let head = text.prefix(300)
        guard head.contains(where: \.isNewline) || head.count < text.count else { return text }
        return String(head).replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
    }

    /// Re-reads what changes with the clock (a running block's duration, a shell's elapsed time).
    func tick() {
        guard let spec else { return }
        switch spec.clock {
        case let .process(row):
            let label = processHeaderLabel(row: row, nowMillis: Int64(Date().timeIntervalSince1970 * 1000))
            if label != self.spec?.title { self.spec?.title = label; cached = nil; needsLayout = true }
        case let .job(job):
            let started = ServerTime.date(job.startedAt)
            let running = job.status == .running && started != nil ? Int64(Date().timeIntervalSince(started!) * 1000) : 0
            let millis = max(job.runningMs?.int64Value ?? 0, running)
            let value = millis < 1000 ? nil : formatDurationMs(millis: millis)
            if value != elapsed { elapsed = value; cached = nil; needsLayout = true; needsDisplay = true }
        case let .activity(activity, stopping):
            let stats = activityView(activity: activity, stopping: stopping, nowMillis: Int64(Date().timeIntervalSince1970 * 1000)).stats
            if stats != spec.trailing.first?.text, let template = spec.trailing.first {
                self.spec?.trailing = stats.map { [.init(text: $0, font: template.font, color: template.color)] } ?? []
                cached = nil; needsLayout = true; needsDisplay = true
            }
        case nil:
            break
        }
    }

    private var titleColor: NSColor {
        guard let style = host?.style, let spec else { return .labelColor }
        switch spec.variant {
        case .listRow: return spec.danger ? style.color(\.danger) : style.color(\.fg3)
        case .listSummary: return style.color(hovering ? \.fg : \.fg2)
        case .plain: return spec.danger ? style.color(\.danger) : hovering ? style.color(\.fg2) : style.color(\.fg3)
        }
    }

    private var trailingPieces: [DisclosureSpec.Piece] {
        guard let spec, let style = host?.style else { return [] }
        var pieces = spec.trailing
        if let elapsed { pieces.append(.init(text: elapsed, font: NSFont.riffetDigits(size: style.s(11.5)), color: style.color(\.fg4))) }
        return pieces
    }

    private struct Metrics {
        var icon = NSRect.zero
        var title = NSRect.zero
        var detail = NSRect.zero
        var inline: [NSRect] = []
        var dot = NSRect.zero
        var trailing: [NSRect] = []
        var chevron = NSRect.zero
        var spinner = NSRect.zero
    }

    private var cached: (size: NSSize, metrics: Metrics)?

    private func metrics() -> Metrics {
        if let cached, cached.size == bounds.size { return cached.metrics }
        let result = measure()
        cached = (bounds.size, result)
        return result
    }

    private func measure() -> Metrics {
        var result = Metrics()
        guard let spec, let style = host?.style else { return result }
        let h = bounds.height
        // A list's rows and the line over it have no icon column; a running call's spinner ends the row instead.
        let iconless = spec.variant != .plain
        let listRow: Bool = if case .listRow = spec.variant { true } else { false }
        let pad = listRow ? Self.listPad : 0
        result.icon = iconless ? .zero : NSRect(x: 0, y: 0, width: 16, height: h)
        var x: CGFloat = iconless ? pad : 16 + 8
        func width(of piece: DisclosureSpec.Piece) -> CGFloat {
            ceil(NSAttributedString(string: piece.text, attributes: [.font: piece.font]).lineWidth)
        }
        // The trailing pieces are the row's state and keep the right edge; the chevron is not
        // among them. It only appears under the pointer (or while open), so it follows the
        // content — title, detail, inline pieces — the way the arrow follows a diff's counts.
        var right = bounds.width - pad - spec.reserve
        if listRow, case .spinner = spec.icon {
            result.spinner = NSRect(x: right - 14, y: (h - 14) / 2, width: 14, height: 14)
            right -= 14 + 8
        }
        var trailing: [NSRect] = []
        for piece in trailingPieces.reversed() {
            let pieceWidth = width(of: piece)
            trailing.insert(NSRect(x: right - pieceWidth, y: 0, width: pieceWidth, height: h), at: 0)
            right -= pieceWidth + 6
        }
        result.trailing = trailing
        if spec.dot != nil {
            result.dot = NSRect(x: right - 6, y: (h - 6) / 2, width: 6, height: 6)
            right -= 6 + 8
        }
        let limit = right - (trailing.isEmpty && spec.dot == nil ? 0 : 8)
        let chevronWidth: CGFloat = 12
        let inlineWidths = spec.inline.map(width(of:))
        let inlineTotal = inlineWidths.isEmpty ? 0 : 8 + inlineWidths.reduce(0, +) + 6 * CGFloat(inlineWidths.count - 1)
        let available = max(0, limit - 6 - chevronWidth - x - inlineTotal)
        let titleWidth = ceil(NSAttributedString(string: spec.title, attributes: [.font: spec.titleFont]).lineWidth)
        if let detail = spec.detail {
            let detailWidth = ceil(NSAttributedString(string: detail.text, attributes: [.font: detail.font]).lineWidth)
            let titleShown = min(titleWidth, max(available * 0.6, available - detailWidth - 8))
            result.title = NSRect(x: x, y: 0, width: titleShown, height: h)
            x += titleShown + 8
            result.detail = NSRect(x: x, y: 0, width: max(0, min(detailWidth, available - titleShown - 8)), height: h)
            x += result.detail.width
        } else {
            let titleShown = min(titleWidth, available)
            result.title = NSRect(x: x, y: 0, width: titleShown, height: h)
            x += titleShown
        }
        if !inlineWidths.isEmpty {
            x += 8
            for pieceWidth in inlineWidths {
                result.inline.append(NSRect(x: x, y: 0, width: pieceWidth, height: h))
                x += pieceWidth + 6
            }
            x -= 6
        }
        result.chevron = NSRect(x: x + 6, y: 0, width: chevronWidth, height: h)
        _ = style
        return result
    }

    override func layout() {
        super.layout()
        guard let spec else { return }
        let metrics = metrics()
        title.frame = metrics.title
        title.text = NSAttributedString(string: spec.title, attributes: [.font: spec.titleFont, .foregroundColor: titleColor])
        applyShimmer(title.layer, on: spec.shimmer)
        spinner?.frame = spec.variant.isListRow ? metrics.spinner : NSRect(x: 1, y: (bounds.height - 14) / 2, width: 14, height: 14)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let spec, let style = host?.style else { return }
        let metrics = metrics()
        if case let .listRow(place) = spec.variant, hovering {
            // The first and last rows share the border's corners, one point inside it.
            let radius = max(0, style.radii.card - 1)
            style.color(\.bgHover).setFill()
            Self.washPath(in: bounds, corners: (place == .first || place == .only ? radius : 0, place == .last || place == .only ? radius : 0)).fill()
        }
        if spec.variant == .plain, case let .symbol(name, size, color) = spec.icon, let image = symbolImage(name, size: style.s(size), color: color) {
            image.drawSymbol(in: NSRect(x: (16 - image.size.width) / 2, y: (bounds.height - image.size.height) / 2, width: image.size.width, height: image.size.height), of: self)
        }
        if let detail = spec.detail, metrics.detail.width > 0 {
            detail.attributed.drawLine(in: metrics.detail)
        }
        for (piece, rect) in zip(spec.inline, metrics.inline) {
            NSAttributedString(string: piece.text, attributes: [.font: piece.font, .foregroundColor: piece.color]).drawLine(in: rect)
        }
        if let dot = spec.dot {
            dot.setFill()
            NSBezierPath(ovalIn: metrics.dot).fill()
        }
        for (piece, rect) in zip(trailingPieces, metrics.trailing) {
            NSAttributedString(string: piece.text, attributes: [.font: piece.font, .foregroundColor: piece.color]).drawLine(in: rect)
        }
        let symbol: String
        var visible = true
        var turned = false
        switch spec.chevron {
        case let .hover(open):
            symbol = "chevron.right"
            visible = hovering || open
            turned = open
        case let .always(open):
            symbol = "chevron.right"
            turned = open
        case .arrow:
            symbol = "arrow.up.right"
            visible = hovering
        }
        if visible, let image = symbolImage(symbol, size: style.s(9), weight: .semibold, color: style.color(\.fg4)) {
            let rect = NSRect(x: metrics.chevron.midX - image.size.width / 2, y: metrics.chevron.midY - image.size.height / 2, width: image.size.width, height: image.size.height)
            if turned {
                NSGraphicsContext.saveGraphicsState()
                let transform = NSAffineTransform()
                transform.translateX(by: rect.midX, yBy: rect.midY)
                transform.rotate(byDegrees: 90)
                transform.translateX(by: -rect.midX, yBy: -rect.midY)
                transform.concat()
                image.drawSymbol(in: rect, of: self)
                NSGraphicsContext.restoreGraphicsState()
            } else {
                image.drawSymbol(in: rect, of: self)
            }
        }
    }


    func cursor(at point: NSPoint) -> NSCursor { .arrow }

    /// The row's rectangle with the corners that touch the list's border rounded to it.
    private static func washPath(in rect: NSRect, corners: (top: CGFloat, bottom: CGFloat)) -> NSBezierPath {
        guard corners.top > 0 || corners.bottom > 0 else { return NSBezierPath(rect: rect) }
        // The view is flipped: its top is minY.
        let path = NSBezierPath()
        let (t, b) = corners
        path.move(to: NSPoint(x: rect.minX + t, y: rect.minY))
        path.line(to: NSPoint(x: rect.maxX - t, y: rect.minY))
        if t > 0 { path.appendArc(from: NSPoint(x: rect.maxX, y: rect.minY), to: NSPoint(x: rect.maxX, y: rect.minY + t), radius: t) }
        path.line(to: NSPoint(x: rect.maxX, y: rect.maxY - b))
        if b > 0 { path.appendArc(from: NSPoint(x: rect.maxX, y: rect.maxY), to: NSPoint(x: rect.maxX - b, y: rect.maxY), radius: b) }
        path.line(to: NSPoint(x: rect.minX + b, y: rect.maxY))
        if b > 0 { path.appendArc(from: NSPoint(x: rect.minX, y: rect.maxY), to: NSPoint(x: rect.minX, y: rect.maxY - b), radius: b) }
        path.line(to: NSPoint(x: rect.minX, y: rect.minY + t))
        if t > 0 { path.appendArc(from: NSPoint(x: rect.minX, y: rect.minY), to: NSPoint(x: rect.minX + t, y: rect.minY), radius: t) }
        path.close()
        return path
    }

    func setHovered(_ on: Bool) {
        guard hovering != on else { return }
        hovering = on
        needsLayout = true
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        pressed = true
        alphaValue = 0.7
    }

    override func mouseUp(with event: NSEvent) {
        pressed = false
        alphaValue = 1
        guard let spec, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        host?.perform(spec.action)
    }

    override func accessibilityPerformPress() -> Bool {
        guard let spec else { return false }
        host?.perform(spec.action)
        return true
    }
}

extension DisclosureSpec.Variant {
    var isListRow: Bool { if case .listRow = self { true } else { false } }
}

extension DisclosureSpec {
    /// Draws the same: everything but the action and the clock's source.
    func looksLike(_ other: DisclosureSpec) -> Bool {
        guard variant == other.variant, title == other.title, danger == other.danger, shimmer == other.shimmer, truncateMiddle == other.truncateMiddle,
              titleFont == other.titleFont, help == other.help, dot === other.dot,
              detail?.text == other.detail?.text, detail?.color === other.detail?.color, detail?.quiet == other.detail?.quiet,
              inline.map(\.text) == other.inline.map(\.text), zip(inline, other.inline).allSatisfy({ $0.color === $1.color }),
              trailing.map(\.text) == other.trailing.map(\.text), zip(trailing, other.trailing).allSatisfy({ $0.color === $1.color }) else { return false }
        switch (icon, other.icon) {
        case (.spinner, .spinner): break
        case let (.symbol(a, sa, ca), .symbol(b, sb, cb)) where a == b && sa == sb && ca === cb: break
        default: return false
        }
        switch (chevron, other.chevron) {
        case let (.hover(a), .hover(b)) where a == b: return true
        case let (.always(a), .always(b)) where a == b: return true
        case (.arrow, .arrow): return true
        default: return false
        }
    }
}

// MARK: Footer

final class FooterView: FragmentView {
    private var spec: FooterSpec?
    var isTrailing: Bool { spec?.trailing == true }
    /// Time, speed and actions recede until the row is hovered; delivery status and live clocks stay.
    var revealed = true { didSet { if revealed != oldValue { updateVisibility() } } }

    private func updateVisibility() {
        alphaValue = revealed || spec?.status != nil || spec?.clock != nil || spec?.keepsShown == true ? 1 : 0
        updateButtons()
    }

    /// Faded out, the buttons are hidden too: an invisible copy or ⋯ must not turn the pointer
    /// into a hand or take a click before the line has appeared.
    private func updateButtons() {
        let shown = alphaValue > 0
        copy.isHidden = !shown || spec?.copy.isEmpty != false || leadsWithMore
        more.isHidden = !shown || !showsMore
    }

    /// The pieces are placed from the width (a trailing footer from its right edge), and the layer
    /// redraws only when asked: a new size needs to reposition and redraw its centred contents.
    override func setFrameSize(_ newSize: NSSize) {
        let resized = newSize != frame.size
        super.setFrameSize(newSize)
        if resized { needsLayout = true; needsDisplay = true }
    }
    private var clockText: String?
    private let copy = CopyIcon.make()
    /// The row's menu (the same as its right-click menu), next to copy.
    private let more = IconButton(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
    /// The answer can be saved (收藏回复) or exported (导出为图片): the "more" button shows the row's menu.
    var hasActions = false {
        didSet {
            updateButtons()
            if hasActions != oldValue { needsLayout = true; needsDisplay = true }
        }
    }
    private var hasMore: Bool { turnRunId != nil || hasActions }
    /// An answer's footer is the web's: ⋯ first (copy is its first item), then time and speed.
    /// A message's keeps copy as a button of its own, after its time.
    private var leadsWithMore: Bool { spec?.trailing == false }
    private var showsMore: Bool { hasMore || (leadsWithMore && spec?.copy.isEmpty == false) }

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(copy)
        addSubview(more)
        copy.onClick = { [weak self] in
            guard let self, let spec = self.spec else { return }
            CopyIcon.copy(spec.copy, from: self.copy)
        }
        more.symbol = "ellipsis"
        more.help = String(localized: "更多")
        more.setAccessibilityElement(true)
        more.setAccessibilityRole(.button)
        more.setAccessibilityLabel(String(localized: "回答操作"))
        more.onClick = { [weak self] in
            guard let self, self.showsMore, let menu = self.host?.messageMenu(selection: nil, in: nil) else { return }
            // Copy is the menu's first item, as on the web, also on a row whose menu has no message of its own.
            if let text = self.spec?.copy, !text.isEmpty, !menu.items.contains(where: { $0.title == String(localized: "复制") }) {
                menu.insertItem(MenuAction.item(String(localized: "复制"), symbol: "doc.on.doc") { copyToPasteboard(text) }, at: 0)
                if menu.items.count > 1 { menu.insertItem(.separator(), at: 1) }
            }
            guard !menu.items.isEmpty else { return }
            menu.popUpStyled(at: NSPoint(x: 0, y: self.more.bounds.height + 4), in: self.more)
        }
    }

    /// The run the "more" button acts on, when the host offers turn actions.
    private var turnRunId: String? { host?.turnActionsEnabled == true ? spec?.turnRunId : nil }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ spec: FooterSpec) {
        if let current = self.spec, current.time == spec.time, current.copy == spec.copy, current.trailing == spec.trailing,
           current.speed?.label == spec.speed?.label, current.status?.0 == spec.status?.0, current.status?.1 === spec.status?.1, current.statusSymbol == spec.statusSymbol,
           current.turnRunId == spec.turnRunId, current.keepsShown == spec.keepsShown, current.source == spec.source {
            self.spec = spec
            tick()
            return
        }
        self.spec = spec
        updateVisibility()
        copy.host = host
        more.host = host
        updateButtons()
        tick()
        needsLayout = true
        needsDisplay = true
    }

    func tick() {
        guard let spec else { return }
        let value: String?
        switch spec.clock {
        case let .activity(activity, stopping):
            value = activityView(activity: activity, stopping: stopping, nowMillis: Int64(Date().timeIntervalSince1970 * 1000)).stats
        case let .job(job):
            let started = ServerTime.date(job.startedAt)
            let running = job.status == .running ? started.map { Int64(Date().timeIntervalSince($0) * 1000) } ?? 0 : 0
            let millis = max(job.runningMs?.int64Value ?? 0, running)
            value = millis >= 1000 ? formatDurationMs(millis: millis) : nil
        case let .process(row):
            value = processHeaderLabel(row: row, nowMillis: Int64(Date().timeIntervalSince1970 * 1000))
        case nil:
            value = nil
        }
        guard value != clockText else { return }
        clockText = value
        needsLayout = true
        needsDisplay = true
    }

    private func pieces() -> [(NSAttributedString, String?)] {
        guard let spec, let style = host?.style else { return [] }
        let font = NSFont.riffetDigits(size: style.s(11))
        var result: [(NSAttributedString, String?)] = []
        // A leading glyph and a label in one colour: the sender, then the delivery status.
        func labelled(_ text: String, symbol: String?, color: NSColor) -> NSAttributedString {
            let label = NSMutableAttributedString(string: "")
            if let symbol, let image = symbolImage(symbol, size: style.s(11), color: color) {
                let attachment = NSTextAttachment()
                attachment.image = image
                attachment.bounds = CGRect(x: 0, y: -2, width: style.s(11), height: style.s(11))
                label.append(NSAttributedString(attachment: attachment))
                label.append(NSAttributedString(string: " "))
            }
            label.append(NSAttributedString(string: text, attributes: [.font: style.font(11), .foregroundColor: color]))
            return label
        }
        if let source = spec.source { result.append((labelled(source, symbol: "person.crop.square", color: style.color(\.fg3)), "source")) }
        if let status = spec.status { result.append((labelled(status.0, symbol: spec.statusSymbol, color: status.1), "status")) }
        if let time = formatDateTime(value: spec.time) {
            result.append((NSAttributedString(string: time, attributes: [.font: font, .foregroundColor: style.color(\.fg3)]), "time"))
        }
        if let clockText { result.append((NSAttributedString(string: clockText, attributes: [.font: font, .foregroundColor: style.color(\.fg3)]), "stats")) }
        // A provider's own count reads as the time does; an estimate (~) a step quieter.
        if let speed = spec.speed { result.append((NSAttributedString(string: speed.label, attributes: [.font: font, .foregroundColor: style.color(speed.estimated ? \.fg4 : \.fg3)]), "speed")) }
        if leadsWithMore {
            if showsMore { result.insert((NSAttributedString(string: "\u{FFFC}"), "more"), at: 0) }
        } else {
            if !spec.copy.isEmpty { result.append((NSAttributedString(string: "\u{FFFC}"), "copy")) }
            if hasMore { result.append((NSAttributedString(string: "\u{FFFC}"), "more")) }
        }
        return result
    }

    /// What the footer draws, in its own coordinates; a trailing footer is mostly empty width.
    var contentRect: NSRect { frames().reduce(NSRect.null) { $0.union($1.2) } }

    /// The web's spacing: a message's pieces 8 apart; an answer's texts 12 apart (4 of gap and 4 of
    /// padding each side), the ⋯ glyph 14 from the time, and the glyph on the column's edge — the
    /// button's 4pt inset hangs outside, as the web's row hangs 6px out under its padded button.
    private func spacing(after kind: String?) -> CGFloat {
        guard leadsWithMore else { return 8 }
        return kind == "more" ? 10 : 12
    }

    private func frames() -> [(NSAttributedString, String?, NSRect)] {
        let items = pieces()
        var widths = items.map { $0.1 == "copy" || $0.1 == "more" ? 20 : ceil($0.0.lineWidth) }
        let gaps = items.dropLast().reduce(CGFloat(0)) { $0 + spacing(after: $1.1) }
        let hang: CGFloat = leadsWithMore && items.first?.1 == "more" ? -4 : 0
        var overflow = max(0, widths.reduce(0, +) + gaps + hang - bounds.width)
        // Keep the action reachable when a failure explanation is wider than the column.
        for index in items.indices where items[index].1 != "copy" && items[index].1 != "more" && overflow > 0 {
            let reduction = min(widths[index], overflow)
            widths[index] -= reduction
            overflow -= reduction
        }
        let total = widths.reduce(0, +) + gaps
        var x = spec?.trailing == true ? bounds.width - total : hang
        var result: [(NSAttributedString, String?, NSRect)] = []
        for (item, width) in zip(items, widths) {
            result.append((item.0, item.1, NSRect(x: x, y: 0, width: width, height: bounds.height)))
            x += width + spacing(after: item.1)
        }
        return result
    }

    override func layout() {
        super.layout()
        if let copyFrame = frames().first(where: { $0.1 == "copy" })?.2 {
            copy.frame = NSRect(x: copyFrame.minX, y: (bounds.height - 20) / 2, width: 20, height: 20)
        }
        if let moreFrame = frames().first(where: { $0.1 == "more" })?.2 {
            more.frame = NSRect(x: moreFrame.minX, y: (bounds.height - 20) / 2, width: 20, height: 20)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        for (text, kind, rect) in frames() where kind != "copy" && kind != "more" {
            text.drawLine(in: rect)
        }
    }
}

// MARK: Code

/**
 * A code block's header: the language at rest, its buttons only under the pointer. The block is
 * content, not a toolbar — three permanent buttons on every three-line fence out-shouted the
 * prose, and the transcript's central hover tracking makes the reveal free.
 */
final class CodeHeaderView: FragmentView, HoverTarget {
    private var spec: CodeHeaderSpec?
    private var hovered = false
    private let render = IconButton()
    private let wrap = IconButton()
    private let copy = CopyIcon.make()

    func setHovered(_ on: Bool) {
        // The buttons are hover targets of their own: moving onto one makes the header the
        // non-target, and honouring that would hide the button under the pointer. A "lost" hover
        // with the pointer still inside the header is that move, not a leave.
        if !on, let window, bounds.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil)) { return }
        guard hovered != on else { return }
        hovered = on
        applyButtons()
        needsLayout = true
    }

    func cursor(at point: NSPoint) -> NSCursor { .arrow }

    private func applyButtons() {
        guard let spec else {
            [render, wrap, copy].forEach { $0.isHidden = true }
            return
        }
        render.isHidden = !spec.canRender || !hovered
        wrap.isHidden = spec.rendered || !hovered
        copy.isHidden = !hovered
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        [render, wrap, copy].forEach(addSubview)
        render.onClick = { [weak self] in if let id = self?.spec?.id { self?.host?.perform(.toggleRendered(id)) } }
        wrap.onClick = { [weak self] in if let id = self?.spec?.id { self?.host?.perform(.toggleWrap(id)) } }
        copy.onClick = { [weak self] in
            guard let self, let spec = self.spec else { return }
            CopyIcon.copy(spec.copy, from: self.copy)
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ spec: CodeHeaderSpec) {
        if let current = self.spec, current.id == spec.id, current.label == spec.label, current.copy == spec.copy,
           current.canRender == spec.canRender, current.rendered == spec.rendered, current.wraps == spec.wraps { return }
        self.spec = spec
        [render, wrap, copy].forEach { $0.host = host }
        render.symbol = spec.rendered ? "chevron.left.forwardslash.chevron.right" : "eye"
        render.help = spec.rendered ? String(localized: "显示源码") : (MermaidRequest.supports(spec.label) ? String(localized: "渲染图表") : String(localized: "渲染 Markdown"))
        wrap.symbol = spec.wraps ? "arrow.left.and.right.text.vertical" : "text.word.spacing"
        wrap.active = spec.wraps
        wrap.help = spec.wraps ? String(localized: "不换行") : String(localized: "自动换行")
        applyButtons()
        needsLayout = true
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        var x = bounds.width - 4 - 20
        copy.frame = NSRect(x: x, y: 4, width: 20, height: 20)
        for button in [wrap, render] where !button.isHidden {
            x -= 24
            button.frame = NSRect(x: x, y: 4, width: 20, height: 20)
        }
    }

    // The buttons only show under the pointer; VoiceOver reaches them as the header's actions.
    override func isAccessibilityElement() -> Bool { spec != nil }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? { spec?.label }
    override func accessibilityCustomActions() -> [NSAccessibilityCustomAction]? {
        guard let spec else { return nil }
        func action(_ button: IconButton) -> NSAccessibilityCustomAction {
            NSAccessibilityCustomAction(name: button.help ?? "") { [weak button] in button?.accessibilityPerformPress() ?? false }
        }
        var actions: [NSAccessibilityCustomAction] = []
        if spec.canRender { actions.append(action(render)) }
        if !spec.rendered { actions.append(action(wrap)) }
        actions.append(action(copy))
        return actions
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let spec, let style = host?.style else { return }
        NSAttributedString(string: spec.label, attributes: [.font: style.mono(11), .foregroundColor: style.color(\.fg4)])
            .drawLine(in: NSRect(x: 12, y: 0, width: bounds.width - 100, height: bounds.height))
    }
}

/// Source text in a viewport of at most the block's height, scrolling inside both ways.
final class CodeBodyView: FragmentView {
    private let strip = ScrollStrip()
    private let document = FlippedView()
    private let text = TextLayoutView()
    private var spec: CodeBodySpec?

    override init(frame: NSRect) {
        super.init(frame: frame)
        document.addSubview(text)
        strip.documentView = document
        addSubview(strip)
    }

    required init?(coder: NSCoder) { fatalError() }

    var textView: TextLayoutView { text }

    func configure(_ spec: CodeBodySpec) {
        let fresh = self.spec.map { $0.text.string != spec.text.string } ?? true
        self.spec = spec
        text.layout = spec.text
        text.menuProvider = { [weak self] view in self?.host?.messageMenu(selection: view.selectedText, in: view) }
        needsLayout = true
        layoutSubtreeIfNeeded()
        if fresh { spec.startAtEnd ? strip.scrollToEnd() : strip.scrollToStart() }
    }

    override func layout() {
        super.layout()
        guard let spec else { return }
        strip.frame = bounds
        let width = max(bounds.width, spec.text.size.width + spec.inset * 2)
        document.frame = NSRect(x: 0, y: 0, width: width, height: max(bounds.height, spec.contentHeight))
        text.frame = NSRect(x: spec.inset, y: 0, width: spec.text.size.width + 2, height: spec.text.size.height)
    }
}

// MARK: Diff

final class DiffHeaderView: FragmentView, HoverTarget {
    private var spec: DiffHeaderSpec?

    func configure(_ spec: DiffHeaderSpec) {
        self.spec = spec
        help = String(localized: "打开 \(spec.path)")
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let spec, let style = host?.style else { return }
        if let fill = style.blockFill {
            fill.setFill()
            bounds.fill()
        } else {
            // Without a tint the header needs a rule to part it from the lines under it.
            style.color(\.line).setFill()
            NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        }
        var right = bounds.width - 10
        var stats: [(String, NSColor)] = []
        if spec.removed > 0 { stats.append(("−\(spec.removed)", style.color(\.danger))) }
        if spec.added > 0 { stats.append(("+\(spec.added)", style.color(\.success))) }
        for (text, color) in stats {
            let value = NSAttributedString(string: text, attributes: [.font: style.mono(12), .foregroundColor: color])
            let width = ceil(value.lineWidth)
            value.drawLine(in: NSRect(x: right - width, y: 0, width: width, height: bounds.height))
            right -= width + 8
        }
        if let icon = symbolImage("doc", size: style.s(11), color: style.color(\.fg3)) {
            icon.drawSymbol(in: NSRect(x: 10, y: (bounds.height - icon.size.height) / 2, width: icon.size.width, height: icon.size.height), of: self)
        }
        NSAttributedString(string: spec.path, attributes: [.font: style.mono(12), .foregroundColor: style.color(\.fg2)])
            .drawLine(in: NSRect(x: 30, y: 0, width: max(0, right - 30), height: bounds.height), middle: true)
    }

    /// Taken here, or the table would track the click and keep the mouse-up.
    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        guard let spec, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        host?.perform(.openFile(path: spec.path, line: spec.line))
    }

    func setHovered(_ on: Bool) {}
    func cursor(at point: NSPoint) -> NSCursor { .pointingHand }
}

final class DiffView: FragmentView {
    private let strip = ScrollStrip()
    private let lines = DiffLines()
    private var spec: DiffSpec?

    override init(frame: NSRect) {
        super.init(frame: frame)
        strip.documentView = lines
        addSubview(strip)
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ spec: DiffSpec) {
        if let current = self.spec, current.lines.count == spec.lines.count, current.contentWidth == spec.contentWidth,
           zip(current.lines, spec.lines).allSatisfy({ $0.text == $1.text && $0.kind == $1.kind && $0.old == $1.old && $0.new == $1.new }) { return }
        self.spec = spec
        lines.spec = spec
        lines.host = host
        lines.needsDisplay = true
        needsLayout = true
    }

    override func layout() {
        super.layout()
        guard let spec else { return }
        strip.frame = bounds
        let height = max(bounds.height, CGFloat(spec.lines.count) * spec.lineHeight + 8)
        lines.frame = NSRect(x: 0, y: 0, width: max(bounds.width, spec.contentWidth), height: height)
    }

    final class DiffLines: FragmentView {
        var spec: DiffSpec?

        override func draw(_ dirtyRect: NSRect) {
            guard let spec, let style = host?.style else { return }
            let first = max(0, Int((dirtyRect.minY - 4) / spec.lineHeight))
            let last = min(spec.lines.count, Int((dirtyRect.maxY - 4) / spec.lineHeight) + 1)
            guard first < last else { return }
            for index in first..<last {
                let line = spec.lines[index]
                let rect = NSRect(x: 0, y: 4 + CGFloat(index) * spec.lineHeight, width: bounds.width, height: spec.lineHeight)
                switch line.kind {
                case .add: style.color(\.diffAdd).setFill(); rect.fill()
                case .del: style.color(\.diffDel).setFill(); rect.fill()
                case .gap: style.color(\.bgSubtle).setFill(); rect.fill()
                case .context: break
                }
                if line.kind == .gap {
                    NSAttributedString(string: line.text, attributes: [.font: spec.font, .foregroundColor: style.color(\.fg4)]).drawLine(in: rect.insetBy(dx: 10, dy: 0))
                    continue
                }
                let gutter: [NSAttributedString.Key: Any] = [.font: spec.gutterFont, .foregroundColor: style.color(\.fg4)]
                let old = NSAttributedString(string: line.old, attributes: gutter)
                let new = NSAttributedString(string: line.new, attributes: gutter)
                old.drawLine(in: NSRect(x: 38 - ceil(old.lineWidth), y: rect.minY, width: 38, height: rect.height))
                new.drawLine(in: NSRect(x: 80 - ceil(new.lineWidth), y: rect.minY, width: 38, height: rect.height))
                let marker = line.kind == .add ? "+" : line.kind == .del ? "−" : " "
                let markerColor = line.kind == .add ? style.color(\.diffAddMarker) : line.kind == .del ? style.color(\.diffDelMarker) : style.color(\.fg4)
                NSAttributedString(string: marker, attributes: [.font: spec.font, .foregroundColor: markerColor]).drawLine(in: NSRect(x: 84, y: rect.minY, width: 14, height: rect.height))
                NSAttributedString(string: line.text.isEmpty ? " " : line.text, attributes: [.font: spec.font, .foregroundColor: style.color(\.fg)])
                    .drawLine(in: NSRect(x: spec.gutter, y: rect.minY, width: max(1, bounds.width - spec.gutter), height: rect.height))
            }
        }
    }
}

// MARK: Table

final class TableBlockView: FragmentView {
    private let strip = ScrollStrip()
    private let grid = Grid()
    private let border = BoxView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        strip.documentView = grid
        strip.layer?.cornerCurve = .continuous
        addSubview(strip)
        addSubview(border)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// The cells' text, header first, row by row.
    var textViews: [TextLayoutView] { grid.textViews }

    func configure(_ spec: TableSpec) {
        grid.host = host
        grid.configure(spec)
        let radius = host?.style.radii.container ?? 10
        strip.layer?.cornerRadius = radius
        border.configure(BoxSpec(stroke: host?.style.color(\.line), radius: radius))
        needsLayout = true
    }

    override func layout() {
        super.layout()
        guard let spec = grid.spec else { return }
        let width = min(bounds.width, spec.width)
        let frame = NSRect(x: 0, y: 1, width: width, height: bounds.height - 2)
        strip.frame = frame
        border.frame = frame
        grid.frame = NSRect(x: 0, y: 0, width: spec.width, height: frame.height)
    }

    final class Grid: FragmentView {
        private(set) var spec: TableSpec?
        private var cells: [TextLayoutView] = []
        var textViews: [TextLayoutView] { Array(cells.prefix(spec.map { $0.header.count + $0.rows.reduce(0) { $0 + $1.count } } ?? 0)) }

        func configure(_ spec: TableSpec) {
            self.spec = spec
            let layouts = spec.header + spec.rows.flatMap { $0 }
            while cells.count < layouts.count {
                let view = TextLayoutView()
                addSubview(view)
                cells.append(view)
            }
            for (index, view) in cells.enumerated() {
                view.isHidden = index >= layouts.count
                guard index < layouts.count else { continue }
                view.layout = layouts[index]
                view.menuProvider = { [weak self] view in self?.host?.messageMenu(selection: view.selectedText, in: view) }
                view.onLink = { [weak self] url in self?.host?.perform(.openURL(url)) }
            }
            var index = 0
            var y: CGFloat = 0
            for row in -1..<spec.rows.count {
                let height = row < 0 ? spec.headerHeight : spec.rowHeights[row]
                var x: CGFloat = 0
                for column in spec.columns.indices {
                    let layout = layouts[index]
                    cells[index].frame = NSRect(x: x + 12, y: y + 7, width: max(layout.size.width + 2, spec.columns[column] - 24), height: layout.size.height)
                    x += spec.columns[column]
                    index += 1
                }
                y += height + (row < 0 ? 0 : 1)
                if row < 0 { y += 1 }
            }
            needsDisplay = true
        }

        override func draw(_ dirtyRect: NSRect) {
            guard let spec, let style = host?.style else { return }
            if let fill = style.blockFill {
                fill.setFill()
                NSRect(x: 0, y: 0, width: bounds.width, height: spec.headerHeight).fill()
            }
            style.color(\.line).setFill()
            var y = spec.headerHeight
            for height in spec.rowHeights {
                NSRect(x: 0, y: y, width: bounds.width, height: 1).fill()
                y += 1 + height
            }
            var x: CGFloat = 0
            for width in spec.columns.dropLast() {
                x += width
                NSRect(x: x, y: 0, width: 1, height: bounds.height).fill()
            }
        }
    }
}

// MARK: Images

/// A transcript image. The decoded image is the layer's contents, so the GPU scales it; drawing it
/// with high-quality interpolation on every redraw cost a frame per image.
final class ImageFragmentView: FragmentView, NSDraggingSource, HoverTarget {
    private var spec: ImageSpec?
    private var image: NSImage?
    /// The picture once loaded, for saving it (收藏).
    var loadedImage: NSImage? { image }
    /// What a saved copy is called and where the picture was: a file path when it came from one.
    var asset: (name: String, path: String?) {
        switch spec?.source {
        case let .projectFile(_, path)?: return ((path as NSString).lastPathComponent, path)
        case let .url(src)? where !src.hasPrefix("data:"):
            let path = URL(string: src).flatMap { $0.isFileURL || $0.scheme == nil ? $0.path : nil } ?? src
            return ((path as NSString).lastPathComponent.isEmpty ? String(localized: "图片.png") : (path as NSString).lastPathComponent, path)
        default: return (spec?.label.isEmpty == false && spec?.label != String(localized: "图片") ? spec!.label : String(localized: "图片.png"), nil)
        }
    }
    private var load: Task<Void, Never>?
    /// Loaded into a placeholder box of another shape: shown once the row is laid out at the
    /// image's size (or after `reveal`'s fallback), not stretched into the box for a frame.
    private var awaitingSize = false
    private var revealLater: DispatchWorkItem?
    private var downPoint: NSPoint?
    private let label = LabelView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(label)
        layer?.cornerCurve = .continuous
    }

    required init?(coder: NSCoder) { fatalError() }

    override var wantsUpdateLayer: Bool { true }

    func configure(_ spec: ImageSpec) {
        let same = self.spec.map { $0.source == spec.source && $0.projectId == spec.projectId && $0.failed == spec.failed && $0.crop == spec.crop } ?? false
        self.spec = spec
        guard !same else {
            if awaitingSize, !spec.placeholder { reveal() }
            return
        }
        alphaValue = 1
        help = spec.label
        load?.cancel()
        awaitingSize = false
        revealLater?.cancel()
        revealLater = nil
        image = ImageLoader.shared.cached(for: spec.source, projectId: spec.projectId)
        if image == nil, !spec.failed {
            load = Task { [weak self] in
                let loaded = await ImageLoader.shared.image(for: spec.source, projectId: spec.projectId)
                guard let self, !Task.isCancelled, self.spec?.source == spec.source, self.spec?.projectId == spec.projectId else { return }
                self.image = loaded
                if let loaded, self.spec?.placeholder == true, !self.fits(loaded.size) {
                    // The row lays out again at the image's size in a moment.
                    self.awaitingSize = true
                    let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.reveal() } }
                    self.revealLater = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
                } else {
                    self.reveal()
                }
            }
        }
        label.isHidden = !spec.failed
        if spec.failed, let style = host?.style {
            label.text = NSAttributedString(string: "􀏅 " + spec.label, attributes: [.font: style.font(12), .foregroundColor: style.color(\.fg3)])
        }
        applyShimmer(layer, on: image == nil && spec.placeholder)
        needsDisplay = true
        needsLayout = true
    }

    /// The box already has [size]'s shape.
    private func fits(_ size: NSSize) -> Bool {
        guard size.width > 0, size.height > 0, bounds.width > 0, bounds.height > 0 else { return true }
        return abs(bounds.width / bounds.height - size.width / size.height) < 0.02 * (size.width / size.height)
    }

    /// Shows the loaded image, faded in over the placeholder.
    private func reveal() {
        awaitingSize = false
        revealLater?.cancel()
        revealLater = nil
        applyShimmer(layer, on: false)
        if image != nil { fadeContents(layer) }
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        label.frame = bounds
        if layer?.mask != nil { applyShimmer(layer, on: true) }
    }

    override func updateLayer() {
        guard let layer, let spec, let style = host?.style else { return }
        if spec.failed {
            layer.contents = nil
            layer.backgroundColor = nil
            layer.borderWidth = 0
            return
        }
        let shown = awaitingSize ? nil : image
        layer.cornerRadius = min(8, style.radii.container)
        layer.masksToBounds = true
        layer.contentsGravity = spec.crop ? .resizeAspectFill : .resizeAspect
        layer.contents = shown
        layer.backgroundColor = shown == nil ? style.blockFill?.cgColor : nil
        layer.borderWidth = shown == nil && style.block == .filled ? 0 : 1
        layer.borderColor = style.color(\.lineSoft).cgColor
    }

    func setHovered(_ on: Bool) {}
    func cursor(at point: NSPoint) -> NSCursor { image != nil ? .pointingHand : .arrow }

    override func mouseDown(with event: NSEvent) { downPoint = convert(event.locationInWindow, from: nil) }

    override func mouseDragged(with event: NSEvent) {
        guard let downPoint, let image else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - downPoint.x, point.y - downPoint.y) > 4 else { return }
        self.downPoint = nil
        let item = NSDraggingItem(pasteboardWriter: image)
        item.setDraggingFrame(bounds, contents: image)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        defer { downPoint = nil }
        guard downPoint != nil, bounds.contains(convert(event.locationInWindow, from: nil)), let spec, let image else { return }
        let origin = ImageViewer.Origin(view: self, cropped: spec.crop, isCurrent: { [weak self] in
            self?.spec?.source == spec.source && self?.spec?.projectId == spec.projectId
        })
        host?.perform(.openImage(.init(image: image, source: spec.source, projectId: spec.projectId, label: spec.label, origin: origin)))
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}

/// A formula's or diagram's snapshot. One that has just landed fades into the room its row held
/// for it; one already seen (a row scrolled back in, laid out again) shows at once.
final class MathImageView: FragmentView {
    /// Snapshots some view has shown.
    private static let seen = NSHashTable<NSImage>.weakObjects()
    private var fades = false

    var image: NSImage? {
        didSet {
            guard image !== oldValue else { return }
            if let image, !Self.seen.contains(image) {
                Self.seen.add(image)
                fades = true
            }
            needsDisplay = true
        }
    }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        if fades, let layer {
            fades = false
            // From nothing, whatever this reused view showed before.
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            fade.duration = 0.2
            layer.add(fade, forKey: "riffet.fadeIn")
        }
        layer?.contentsGravity = .resizeAspect
        layer?.contents = image
    }
}

/// Cross-fades [layer]'s next contents with what it shows now. A dissolve, not motion, so it also
/// stands in for movement under Reduce Motion.
@MainActor
func fadeContents(_ layer: CALayer?, duration: CFTimeInterval = 0.2) {
    guard let layer else { return }
    let transition = CATransition()
    transition.type = .fade
    transition.duration = duration
    layer.add(transition, forKey: "riffet.fade")
}

// MARK: Card, chips, buttons

final class CardView: FragmentView, HoverTarget {
    private var spec: CardSpec?
    private var hovering = false

    func configure(_ spec: CardSpec) {
        if let current = self.spec, current.path == spec.path, current.title == spec.title, current.wide == spec.wide { return }
        self.spec = spec
        hovering = false
        help = String(localized: "打开交互预览：\(spec.title)")
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let spec, let style = host?.style else { return }
        let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: style.radii.card, yRadius: style.radii.card)
        if let fill = hovering ? style.color(\.bgHover) : style.blockFill {
            fill.setFill()
            box.fill()
        }
        style.color(\.lineSoft).setStroke()
        box.stroke()
        let icon = NSRect(x: 12, y: (bounds.height - 34) / 2, width: 34, height: 34)
        if style.block == .filled {
            style.color(\.bgHover).setFill()
            NSBezierPath(roundedRect: icon, xRadius: min(8, style.radii.container), yRadius: min(8, style.radii.container)).fill()
        }
        if let image = symbolImage("rectangle.on.rectangle", size: style.s(15), weight: .medium, color: style.color(\.fg2)) {
            image.drawSymbol(in: NSRect(x: icon.midX - image.size.width / 2, y: icon.midY - image.size.height / 2, width: image.size.width, height: image.size.height), of: self)
        }
        let textX = icon.maxX + 12
        NSAttributedString(string: String(localized: "交互预览"), attributes: [.font: style.font(11, .medium), .foregroundColor: style.color(\.fg3)])
            .drawLine(in: NSRect(x: textX, y: bounds.midY - 17, width: bounds.width - textX - 40, height: 16))
        NSAttributedString(string: spec.title, attributes: [.font: style.font(13, .medium), .foregroundColor: style.color(\.fg)])
            .drawLine(in: NSRect(x: textX, y: bounds.midY, width: bounds.width - textX - 40, height: 18), middle: true)
        if let arrow = symbolImage("arrow.up.right", size: style.s(11), weight: .semibold, color: style.color(\.fg4)) {
            arrow.drawSymbol(in: NSRect(x: bounds.width - 12 - arrow.size.width, y: (bounds.height - arrow.size.height) / 2, width: arrow.size.width, height: arrow.size.height), of: self)
        }
    }


    func setHovered(_ on: Bool) {
        guard hovering != on else { return }
        hovering = on
        needsDisplay = true
    }

    func cursor(at point: NSPoint) -> NSCursor { .pointingHand }

    /// Taken here, or the table would track the click and keep the mouse-up.
    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        guard let spec, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        host?.perform(.openVisualization(path: spec.path, title: spec.title, wide: spec.wide))
    }
}

final class ChipView: FragmentView, HoverTarget {
    private var spec: ChipSpec?

    func configure(_ spec: ChipSpec) {
        if let current = self.spec, current.text == spec.text, current.symbol == spec.symbol, current.help == spec.help {
            self.spec = spec
            return
        }
        self.spec = spec
        help = spec.help
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let spec, let style = host?.style else { return }
        let attachment = spec.action == nil
        let radius = attachment ? min(8, style.radii.container) : style.radii.control
        let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        if let fill = style.blockFill {
            fill.setFill()
            box.fill()
        }
        if !attachment || style.block == .outlined {
            style.color(\.lineSoft).setStroke()
            box.stroke()
        }
        let pad: CGFloat = attachment ? 10 : 7
        let size: CGFloat = attachment ? 12 : 11.5
        var x = pad
        if let icon = symbolImage(spec.symbol, size: style.s(attachment ? 12 : 10), color: style.color(\.fg2)) {
            icon.drawSymbol(in: NSRect(x: x, y: (bounds.height - icon.size.height) / 2, width: icon.size.width, height: icon.size.height), of: self)
            x += icon.size.width + 4
        }
        NSAttributedString(string: spec.text, attributes: [.font: attachment ? style.font(size) : style.mono(size), .foregroundColor: style.color(\.fg2)])
            .drawLine(in: NSRect(x: x, y: 0, width: bounds.width - x - pad, height: bounds.height), middle: true)
    }

    func setHovered(_ on: Bool) {}
    func cursor(at point: NSPoint) -> NSCursor { spec?.action != nil ? .pointingHand : .arrow }

    /// Taken here, or the table would track the click and keep the mouse-up.
    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        guard let action = spec?.action, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        host?.perform(action)
    }
}

/// A quiet chip button (`ChipButtonStyle`), or a spinner while its action runs.
final class ChipButtonView: FragmentView, HoverTarget {
    private var spec: ButtonSpec?
    private var hovering = false
    private var spinner: NSProgressIndicator?

    func configure(_ spec: ButtonSpec) {
        self.spec = spec
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(spec.title)
        setAccessibilityEnabled(!spec.loading)
        hovering = false
        if spec.loading {
            if spinner == nil {
                let indicator = NSProgressIndicator()
                indicator.style = .spinning
                indicator.controlSize = .small
                indicator.usesThreadedAnimation = true
                addSubview(indicator)
                spinner = indicator
            }
            spinner?.isHidden = false
            spinner?.startAnimation(nil)
        } else {
            spinner?.stopAnimation(nil)
            spinner?.isHidden = true
        }
        needsLayout = true
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        spinner?.frame = NSRect(x: (bounds.width - 16) / 2, y: (bounds.height - 16) / 2, width: 16, height: 16)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let spec, !spec.loading, let style = host?.style else { return }
        if spec.compact {
            // A footer's text action: the footer's size and grey, darker under the pointer.
            NSAttributedString(string: spec.title, attributes: [.font: style.font(11), .foregroundColor: hovering ? style.color(\.fg) : style.color(\.fg3)])
                .drawLine(in: bounds.insetBy(dx: 6, dy: 0), optical: true)
            return
        }
        if hovering {
            style.color(\.bgHover).setFill()
            let radius = min(8, style.radii.container)
            NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        }
        NSAttributedString(string: spec.title, attributes: [.font: style.font(12.5), .foregroundColor: hovering ? style.color(\.fg) : style.color(\.fg2)])
            .drawLine(in: bounds.insetBy(dx: 12, dy: 0), optical: true)
    }


    func setHovered(_ on: Bool) {
        guard hovering != on else { return }
        hovering = on
        needsDisplay = true
    }

    func cursor(at point: NSPoint) -> NSCursor { spec?.loading == false ? .pointingHand : .arrow }

    override func accessibilityPerformPress() -> Bool {
        guard let spec, !spec.loading, let action = spec.action else { return false }
        host?.perform(action)
        return true
    }

    /// Taken here, or the table would track the click and keep the mouse-up.
    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        guard let spec, !spec.loading, let action = spec.action, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        host?.perform(action)
    }
}

// MARK: Working line

/// "正在处理", how long the turn has run and the recent rolling output speed (`WorkingIndicator`).
final class WorkingView: FragmentView, HoverTarget {
    private var spec: WorkingSpec?
    private let dot = BoxView()
    private let label = LabelView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(dot)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Nil leaves the view empty: a held footer slot whose row does not show the working line.
    func configure(_ spec: WorkingSpec?) {
        self.spec = spec
        isHidden = spec == nil
        guard let spec else { return }
        help = [spec.step, spec.speed?.description_].compactMap { $0 }.joined(separator: "\n")
        guard let style = host?.style else { return }
        if let background = spec.background {
            // Delegated work still runs after the turn: a static dot and an unshimmered label.
            dot.layer?.removeAnimation(forKey: "pulse")
            dot.configure(BoxSpec(fill: style.color(\.fg4), radius: 3.5))
            label.text = NSAttributedString(string: background, attributes: [.font: labelFont(style), .foregroundColor: style.color(\.fg3)])
            setAccessibilityElement(true)
            setAccessibilityRole(.button)
            setAccessibilityLabel(background)
            needsLayout = true
            needsDisplay = true
            return
        }
        setAccessibilityElement(false)
        dot.configure(BoxSpec(fill: style.color(style.mark), radius: 3.5))
        label.text = NSAttributedString(string: spec.stopping ? String(localized: "停止中") : String(localized: "正在处理"), attributes: [.font: labelFont(style), .foregroundColor: style.color(\.fg2)])
        if dot.layer?.animation(forKey: "pulse") == nil, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1
            pulse.toValue = 0.35
            pulse.duration = 0.9
            pulse.autoreverses = true
            // motion-loop: running dot, skipped under Reduce Motion
            pulse.repeatCount = .infinity
            dot.layer?.add(pulse, forKey: "pulse")
        }
        needsLayout = true
        needsDisplay = true
    }

    func tick() { needsDisplay = true }

    private func labelFont(_ style: TranscriptStyle) -> NSFont { style.font(13, .medium) }

    func setHovered(_ on: Bool) {}

    func cursor(at point: NSPoint) -> NSCursor { spec?.background != nil ? .pointingHand : .arrow }

    override func accessibilityPerformPress() -> Bool {
        guard spec?.background != nil else { return false }
        host?.perform(.openSessionInfo)
        return true
    }

    /// Taken here, or the table would track the click and keep the mouse-up.
    override func mouseDown(with event: NSEvent) {
        if spec?.background == nil { super.mouseDown(with: event) }
    }

    override func mouseUp(with event: NSEvent) {
        guard spec?.background != nil, bounds.contains(convert(event.locationInWindow, from: nil)) else { return super.mouseUp(with: event) }
        host?.perform(.openSessionInfo)
    }

    private var labelWidth: CGFloat { ceil(label.text.lineWidth) }

    override func layout() {
        super.layout()
        dot.frame = NSRect(x: 4.5, y: (bounds.height - 7) / 2, width: 7, height: 7)
        label.frame = NSRect(x: 24, y: 0, width: labelWidth, height: bounds.height)
        applyShimmer(label.layer, on: spec?.background == nil)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let spec, spec.background == nil, let style = host?.style else { return }
        var x = 24 + labelWidth + 8
        let font = NSFont.riffetDigits(size: style.s(12))
        if let since = spec.since {
            let seconds = max(0, Int(Date().timeIntervalSince(since)))
            if seconds > 0 {
                let value = NSAttributedString(string: seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s", attributes: [.font: font, .foregroundColor: style.color(\.fg3)])
                let width = ceil(value.lineWidth)
                value.drawLine(in: NSRect(x: x, y: 0, width: width, height: bounds.height))
                x += width + 8
            }
        }
        if let speed = spec.speed {
            NSAttributedString(string: speed.label, attributes: [.font: font, .foregroundColor: speed.estimated ? style.color(\.fg4) : style.color(\.fg3)])
                .drawLine(in: NSRect(x: x, y: 0, width: max(0, bounds.width - x), height: bounds.height))
        }
    }
}
