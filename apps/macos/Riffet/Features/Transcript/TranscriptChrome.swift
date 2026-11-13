import AppKit
import QuartzCore
import RiffetKit

/// What floats over the transcript (the turn rail and its preview, the back-to-bottom button, the
/// reading-width handle), in AppKit above the list. As SwiftUI overlays on the hosted list they
/// could draw under its rows and lose clicks to them.

/// A tick per user message on the transcript's right edge (the web's `TurnRail`): the current turn
/// is the long tick, hovering one previews the message, clicking jumps to it.
final class TurnRailView: NSView {
    var turns: [TurnTick] = [] {
        didSet {
            guard turns != oldValue else { return }
            hovered = nil
            preview?.hide()
            needsDisplay = true
        }
    }
    var active = 0 { didSet { if active != oldValue { needsDisplay = true } } }
    var style: TranscriptStyle? { didSet { needsDisplay = true } }
    /// Dots instead of lines (the reader's 导航条样式).
    var dots = false { didSet { if dots != oldValue { needsDisplay = true } } }
    var onJump: ((TurnTick) -> Void)?
    weak var preview: TurnPreviewView?
    private var hovered: Int?

    static let step: CGFloat = 10
    static let padding: CGFloat = 8

    private(set) var shown = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        alphaValue = 0
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Fades in once there are turns to move between, and out when there are not; [animated] is off
    /// while the transcript is not on screen yet.
    func setShown(_ on: Bool, animated: Bool) {
        guard on != shown else { return }
        shown = on
        guard animated else {
            alphaValue = on ? 1 : 0
            isHidden = !on
            return
        }
        if on { isHidden = false }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            animator().alphaValue = on ? 1 : 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated { if self?.shown == false { self?.isHidden = true } }
        }
    }

    override var isFlipped: Bool { true }

    var preferredHeight: CGFloat { CGFloat(turns.count) * Self.step + Self.padding * 2 }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    private func index(at point: NSPoint) -> Int? {
        let index = Int((point.y - Self.padding) / Self.step)
        return turns.indices.contains(index) ? index : nil
    }

    override func mouseMoved(with event: NSEvent) { hover(index(at: convert(event.locationInWindow, from: nil))) }
    override func mouseEntered(with event: NSEvent) { hover(index(at: convert(event.locationInWindow, from: nil))) }
    override func mouseExited(with event: NSEvent) { hover(nil) }

    private func hover(_ index: Int?) {
        guard index != hovered else { return }
        hovered = index
        needsDisplay = true
        guard let index, let preview, let superview = preview.superview else {
            preview?.hide()
            return
        }
        let y = Self.padding + CGFloat(index) * Self.step + Self.step / 2
        let anchor = superview.convert(NSPoint(x: bounds.minX - 8, y: y), from: self)
        preview.show(turns[index], rightEdge: anchor.x, centerY: anchor.y)
    }

    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        guard let index = index(at: convert(event.locationInWindow, from: nil)) else { return }
        onJump?(turns[index])
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let style else { return }
        for index in turns.indices {
            let color = index == active ? style.color(\.fg2) : index == hovered ? style.color(\.fg3) : style.color(\.fg4, 0.55)
            color.setFill()
            let slot = Self.padding + CGFloat(index) * Self.step
            if dots {
                // A dot grows about one axis, so the column stays straight.
                let diameter: CGFloat = index == active ? 6 : index == hovered ? 5 : 4
                NSBezierPath(ovalIn: NSRect(x: bounds.width - 3 - diameter / 2, y: slot + (Self.step - diameter) / 2, width: diameter, height: diameter)).fill()
            } else {
                let width: CGFloat = index == active ? 20 : index == hovered ? 12 : 7
                NSBezierPath(roundedRect: NSRect(x: bounds.width - width, y: slot + (Self.step - 2) / 2, width: width, height: 2), xRadius: 1, yRadius: 1).fill()
            }
        }
    }
}

/// Clips an answer's floating navigation to the transcript without intercepting its empty space.
final class ChapterNavigationClipView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }
}

/// One answer's main headings, bounded by its prose. Narrow gutters retain just dots.
final class ChapterNavigationView: NSView {
    var titles: [String] = [] {
        didSet {
            guard titles != oldValue else { return }
            preview?.close()
            while buttons.count > titles.count { buttons.removeLast().removeFromSuperview() }
            for (index, title) in titles.enumerated() {
                if buttons.indices.contains(index) {
                    buttons[index].title = title
                    buttons[index].toolTip = title
                    buttons[index].setAccessibilityLabel(title)
                    continue
                }
                let button = ChapterButton(title: title, target: self, action: #selector(jump(_:)))
                button.tag = index
                button.isBordered = false
                button.setButtonType(.momentaryChange)
                button.focusRingType = .none
                button.toolTip = title
                button.setAccessibilityLabel(title)
                button.onFocus = { [weak self, weak button] in
                    guard let self, let button else { return }
                    // AppKit commits firstResponder after the focus callback returns.
                    DispatchQueue.main.async { [weak self] in self?.updateEmphasis() }
                    if self.compact { self.showTitle(of: button) }
                }
                button.onBlur = { [weak self] in
                    self?.preview?.close()
                    DispatchQueue.main.async { [weak self] in self?.updateEmphasis() }
                }
                button.onStep = { [weak self] delta in self?.step(from: index, by: delta) }
                document.addSubview(button)
                buttons.append(button)
            }
            refresh()
            needsLayout = true
            layoutSubtreeIfNeeded()
        }
    }
    var active = 0 {
        didSet {
            guard active != oldValue else { return }
            refresh()
            revealActive()
        }
    }
    var compact = false { didSet { if compact != oldValue { preview?.close(); refresh() } } }
    var style: TranscriptStyle? { didSet { refresh() } }
    var onJump: ((Int) -> Void)?
    var onVisibilityChange: (() -> Void)?
    var onHoverChange: (() -> Void)?
    private(set) var ownerKey: String?
    private(set) var exiting = false
    var emphasized = false { didSet { if emphasized != oldValue { updateEmphasis() } } }

    private struct Presentation {
        let owner: String
        let titles: [String]
        let active: Int
        let frame: NSRect
        let compact: Bool
    }
    private var pending: Presentation?
    private var transition = 0
    private var tracking: NSTrackingArea?
    private var pointerInside = false

    private let scroll = NSScrollView()
    private let document = FlippedView()
    private var buttons: [ChapterButton] = []
    private var preview: NSPopover?
    private static let step: CGFloat = 24

    override init(frame: NSRect) {
        super.init(frame: frame)
        isHidden = true
        alphaValue = 0
        wantsLayer = true
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.horizontalScrollElasticity = .none
        scroll.documentView = document
        addSubview(scroll)
    }

    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    var preferredHeight: CGFloat { CGFloat(titles.count) * Self.step }

    /// A new owner leaves before the next one enters, so this reads as an answer attachment.
    func present(owner: String, titles: [String], active: Int, frame: NSRect, compact: Bool) {
        let next = Presentation(owner: owner, titles: titles, active: active, frame: frame, compact: compact)
        pending = next
        if ownerKey == owner {
            if exiting {
                transition += 1
                exiting = false
                layer?.removeAllAnimations()
                buttons.forEach { $0.isEnabled = true }
                alphaValue = emphasisAlpha
            }
            apply(next)
        } else if isHidden {
            showPending()
        } else {
            beginExit()
        }
    }

    func dismiss(immediately: Bool = false) {
        pending = nil
        if immediately {
            transition += 1
            finishExit()
        } else {
            beginExit()
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        exiting ? nil : super.hitTest(point)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }
    override func mouseEntered(with event: NSEvent) { pointerInside = true; onHoverChange?() }
    override func mouseMoved(with event: NSEvent) { pointerInside = true; onHoverChange?() }
    override func mouseExited(with event: NSEvent) { pointerInside = false; onHoverChange?() }

    private var emphasisAlpha: CGFloat {
        let focused = (window?.firstResponder as? NSView)?.isDescendant(of: self) == true
        return emphasized || focused ? 1 : 0.62
    }

    private func updateEmphasis() {
        guard !isHidden, !exiting else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            animator().alphaValue = emphasisAlpha
        }
    }

    private func apply(_ value: Presentation) {
        if frame != value.frame {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                frame = value.frame
            }
        }
        titles = value.titles
        active = value.active
        compact = value.compact
    }

    private func showPending() {
        guard let next = pending else { return }
        transition += 1
        ownerKey = next.owner
        exiting = false
        apply(next)
        layoutSubtreeIfNeeded()
        revealActive(force: true)
        buttons.forEach { $0.isEnabled = true }
        isHidden = false
        onVisibilityChange?()
        alphaValue = 0
        let duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.1 : 0.15
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            animator().alphaValue = emphasisAlpha
        }
    }

    private func beginExit() {
        guard !isHidden, !exiting else { return }
        exiting = true
        preview?.close()
        buttons.forEach { $0.isEnabled = false }
        if let focused = window?.firstResponder as? NSView, focused.isDescendant(of: self) {
            window?.makeFirstResponder(nil)
        }
        transition += 1
        let token = transition
        NSAnimationContext.runAnimationGroup { context in
            context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.1 : 0.15
            animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.transition == token else { return }
                self.finishExit()
                self.showPending()
            }
        }
    }

    private func finishExit() {
        exiting = true
        preview?.close()
        buttons.forEach { $0.isEnabled = false }
        if let focused = window?.firstResponder as? NSView, focused.isDescendant(of: self) {
            window?.makeFirstResponder(nil)
        }
        isHidden = true
        alphaValue = 0
        ownerKey = nil
        exiting = false
        pointerInside = false
        layer?.removeAllAnimations()
        onVisibilityChange?()
    }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        document.frame = NSRect(x: 0, y: 0, width: bounds.width, height: preferredHeight)
        for (index, button) in buttons.enumerated() {
            button.frame = NSRect(x: 0, y: CGFloat(index) * Self.step, width: bounds.width, height: Self.step)
        }
    }

    private func refresh() {
        for (index, button) in buttons.enumerated() {
            button.style = style
            button.compact = compact
            button.current = index == active
            button.setAccessibilityValue(index == active ? 1 : 0)
            button.needsDisplay = true
        }
    }

    private func revealActive(force: Bool = false) {
        let focused = (window?.firstResponder as? NSView)?.isDescendant(of: self) == true
        guard buttons.indices.contains(active), force || !pointerInside && !focused else { return }
        document.scrollToVisible(buttons[active].frame)
    }

    @objc private func jump(_ sender: NSButton) { if !exiting { onJump?(sender.tag) } }

    private func step(from index: Int, by delta: Int) {
        guard !exiting else { return }
        let next = min(max(0, index + delta), buttons.count - 1)
        guard buttons.indices.contains(next) else { return }
        document.scrollToVisible(buttons[next].frame)
        window?.makeFirstResponder(buttons[next])
        onJump?(next)
    }

    private func showTitle(of button: NSButton) {
        preview?.close()
        let label = NSTextField(wrappingLabelWithString: button.title)
        label.font = style?.font(12)
        label.textColor = style?.color(\.fg)
        label.maximumNumberOfLines = 3
        let size = label.sizeThatFits(NSSize(width: 240, height: 100))
        let controller = NSViewController()
        controller.view = FlippedView(frame: NSRect(x: 0, y: 0, width: ceil(size.width) + 20, height: ceil(size.height) + 16))
        label.frame = NSRect(x: 10, y: 8, width: ceil(size.width), height: ceil(size.height))
        controller.view.addSubview(label)
        let popover = NSPopover()
        popover.behavior = .transient
        popover.animates = false
        popover.contentViewController = controller
        preview = popover
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxX)
    }

    private final class ChapterButton: NSButton {
        override var isFlipped: Bool { true }
        override var acceptsFirstResponder: Bool { isEnabled }

        var style: TranscriptStyle?
        var compact = false
        var current = false
        var onFocus: (() -> Void)?
        var onBlur: (() -> Void)?
        var onStep: ((Int) -> Void)?

        override func draw(_ dirtyRect: NSRect) {
            guard let style, let context = NSGraphicsContext.current?.cgContext else { return }
            context.saveGState()
            context.clip(to: bounds)
            defer { context.restoreGState() }
            let focused = window?.firstResponder === self
            let color = current || focused ? style.color(\.fg2) : style.color(\.fg4)
            if compact {
                color.setFill()
                let diameter: CGFloat = current ? 6 : 4
                NSBezierPath(ovalIn: NSRect(x: (bounds.width - diameter) / 2, y: (bounds.height - diameter) / 2, width: diameter, height: diameter)).fill()
            } else {
                let font = style.font(12, current ? .medium : .regular)
                NSAttributedString(string: title, attributes: [.font: font, .foregroundColor: color])
                    .drawLine(in: bounds.insetBy(dx: 6, dy: 0))
            }
            if focused {
                NSColor.keyboardFocusIndicatorColor.setStroke()
                let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 2), xRadius: 4, yRadius: 4)
                ring.lineWidth = 1
                ring.stroke()
            }
        }

        override func becomeFirstResponder() -> Bool {
            guard super.becomeFirstResponder() else { return false }
            needsDisplay = true
            onFocus?()
            return true
        }

        override func resignFirstResponder() -> Bool {
            guard super.resignFirstResponder() else { return false }
            needsDisplay = true
            onBlur?()
            return true
        }

        override func keyDown(with event: NSEvent) {
            if event.keyCode == 125 || event.keyCode == 126 { onStep?(event.keyCode == 125 ? 1 : -1) }
            else { super.keyDown(with: event) }
        }
    }
}

/// The message a hovered tick stands for: two lines at most, then its time.
final class TurnPreviewView: NSView {
    private let text = NSTextField(wrappingLabelWithString: "")
    private let time = NSTextField(labelWithString: "")
    var style: TranscriptStyle? { didSet { needsDisplay = true } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        isHidden = true
        text.maximumNumberOfLines = 2
        text.lineBreakMode = .byTruncatingTail
        text.cell?.truncatesLastVisibleLine = true
        addSubview(text)
        addSubview(time)
        applyElevation()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func applyElevation() {
        guard let layer else { return }
        Elevation.pop.apply(to: layer, dark: effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
    }

    override func updateLayer() {
        applyElevation()
        guard let style, let layer else { return }
        layer.backgroundColor = style.color(\.bgPopover).cgColor
        layer.borderColor = style.color(\.line).cgColor
        layer.borderWidth = 1
        layer.cornerRadius = style.radii.container
        layer.cornerCurve = .continuous
    }

    func show(_ tick: TurnTick, rightEdge: CGFloat, centerY: CGFloat) {
        guard let style else { return }
        text.font = style.font(12.5)
        text.textColor = style.color(\.fg)
        text.stringValue = tick.preview
        let stamp = formatDateTime(value: tick.time)
        time.font = NSFont.monospacedDigitSystemFont(ofSize: style.s(11), weight: .regular)
        time.textColor = style.color(\.fg4)
        time.stringValue = stamp ?? ""
        time.isHidden = stamp == nil
        let maxText: CGFloat = 256
        text.preferredMaxLayoutWidth = maxText
        let textSize = text.sizeThatFits(NSSize(width: maxText, height: 200))
        let timeSize = time.isHidden ? .zero : time.sizeThatFits(NSSize(width: maxText, height: 40))
        let width = ceil(max(textSize.width, timeSize.width)) + 24
        let height = ceil(textSize.height + (time.isHidden ? 0 : timeSize.height + 4)) + 18
        text.frame = NSRect(x: 12, y: 9, width: width - 24, height: ceil(textSize.height))
        time.frame = NSRect(x: 12, y: 9 + ceil(textSize.height) + 4, width: width - 24, height: ceil(timeSize.height))
        var origin = NSPoint(x: rightEdge - width, y: centerY - height / 2)
        if let superview { origin.y = min(max(8, origin.y), superview.bounds.height - height - 8) }
        frame = NSRect(origin: origin, size: NSSize(width: width, height: height))
        needsDisplay = true
        isHidden = false
    }

    func hide() { isHidden = true }
}

/// Back to the latest output; shown while the reader is scrolled away from it.
final class BackToBottomView: NSView {
    var style: TranscriptStyle? { didSet { needsDisplay = true; refreshImage() } }
    var onClick: (() -> Void)?
    private let image = NSImageView()
    private(set) var shown = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        alphaValue = 0
        isHidden = true
        image.imageScaling = .scaleNone
        addSubview(image)
        applyElevation()
        toolTip = String(localized: "回到底部 (⌘↓)")
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(String(localized: "回到底部"))
    }

    required init?(coder: NSCoder) { fatalError() }

    override var wantsUpdateLayer: Bool { true }

    private func refreshImage() {
        guard let style else { return }
        image.image = symbolImage("arrow.down", size: style.s(12.5), weight: .medium, color: style.color(\.fg2))
    }

    private func applyElevation() {
        guard let layer else { return }
        Elevation.pop.apply(to: layer, dark: effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
    }

    override func updateLayer() {
        applyElevation()
        guard let style, let layer else { return }
        layer.backgroundColor = style.color(\.bgElevated).cgColor
        layer.borderColor = style.color(\.lineStrong).cgColor
        layer.borderWidth = 1
        layer.cornerRadius = bounds.height / 2
    }

    override func layout() {
        super.layout()
        image.frame = bounds
    }

    func setShown(_ on: Bool) {
        guard on != shown else { return }
        shown = on
        if on { isHidden = false }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            animator().alphaValue = on ? 1 : 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated { if self?.shown == false { self?.isHidden = true } }
        }
    }

    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
    }

    override func accessibilityPerformPress() -> Bool {
        onClick?()
        return true
    }
}

/// Drags the reading column wider or narrower (`ContentWidthHandle.tsx`), 640–1600pt; a double-click
/// restores the default.
final class WidthHandleView: NSView {
    var style: TranscriptStyle? { didSet { needsDisplay = true } }
    private var hovering = false
    private var start: (x: CGFloat, width: Double)?

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        toolTip = String(localized: "拖动调整正文宽度，双击恢复默认")
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect, .cursorUpdate], owner: self))
    }

    override func cursorUpdate(with event: NSEvent) { NSCursor.resizeLeftRight.set() }
    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        guard let style, hovering || start != nil else { return }
        (start != nil ? style.color(style.mark) : style.color(\.lineStrong)).setFill()
        NSBezierPath(roundedRect: NSRect(x: (bounds.width - 3) / 2, y: (bounds.height - 44) / 2, width: 3, height: 44), xRadius: 1.5, yRadius: 1.5).fill()
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            MainActor.assumeIsolated { DisplayPreferences.shared.contentWidth = DisplayPreferences.defaultContentWidth }
            return
        }
        start = (event.locationInWindow.x, MainActor.assumeIsolated { DisplayPreferences.shared.contentWidth })
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let width = min(1600, max(640, start.width + Double(event.locationInWindow.x - start.x) * 2))
        MainActor.assumeIsolated { DisplayPreferences.shared.contentWidth = width }
    }

    override func mouseUp(with event: NSEvent) {
        start = nil
        needsDisplay = true
    }
}
