import AppKit

/// A line of text under an answer to continue from it in a fork of its own; sent empty it is a plain fork. A real text view in
/// screen space, never under the surface's transform, so it stays sharp at any zoom. Return sends, Shift-Return breaks the line,
/// Escape (or a press away, which the controller watches) closes it.
final class CanvasForkDraftView: NSView, NSTextViewDelegate {
    private let scroll = NSScrollView()
    private let text = DraftTextView()
    private let send = NSButton()
    private var colors: (background: NSColor, ink: NSColor, hint: NSColor, primary: NSColor, onPrimary: NSColor)?

    var onChange: ((String) -> Void)?
    var onSend: ((String) -> Void)?
    var onClose: (() -> Void)?
    /// The height the text wants changed: the controller sizes and places the view.
    var onResize: (() -> Void)?

    private static let lineHeight: CGFloat = 20
    private static let maxHeight: CGFloat = 6 * 20 + 8

    override var isFlipped: Bool { true }

    init(initial: String, placeholder: String, accessibility: String) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.cornerCurve = .continuous
        shadow = {
            let s = NSShadow()
            s.shadowColor = NSColor.black.withAlphaComponent(0.18)
            s.shadowBlurRadius = 12
            s.shadowOffset = NSSize(width: 0, height: -3)
            return s
        }()
        layer?.masksToBounds = false

        text.string = initial
        text.placeholder = placeholder
        text.delegate = self
        text.isRichText = false
        text.drawsBackground = false
        text.allowsUndo = true
        text.font = .systemFont(ofSize: 13)
        text.textContainerInset = NSSize(width: 0, height: 4)
        text.textContainer?.lineFragmentPadding = 0
        text.textContainer?.widthTracksTextView = true
        text.isVerticallyResizable = true
        text.setAccessibilityLabel(accessibility)
        text.onCancel = { [weak self] in self?.onClose?() }
        scroll.documentView = text
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.autohidesScrollers = true
        addSubview(scroll)

        send.isBordered = false
        send.imagePosition = .imageOnly
        send.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: accessibility)?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        send.wantsLayer = true
        send.layer?.cornerRadius = 7
        send.layer?.cornerCurve = .continuous
        send.target = self
        send.action = #selector(submit)
        addSubview(send)
    }
    required init?(coder: NSCoder) { fatalError() }

    func apply(background: NSColor, ink: NSColor, hint: NSColor, primary: NSColor, onPrimary: NSColor) {
        colors = (background, ink, hint, primary, onPrimary)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = background.cgColor
            send.layer?.backgroundColor = primary.cgColor
        }
        send.contentTintColor = onPrimary
        text.textColor = ink
        text.hint = hint
        text.insertionPointColor = ink
        needsDisplay = true
    }

    func focus() {
        window?.makeFirstResponder(text)
        text.setSelectedRange(NSRange(location: (text.string as NSString).length, length: 0))
    }

    var content: String { text.string }

    /// The height at [width]: up to six lines of text, then it scrolls.
    func height(for width: CGFloat) -> CGFloat {
        let inner = max(40, width - 12 - 6 - 24 - 6)
        text.textContainer?.containerSize = NSSize(width: inner, height: .greatestFiniteMagnitude)
        text.layoutManager?.ensureLayout(for: text.textContainer!)
        let used = text.layoutManager?.usedRect(for: text.textContainer!).height ?? Self.lineHeight
        let body = min(max(used, Self.lineHeight) + 8, Self.maxHeight)
        return body + 12
    }

    override func layout() {
        super.layout()
        let body = bounds.height - 12
        scroll.frame = NSRect(x: 12, y: 6, width: bounds.width - 12 - 6 - 24 - 6, height: body)
        text.frame.size.width = scroll.contentSize.width
        send.frame = NSRect(x: bounds.width - 6 - 24, y: bounds.height - 6 - 24, width: 24, height: 24)
        scroll.hasVerticalScroller = text.layoutManager.map { $0.usedRect(for: text.textContainer!).height + 8 > Self.maxHeight } ?? false
    }

    func textDidChange(_ notification: Notification) {
        onChange?(text.string)
        onResize?()
    }

    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
        // A line break with Shift or Option; a bare Return sends. (Return that commits an IME candidate never gets here.)
        if NSApp.currentEvent?.modifierFlags.intersection([.shift, .option]).isEmpty == false { return false }
        submit()
        return true
    }

    @objc private func submit() { onSend?(text.string.trimmingCharacters(in: .whitespacesAndNewlines)) }

    private final class DraftTextView: NSTextView {
        var placeholder = ""
        var hint: NSColor = .secondaryLabelColor
        var onCancel: (() -> Void)?

        override func cancelOperation(_ sender: Any?) { onCancel?() }

        override func draw(_ dirtyRect: NSRect) {
            super.draw(dirtyRect)
            guard string.isEmpty, !hasMarkedText() else { return }
            (placeholder as NSString).draw(at: NSPoint(x: textContainerInset.width, y: textContainerInset.height), withAttributes: [.font: font ?? .systemFont(ofSize: 13), .foregroundColor: hint])
        }
    }
}
