import AppKit
import RiffetKit

/// What a click inside a row asks the transcript to do. The row's key travels with it.
enum TranscriptAction {
    case toggleProcess
    /// Opens or closes a disclosure (thought, tool, background shell) by its id.
    case toggle(String)
    /// Folds or unfolds a run of tool calls, which is [open] now.
    case toggleToolRun(id: String, open: Bool)
    case openSubagent(id: String, title: String)
    case toggleWrap(String)
    case toggleRendered(String)
    case retryHistory
    case checkRun(Run)
    case retryRun(Run)
    case openFile(path: String, line: Int?)
    case openURL(URL)
    case openImage(ImageViewer.Item)
    case downloadAttachment(id: String, name: String)
    case previewAttachment(id: String, name: String)
    case openVisualization(path: String, title: String, wide: Bool)
    /// Asks the server to stop a background task; [warning] is what stopping it also stops, when more than itself.
    case stopActivity(id: String, warning: String?)
    /// Reads the full text behind an activity's preview.
    case loadActivityText(blobRef: String)
    case loadSessionReference(String)
    case sessionReferencePage(String, Int)
    /// Opens the session info, where the subagents and background tasks are listed.
    case openSessionInfo
}

/// A link to another conversation, carried in a row's text (the lineage row's parent title).
enum SessionLink {
    static func url(_ id: String) -> URL {
        var components = URLComponents()
        components.scheme = "riffet-session"
        components.host = "open"
        components.path = "/\(id)"
        return components.url!
    }

    static func sessionId(_ url: URL) -> String? {
        guard url.scheme == "riffet-session" else { return nil }
        let id = url.path.dropFirst()
        return id.isEmpty ? nil : String(id)
    }
}

/// A filled or stroked rounded rectangle behind other fragments.
struct BoxSpec {
    var fill: NSColor?
    var stroke: NSColor?
    var radius: CGFloat = 0
}

/// A one-line disclosure header (process block, thought, tool call, background shell): quiet text
/// that brightens under the pointer, a chevron, and trailing status. Laid out by its view.
struct DisclosureSpec {
    enum Icon {
        case symbol(String, size: CGFloat, color: NSColor)
        case spinner
    }

    enum Chevron {
        /// Shown under the pointer or while open, turned when open.
        case hover(open: Bool)
        /// Always shown, turned when open.
        case always(open: Bool)
        /// The row opens something else (a subagent).
        case arrow
    }

    /// Something in the header that changes with the clock.
    enum Clock {
        case process(TimelineRowProcess)
        case job(NativeJob)
        case activity(NativeActivity, stopping: Bool)
    }

    struct Piece {
        let text: String
        let font: NSFont
        let color: NSColor
        /// The first this many UTF-16 units draw in [quietColor]: a path's directory before its file.
        var quiet = 0
        var quietColor: NSColor?

        var attributed: NSAttributedString {
            let value = NSMutableAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
            if quiet > 0, let quietColor { value.addAttribute(.foregroundColor, value: quietColor, range: NSRange(location: 0, length: min(quiet, value.length))) }
            return value
        }
    }

    var icon: Icon
    var title: String
    var titleFont: NSFont
    /// Red instead of the quiet disclosure colour.
    var danger = false
    var detail: Piece?
    /// Content that belongs with the title (a tool's diff counts): it follows the title and
    /// detail, ahead of the chevron, instead of sitting in the right-hand status column.
    var inline: [Piece] = []
    var trailing: [Piece] = []
    /// A coloured dot before the trailing pieces (a shell's state).
    var dot: NSColor?
    var chevron: Chevron
    var shimmer = false
    var clock: Clock?
    var truncateMiddle = false
    var action: TranscriptAction
    var help: String?
    /// How the Claude style draws it; every other header is `.plain`.
    var variant = Variant.plain
    /// Room kept free at the right edge for a control drawn over the row, so the row's own hover wash spans the full width.
    var reserve: CGFloat = 0

    /// The line over a run's lists, or one call's row in a bordered list and where in it.
    enum Variant: Equatable {
        case plain
        case listSummary
        case listRow(Place)
    }

    /// A row's place in its list, which decides the corners its hover wash shares with the border.
    enum Place: Equatable {
        case only, first, middle, last
    }
}

/// Delivery progress, time, speed and a copy action under a message; all but the progress show only
/// on the hovered or newest row (`FooterView.revealed`).
struct FooterSpec {
    var status: (String, NSColor)?
    var time: String?
    var speed: SpeedTag?
    var copy: String
    var trailing: Bool
    var statusSymbol: String? = nil
    /// The Riffet run behind a finished answer: what "fork from here" and "rewind code" name.
    /// Nil for a turn the app did not send; the footer then keeps only its copy button.
    var turnRunId: String? = nil
    /// A task's live statistics, shown only inside its expanded details.
    var clock: DisclosureSpec.Clock?
    /// The line holds a delivery status and its actions, so the time stays with them.
    var keepsShown = false
}

/// A fenced block's chrome: language, the Markdown and wrap switches, copy.
struct CodeHeaderSpec {
    let id: String
    let label: String
    let copy: String
    let canRender: Bool
    let rendered: Bool
    let wraps: Bool
}

/// Source text in a viewport that scrolls inside (it wraps when the reader asked).
struct CodeBodySpec {
    let text: TextLayout
    let wraps: Bool
    let inset: CGFloat
    /// The whole text's height with its bottom padding; the fragment is the viewport.
    let contentHeight: CGFloat
    /// Opens on the last lines (a command's output).
    let startAtEnd: Bool
}

/// One line of a unified diff.
struct DiffLineSpec: Sendable {
    enum Kind: Sendable { case add, del, context, gap }
    let kind: Kind
    let old: String
    let new: String
    let text: String
}

/// `NSFont` is immutable, so the spec can be handed between threads.
struct DiffSpec: @unchecked Sendable {
    let lines: [DiffLineSpec]
    let lineHeight: CGFloat
    let gutter: CGFloat
    let contentWidth: CGFloat
    let font: NSFont
    let gutterFont: NSFont
}

struct DiffHeaderSpec {
    let path: String
    let line: Int?
    let added: Int
    let removed: Int
}

struct TableSpec {
    let header: [TextLayout]
    let rows: [[TextLayout]]
    let columns: [CGFloat]
    let headerHeight: CGFloat
    let rowHeights: [CGFloat]
    var width: CGFloat { columns.reduce(0, +) }
}

struct ImageSpec {
    let source: TimelineImageSource
    let projectId: String?
    let label: String
    /// The image has not loaded yet: a shimmering placeholder.
    let placeholder: Bool
    let failed: Bool
    var crop: Bool = false
}

struct CardSpec {
    let path: String
    let title: String
    let wide: Bool
}

struct ChipSpec {
    let text: String
    let symbol: String
    let action: TranscriptAction?
    let help: String?
}

struct ButtonSpec {
    let title: String
    let action: TranscriptAction?
    let loading: Bool
    /// A text action in a message's footer line: footer-sized, without the chip's padding.
    var compact = false
}

struct WorkingSpec {
    let step: String?
    let since: Date?
    let speed: SpeedTag?
    var stopping = false
    /// The turn has ended but delegated work still runs: the quiet line says so, in place of the working line.
    var background: String?
}

/// One positioned piece of a row, in the row's flipped coordinates.
struct Fragment {
    enum Kind {
        case box(BoxSpec)
        case text(TextLayout, selectable: Bool)
        case disclosure(DisclosureSpec)
        case footer(FooterSpec)
        case codeHeader(CodeHeaderSpec)
        case codeBody(CodeBodySpec)
        case diffHeader(DiffHeaderSpec)
        case diff(DiffSpec)
        case table(TableSpec)
        case image(ImageSpec)
        case math(NSImage)
        case card(CardSpec)
        case chip(ChipSpec)
        case button(ButtonSpec)
        case working(WorkingSpec)
        /// A running turn's footer slot (`TurnFooter.held`), as tall as the footer that replaces it:
        /// the working line while the row holds the turn's footer (`TranscriptController.progress`).
        case progress
    }

    var frame: CGRect
    let kind: Kind
}

/// A row ready to draw: its height, its fragments, and what it waited for.
final class RowLayout: @unchecked Sendable {
    struct Chapter: Equatable {
        let level: Int
        let title: String
        /// In the row's own coordinates, independent of the list's current row positions.
        let rect: CGRect
        /// The rank and occurrence within that rank; title edits and width changes keep identity.
        var id = ""
    }

    /// The fragments one timeline item of a process block drew, so a click on a picture or a tool
    /// call can tell which item it was (收藏), and a jump can find the item.
    struct ItemSpan {
        let item: any TimelineItem
        let fragments: Range<Int>
    }

    let height: CGFloat
    let fragments: [Fragment]
    let items: [ItemSpan]
    let chapters: [Chapter]
    let chapterAnchors: [Chapter]
    /// The standalone assistant's prose only, excluding the row gap and its footer.
    let answerBody: CGRect?
    /// Resource tokens laid out without (see `TranscriptResources`).
    let pending: Set<String>
    /// The message the row's menu copies and quotes.
    let message: String?
    /// Some fragment changes with the clock.
    let ticking: Bool
    init(height: CGFloat, fragments: [Fragment], pending: Set<String> = [], message: String? = nil, ticking: Bool = false, items: [ItemSpan] = [], chapters: [Chapter] = [], answerBody: CGRect? = nil) {
        self.height = height
        self.fragments = fragments
        self.items = items
        self.answerBody = answerBody
        var counts: [Int: Int] = [:]
        let anchors = chapters.map { value -> Chapter in
            var value = value
            value.id = "h\(value.level):\(counts[value.level, default: 0])"
            counts[value.level, default: 0] += 1
            return value
        }
        let level = counts.keys.filter { counts[$0, default: 0] >= 2 }.min()
        self.chapterAnchors = anchors
        self.chapters = anchors.filter { $0.level == level }
        self.pending = pending
        self.message = message
        self.ticking = ticking
    }
}
