import AppKit
import SwiftUI

/// The browser's frames, aspect-fit, and the user's pointer, wheel and keys passed back to the page. Printable text
/// goes through the input system (`NSTextInputClient`), so input methods and keyboard layouts are the Mac's own.
struct BrowserCanvas: NSViewRepresentable {
    let live: BrowserLive
    let image: CGImage?
    let viewport: CGSize

    func makeNSView(context: Context) -> BrowserCanvasView { BrowserCanvasView() }

    func updateNSView(_ view: BrowserCanvasView, context: Context) {
        view.live = live
        view.viewport = viewport
        if view.image !== image { view.image = image }
    }
}

final class BrowserCanvasView: NSView, NSTextInputClient {
    var live: BrowserLive?
    var viewport = CGSize(width: 1280, height: 800)
    var image: CGImage? { didSet { layer?.contents = image } }
    private var marked: String?

    /// Keys the page gets as key events, by virtual key code; everything else is text.
    private static let namedKeys: [UInt16: String] = [
        36: "Enter", 76: "Enter", 51: "Backspace", 117: "Delete", 48: "Tab", 53: "Escape",
        123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp", 115: "Home", 119: "End", 116: "PageUp", 121: "PageDown",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
    ]

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.contentsGravity = .resizeAspect
        layerContentsRedrawPolicy = .never
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    /// The point on the page, in viewport CSS pixels, or nil outside the drawn frame.
    private func pagePoint(_ event: NSEvent) -> CGPoint? {
        guard viewport.width > 0, viewport.height > 0, bounds.width > 0, bounds.height > 0 else { return nil }
        let scale = min(bounds.width / viewport.width, bounds.height / viewport.height)
        let size = CGSize(width: viewport.width * scale, height: viewport.height * scale)
        let origin = CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2)
        let point = convert(event.locationInWindow, from: nil)
        guard CGRect(origin: origin, size: size).insetBy(dx: -2, dy: -2).contains(point) else { return nil }
        return CGPoint(x: ((point.x - origin.x) / scale).rounded(), y: ((point.y - origin.y) / scale).rounded())
    }

    private func pointer(_ action: String, _ event: NSEvent, button: String) {
        guard let point = pagePoint(event) else { return }
        live?.mouse(action, at: point, button: button, clickCount: event.clickCount, modifiers: BrowserModifiers(event.modifierFlags))
    }

    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self); pointer("down", event, button: "left") }
    override func mouseUp(with event: NSEvent) { pointer("up", event, button: "left") }
    override func mouseDragged(with event: NSEvent) { pointer("move", event, button: "left") }
    override func rightMouseDown(with event: NSEvent) { window?.makeFirstResponder(self); pointer("down", event, button: "right") }
    override func rightMouseUp(with event: NSEvent) { pointer("up", event, button: "right") }
    override func otherMouseDown(with event: NSEvent) { pointer("down", event, button: "middle") }
    override func otherMouseUp(with event: NSEvent) { pointer("up", event, button: "middle") }
    // Hovering is not taking over: a bare move counts only once the user already has control.
    override func mouseMoved(with event: NSEvent) { pointer("move", event, button: "left") }

    override func scrollWheel(with event: NSEvent) {
        guard let point = pagePoint(event) else { return }
        let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 40
        live?.wheel(at: point, deltaX: -event.scrollingDeltaX * scale, deltaY: -event.scrollingDeltaY * scale)
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if marked == nil, let name = Self.namedKeys[event.keyCode] {
            live?.key("down", key: name, code: nil, modifiers: BrowserModifiers(flags))
        } else if flags.contains(.command) || flags.contains(.control), let key = event.charactersIgnoringModifiers, key.count == 1 {
            live?.key("down", key: key, code: nil, modifiers: BrowserModifiers(flags))
        } else {
            interpretKeyEvents([event])
        }
    }

    override func keyUp(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if marked == nil, let name = Self.namedKeys[event.keyCode] {
            live?.key("up", key: name, code: nil, modifiers: BrowserModifiers(flags))
        } else if flags.contains(.command) || flags.contains(.control), let key = event.charactersIgnoringModifiers, key.count == 1 {
            live?.key("up", key: key, code: nil, modifiers: BrowserModifiers(flags))
        }
    }

    /// ⌘V reaches the view through the Edit menu: the Mac's clipboard is pasted as text.
    @objc func paste(_ sender: Any?) {
        if let text = NSPasteboard.general.string(forType: .string) { live?.text(text) }
    }

    @objc override func selectAll(_ sender: Any?) {
        live?.key("down", key: "a", code: nil, modifiers: BrowserModifiers([.command]))
        live?.key("up", key: "a", code: nil, modifiers: BrowserModifiers([.command]))
    }

    // MARK: NSTextInputClient

    func insertText(_ string: Any, replacementRange: NSRange) {
        marked = nil
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        live?.text(text)
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        marked = text.isEmpty ? nil : text
    }

    func unmarkText() { marked = nil }
    func selectedRange() -> NSRange { NSRange(location: 0, length: 0) }
    func markedRange() -> NSRange { marked.map { NSRange(location: 0, length: ($0 as NSString).length) } ?? NSRange(location: NSNotFound, length: 0) }
    func hasMarkedText() -> Bool { marked != nil }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func characterIndex(for point: NSPoint) -> Int { 0 }
    override func doCommand(by selector: Selector) {}

    /// The candidate window opens at the bottom left of the frame: the page's caret is not known here.
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let window else { return .zero }
        return window.convertToScreen(convert(NSRect(x: bounds.minX + 12, y: bounds.maxY - 24, width: 1, height: 20), to: nil))
    }
}
