import AppKit
import SwiftTerm

/// Resolved visual appearance handed to a [TerminalSurfaceBackend] whenever the theme,
/// color scheme, font family, or font size changes.
struct TerminalSurfaceAppearance {
    let font: NSFont
    let foreground: NSColor
    let background: NSColor
    let cursor: NSColor
    let cursorText: NSColor
    let selection: NSColor
    let ansiColors: [SwiftTerm.Color]
    let dark: Bool
    let cursorStyle: TerminalCursorShape
    let cursorBlink: Bool
    let optionAsMeta: Bool
    let copyOnSelect: Bool
    let rightClick: TerminalRightClickBehavior
    let scrollOnInput: Bool
    let scrollOnOutput: Bool
    let scrollSensitivity: Double
}

/// Pluggable terminal emulator + rendering surface behind [TerminalController] (docs/TERMINAL-SOTA.md §3.2).
///
/// Decouples session lifecycle, lease management, attachment paste, and appearance sync from the
/// concrete emulator (currently SwiftTerm; future Metal GPU backend such as GhosttyKit plugs in here).
@MainActor
protocol TerminalSurfaceBackend: AnyObject {
    var surfaceView: NSView { get }
    var atBottom: Bool { get }
    var controlsRemote: Bool { get set }

    var onInput: ((String) -> Void)? { get set }
    var onReply: ((String) -> Void)? { get set }
    var onTextPaste: ((String) -> Void)? { get set }
    var onAttachmentPaste: ((NSPasteboard) -> Bool)? { get set }
    var onViewportSize: ((Int, Int) -> Void)? { get set }
    var onScrollPositionChange: ((Bool) -> Void)? { get set }
    var onBell: (() -> Void)? { get set }
    var onClipboardCopy: ((String) -> Void)? { get set }
    var onOpenLink: ((URL) -> Void)? { get set }
    var onCommandExitCode: ((Int) -> Void)? { get set }
    var onOpenSearch: (() -> Void)? { get set }
    var hasPromptMarkers: Bool { get }

    func feed(_ text: String, fresh: Bool, cols: Int, rows: Int)
    func applyAppearance(_ appearance: TerminalSurfaceAppearance)
    func setRemoteGrid(cols: Int, rows: Int)
    func scrollToLive()
    func notifyColorScheme()
    func focusSurface()
    @discardableResult func findNext(_ term: String, caseSensitive: Bool, regex: Bool) -> Bool
    @discardableResult func findPrevious(_ term: String, caseSensitive: Bool, regex: Bool) -> Bool
    func searchMatchSummary(_ term: String, caseSensitive: Bool, regex: Bool) -> (index: Int, total: Int)
    func clearSearch()
    @discardableResult func jumpToPreviousPrompt() -> Bool
    @discardableResult func jumpToNextPrompt() -> Bool
}

/// Active rendering engine selection for macOS terminals.
enum TerminalBackendKind {
    case swiftTerm

    @MainActor
    func makeSurface(frame: NSRect) -> any TerminalSurfaceBackend {
        switch self {
        case .swiftTerm:
            return TerminalScrollView(frame: frame)
        }
    }
}
