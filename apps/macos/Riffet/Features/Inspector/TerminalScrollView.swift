import AppKit
import os
import SwiftTerm
import RiffetKit

/// One SwiftTerm view holds the pane's whole scrollback (docs/TERMINAL.md): the server's snapshot
/// seeds it and it scrolls, selects and routes the wheel (mouse report, arrow keys, scrollback)
/// itself. This enclosing scroll view only pans sideways when the pane is wider than the viewport.
@MainActor
final class TerminalScrollView: NSScrollView {
    let live = ScrollingTerminalView(frame: .zero)
    var onViewportSize: ((Int, Int) -> Void)?
    private var remoteGrid: (cols: Int, rows: Int)?
    var controlsRemote = false

    private let document = TerminalDocumentView()
    private var eventMonitor: Any?
    private var viewportSize = NSSize.zero
    private var rebuilding = false

    /// The live bottom: nothing to scroll, or the view follows new output.
    var atBottom: Bool { !live.canScroll || live.scrollPosition >= 1 }

    override init(frame: NSRect) {
        super.init(frame: frame)
        borderType = .noBorder
        drawsBackground = false
        hasVerticalScroller = true
        hasHorizontalScroller = true
        autohidesScrollers = true
        scrollerStyle = .overlay
        horizontalScrollElasticity = .none
        verticalScrollElasticity = .none
        documentView = document
        document.addSubview(live)
        live.registerForDraggedTypes([.fileURL, .png, .tiff])
        live.changeScrollback(Self.scrollbackRows)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
    }

    private static let scrollbackRows = Int(StreamKt.TERMINAL_SCROLLBACK_ROWS)

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor); self.eventMonitor = nil }
        guard window != nil else { return }
        // SwiftTerm's wheel handler ignores the horizontal axis; pan sideways here, leave the rest to it.
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
            guard let self, let window, event.window === window, !isHiddenOrHasHiddenAncestor,
                  abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY),
                  bounds.contains(convert(event.locationInWindow, from: nil)) else { return event }
            scrollWheel(with: event)
            return nil
        }
    }

    override func layout() {
        super.layout()
        guard !rebuilding, contentSize.width > 0, contentSize.height > 0, contentSize != viewportSize else { return }
        viewportSize = contentSize
        rebuilding = true
        defer { rebuilding = false }
        let dimensions = live.terminalDimensions
        let optimal = live.getOptimalFrameSize().size
        let cellWidth = optimal.width / CGFloat(max(1, dimensions.cols))
        let cellHeight = optimal.height / CGFloat(max(1, dimensions.rows))
        onViewportSize?(max(20, Int(viewportSize.width / max(1, cellWidth))), max(5, Int(viewportSize.height / max(1, cellHeight))))
        if let remoteGrid {
            live.setFrameSize(NSSize(width: cellWidth * CGFloat(remoteGrid.cols), height: cellHeight * CGFloat(remoteGrid.rows)))
        } else {
            live.setFrameSize(viewportSize)
        }
        fitDocument()
    }

    /// The display frame follows the server grid; local bounds only propose an owner resize.
    func setRemoteGrid(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        remoteGrid = (cols, rows)
        if live.terminalDimensions.cols != cols || live.terminalDimensions.rows != rows { live.resize(cols: cols, rows: rows) }
        live.setFrameSize(live.getOptimalFrameSize().size)
        viewportSize = .zero
        needsLayout = true
    }

    /// A font change resizes the cells; the grid and the proposed pane size follow.
    func refreshAppearance() {
        if let remoteGrid { setRemoteGrid(cols: remoteGrid.cols, rows: remoteGrid.rows) } else { viewportSize = .zero; needsLayout = true }
    }

    private func fitDocument() {
        document.frame = NSRect(x: 0, y: 0, width: max(viewportSize.width, live.frame.width), height: max(viewportSize.height, live.frame.height))
        live.setFrameOrigin(.zero)
    }

    func scrollToLive() {
        live.scroll(toPosition: 1)
    }
}

@MainActor
final class ScrollingTerminalView: SwiftTerm.TerminalView {
    /// Parser replies have no authority to take the input lease from another client.
    var onReply: ((String) -> Void)?
    var onAttachmentPaste: ((NSPasteboard) -> Bool)?
    /// Pasted text goes to the server, which brackets it when the program asked for that.
    var onTextPaste: ((String) -> Void)?
    private nonisolated let suppressReplies = OSAllocatedUnfairLock(initialState: false)

    /// A local theme repaint must not answer old DSR/DA queries to the running shell again.
    func replay(_ text: String) {
        suppressReplies.withLock { $0 = true }
        defer { suppressReplies.withLock { $0 = false } }
        resetToInitialState()
        feed(text: text)
    }

    nonisolated override func send(source: SwiftTerm.Terminal, data: ArraySlice<UInt8>) {
        guard !suppressReplies.withLock({ $0 }) else { return }
        let text = String(decoding: data, as: UTF8.self)
        DispatchQueue.main.async { [weak self] in self?.onReply?(text) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        ComposerModel.holdsAttachment(sender.draggingPasteboard) ? .copy : []
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        window?.makeFirstResponder(self)
        return onAttachmentPaste?(sender.draggingPasteboard) ?? false
    }

    override func paste(_ sender: Any) {
        if onAttachmentPaste?(NSPasteboard.general) == true { return }
        guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return }
        scrollToBottom()
        onTextPaste?(text)
    }

    private func scrollToBottom() { scroll(toPosition: 1) }
}

private final class TerminalDocumentView: NSView {
    override var isFlipped: Bool { true }
}
