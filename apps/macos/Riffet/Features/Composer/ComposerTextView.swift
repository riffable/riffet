import AppKit
import SwiftUI

/// The keys a composer menu (`/` commands, `@` files) takes while it is open.
enum ComposerKey {
    case up, down, accept, dismiss
}

/// The composer's text area: an `NSTextView` that grows with its content between [minHeight] and
/// [maxHeight]. ⌘↩ sends and ⇧⌘↩ interrupts-and-sends; a plain Return sends only when the reader
/// chose that in settings (`composerEnterBehavior`), and ⇧↩/⌥↩ always add a line. Nothing is sent
/// while the input method still has marked (uncommitted) text. Pasting files or an image hands them
/// to [onPasteFiles] and keeps any text that came along.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    /// The caret as a UTF-16 offset, reported on every selection change.
    @Binding var caret: Int
    var focusToken: Int = 0
    /// A caret placement requested from outside (after a menu pick), applied when this changes.
    var caretRequest: CaretRequest?
    var enterSends = false
    var fontSize: CGFloat = 14
    /// The plugin and style fonts in effect: a change lays the text out again.
    private var fontKey: String { "\(AppearanceFonts.current.key)|\(DisplayPreferences.shared.style.fonts)" }
    /// How a height change typing did not cause animates (a send clearing the draft, a restored or
    /// quoted one). Typing resizes at once, in the same pass as the text it adds.
    var resize: Animation?
    var onSubmit: (_ interrupt: Bool) -> Void
    var onPasteFiles: (NSPasteboard) -> Bool
    /// Menu navigation; returns whether the key was taken.
    var onKey: (ComposerKey) -> Bool = { _ in false }
    /// Whether the input method holds uncommitted text, which [text] leaves out until it commits.
    var onComposing: (Bool) -> Void = { _ in }

    struct CaretRequest: Equatable {
        let offset: Int
        let token: Int
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = SubmitTextView()
        textView.coordinator = context.coordinator
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.textColor = .labelColor
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 0, height: 2)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        context.coordinator.applyFont(textView, size: fontSize)
        textView.string = text

        let scroll = PassthroughScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        scroll.documentView = textView
        context.coordinator.textView = textView
        context.coordinator.report(animation: nil)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let textView = coordinator.textView else { return }
        if coordinator.fontSize != fontSize || coordinator.fontKey != fontKey {
            coordinator.applyFont(textView, size: fontSize)
            coordinator.report(animation: nil)
        }
        if textView.string != text, !textView.hasMarkedText() {
            textView.string = text
            coordinator.report(animation: resize)
        }
        if let caretRequest, coordinator.caretToken != caretRequest.token {
            coordinator.caretToken = caretRequest.token
            let offset = min(caretRequest.offset, (textView.string as NSString).length)
            textView.setSelectedRange(NSRange(location: offset, length: 0))
            textView.scrollRangeToVisible(NSRange(location: offset, length: 0))
        }
        if coordinator.focusToken != focusToken {
            coordinator.focusToken = focusToken
            // One built while its conversation is covered waits: the page asks again when it is back.
            guard !context.environment.covered else { return }
            textView.wantsFocus = true
            DispatchQueue.main.async { textView.takeFocusIfWanted() }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        weak var textView: SubmitTextView?
        var focusToken = -1
        var caretToken = -1
        var fontSize: CGFloat = 0
        var fontKey = ""

        init(_ parent: ComposerTextView) { self.parent = parent }

        @MainActor func applyFont(_ textView: NSTextView, size: CGFloat) {
            fontSize = size
            fontKey = parent.fontKey
            let font = NSFont.riffet(size: size)
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 4
            textView.font = font
            textView.defaultParagraphStyle = paragraph
            textView.typingAttributes = [.font: font, .paragraphStyle: paragraph, .foregroundColor: NSColor.labelColor]
            if let storage = textView.textStorage {
                storage.addAttributes([.font: font, .paragraphStyle: paragraph], range: NSRange(location: 0, length: storage.length))
            }
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            parent.text = textView.string
            reportComposing()
            reportCaret()
            measure()
        }

        private var composing = false

        func reportComposing() {
            guard let textView, textView.hasMarkedText() != composing else { return }
            composing.toggle()
            let value = composing
            DispatchQueue.main.async { self.parent.onComposing(value) }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            reportCaret()
        }

        private func reportCaret() {
            guard let textView else { return }
            let location = textView.selectedRange().location
            if parent.caret != location {
                DispatchQueue.main.async { self.parent.caret = location }
            }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard !textView.hasMarkedText() else { return false }
            switch selector {
            case #selector(NSResponder.moveUp(_:)): return parent.onKey(.up)
            case #selector(NSResponder.moveDown(_:)): return parent.onKey(.down)
            case #selector(NSResponder.insertTab(_:)): return parent.onKey(.accept)
            case #selector(NSResponder.cancelOperation(_:)): return parent.onKey(.dismiss)
            case #selector(NSResponder.insertNewline(_:)):
                if parent.onKey(.accept) { return true }
                let flags = NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
                if parent.enterSends, flags.isDisjoint(with: [.shift, .option, .command, .control]) {
                    parent.onSubmit(false)
                    return true
                }
                return false
            default:
                return false
            }
        }

        /// The laid-out text's height, insets included.
        private func measuredHeight() -> CGFloat? {
            guard let textView, let container = textView.textContainer, let layout = textView.layoutManager else { return nil }
            layout.ensureLayout(for: container)
            return ceil(layout.usedRect(for: container).height + textView.textContainerInset.height * 2)
        }

        /// Reports the height at once. Only from the text view's own callbacks, which run outside
        /// SwiftUI's update, so the editor grows in the same frame as the line typed into it.
        func measure() {
            guard let height = measuredHeight(), abs(parent.height - height) > 0.5 else { return }
            parent.height = height
        }

        /// Reports the height after the update that replaced the text (state cannot change during it),
        /// measured again then so a later edit is not overwritten.
        func report(animation: Animation?) {
            DispatchQueue.main.async {
                guard let height = self.measuredHeight(), abs(self.parent.height - height) > 0.5 else { return }
                withAnimation(animation) { self.parent.height = height }
            }
        }

        func submit(interrupt: Bool) { parent.onSubmit(interrupt) }

        func pasteFiles(_ board: NSPasteboard) -> Bool { parent.onPasteFiles(board) }
    }
}

final class SubmitTextView: NSTextView {
    weak var coordinator: ComposerTextView.Coordinator?
    /// A focus request made before the view was in a window, taken as soon as it is in one.
    var wantsFocus = false

    func takeFocusIfWanted() {
        guard wantsFocus, let window else { return }
        wantsFocus = false
        window.makeFirstResponder(self)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if wantsFocus { DispatchQueue.main.async { self.takeFocusIfWanted() } }
    }

    // Marked text changes post no text-change notification, so the placeholder would draw under it.
    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        coordinator?.reportComposing()
    }

    override func unmarkText() {
        super.unmarkText()
        coordinator?.reportComposing()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 36 || event.keyCode == 76, flags.contains(.command), window?.firstResponder === self {
            guard !hasMarkedText() else { return false }
            coordinator?.submit(interrupt: flags.contains(.shift))
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    /// ⌥↩ adds a line even when Return sends, as ⇧↩ does.
    override func insertNewlineIgnoringFieldEditor(_ sender: Any?) {
        insertText("\n", replacementRange: selectedRange())
    }

    override func paste(_ sender: Any?) {
        let board = NSPasteboard.general
        let copiedFiles = board.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        let took = coordinator?.pasteFiles(board) ?? false
        // Content copied from a page carries a picture and words: keep both. Files copied in Finder
        // also carry their names as text, which is not what the reader meant to paste.
        if !took || (!copiedFiles && board.string(forType: .string) != nil) { pasteAsPlainText(sender) }
    }

    // A plain-text view only enables Paste for text, so an image alone on the pasteboard (a
    // screenshot) would grey the item out and ⌘V would never reach `paste(_:)`.
    override func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(paste(_:)), isEditable, ComposerModel.holdsAttachment(.general) { return true }
        return super.validateMenuItem(item)
    }

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), isEditable, ComposerModel.holdsAttachment(.general) { return true }
        return super.validateUserInterfaceItem(item)
    }
}

/// The draft's scroll view hands the wheel to the transcript once the draft cannot scroll further
/// that way (`Composer.tsx`), so reading never stalls over the input.
final class PassthroughScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) {
        guard let document = documentView else { return super.scrollWheel(with: event) }
        let visible = contentView.bounds
        let atTop = visible.minY <= 0.5
        let atBottom = visible.maxY >= document.frame.height - 0.5
        let up = event.scrollingDeltaY > 0
        let down = event.scrollingDeltaY < 0
        if (up && atTop) || (down && atBottom), let scroller = TranscriptController.active(in: window) {
            let transcript = scroller.hostScrollView
            scroller.forwardedWheel()
            transcript.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
    }
}
