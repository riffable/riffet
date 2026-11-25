import AppKit
import Observation
import QuartzCore
import RiffetKit

/// The rows a feed hands the layout queue, read there (Kotlin objects are safe to read off the
/// main thread; converting them is what costs).
struct TranscriptRows {
    var rows: [any TimelineRow] = []
    var compact: [Bool] = []
    var speeds: [String: SpeedTag] = [:]
    var turns: [TurnTick] = []
    /// Facts about the rows the view around the transcript needs, found while reading them.
    var flags: Set<String> = []
    /// The row holding the running turn's footer (`TimelinePresentation.heldFooter`): the working
    /// line goes in its place there, and is a row of its own below the rest only when this is nil.
    var heldFooter: String?
}

/// What the transcript shows, read on the main thread from observable state. `rows` runs on the
/// layout queue; `identity` changes whenever it would return something else.
struct TranscriptFeed {
    enum Older: Equatable { case idle, loading, failed }

    var sessionId: String?
    var identity: AnyObject?
    var rows: @Sendable () -> TranscriptRows
    var older: Older?
    var working: WorkingSpec?
    /// A visible compaction activity owns the progress line; its turn needs no empty footer slot.
    var suppressesHeldFooter = false
    var sessionWorking: Bool
    var root: String?
    var projectId: String?
    /// Show "还没有消息" when there are no rows.
    var emptyText: Bool
    /// Show "正在启动…" when there are no rows (the session is working and has produced nothing yet).
    var startingText = false
    /// The origin line, shown as the first row once the start of the history is reached.
    var lineage: LineageSpec?
    /// The successor line, shown as the last row when this conversation was handed off.
    var handedOff: HandedOffSpec?
    var supportsRecovery = false
    /// What plugin commands run on this conversation's answers have answered, drawn under those answers.
    var commandResults: [CommandResultSpec] = []

    func same(as other: TranscriptFeed) -> Bool {
        commandResults == other.commandResults && supportsRecovery == other.supportsRecovery && identity === other.identity && older == other.older && sessionWorking == other.sessionWorking && root == other.root
            && suppressesHeldFooter == other.suppressesHeldFooter
            && emptyText == other.emptyText && startingText == other.startingText && working?.step == other.working?.step && working?.since == other.working?.since
            && working?.speed?.label == other.working?.speed?.label && working?.stopping == other.working?.stopping && working?.background == other.working?.background && (working == nil) == (other.working == nil) && lineage == other.lineage && handedOff == other.handedOff
    }
}

/// What a finished turn can be taken back to: a new conversation from it, or its code before it ran.
enum TurnAction {
    case fork
    case rewind
}

/// What the transcript's clicks reach outside it.
struct TranscriptActions {
    var loadOlder: () -> Void = {}
    var retryHistory: () -> Void = {}
    var openSubagent: ((String, String) -> Void)?
    var quote: ((String) -> Void)?
    /// Restores a rejected input from its own user row, rather than a persistent composer banner.
    var restoreInput: ((Run) -> Void)?
    var checkRun: ((Run) -> Void)?
    var retryRun: ((Run) -> Void)?
    var openVisualization: (String, String, Bool) -> Void = { _, _, _ in }
    /// A click on a path or a file link (path, line): previews it in the window the transcript is in.
    var openFile: (String, Int?) -> Void = { _, _ in }
    /// File location and actions for a link's context menu, resolved in the owning server/project.
    var fileMenu: ((String) -> [NSMenuItem])?
    /// The file a link written in the conversation's text names (`resolveFileMention`): one its tools touched.
    var resolveFile: (String) -> String = { $0 }
    /// Asks the server to stop a background task; false when the request failed.
    var stopActivity: (String) async -> Bool = { _ in false }
    /// The full text behind an activity's preview; nil when it cannot be read.
    var activityText: (String) async -> String? = { _ in nil }
    /// Fork or rewind from a finished answer's run; nil where the transcript offers neither (a subagent's).
    var turn: ((TurnAction, String) -> Void)?
    /// Saves, highlights and edits marks (收藏); nil where answers cannot be marked (a subagent's).
    var mark: ((MarkCommand) -> Void)?
    /// Opens 导出图片 for an answer or a passage; the conversation fills in where it was said.
    var exportImage: ((ShareSource) -> Void)?
    /// A focus that reads older pages (a saved reply) did not find its message.
    var focusMissed: () -> Void = {}
    /// Opens another conversation (the lineage row's parent).
    var openSession: (String) -> Void = { _ in }
    /// Opens the conversation's session info (the background line).
    var openSessionInfo: () -> Void = {}
    /// The plugin commands an answer's menu offers, with the glyph of each; empty where answers take none.
    var messageCommands: [(title: String, symbol: String, id: String)] = []
    /// Runs a message command on an answer (command id, answer text, run id).
    var runMessageCommand: (String, String, String?) -> Void = { _, _, _ in }
    /// Closes the result of a message command, by its id.
    var dismissCommandResult: (String) -> Void = { _ in }
    /// Runs a failed message command again, by its result id.
    var retryCommandResult: (String) -> Void = { _ in }
    /// Opens model settings for a message command (`use`: Auxiliary models, otherwise Quick chat).
    var chooseCommandModel: (Bool) -> Void = { _ in }
}

/// Where the transcript scrolls next: a search hit's event, or a saved reply's message.
struct TranscriptFocus: Equatable {
    /// The conversation it is for; a transcript of another one (still on screen while the switch
    /// lands) leaves it alone. Nil for whichever is open.
    var sessionId: String?
    var sequence: Int64?
    /// Native ids of the message, matched before the sequence.
    var messageIds: [String] = []
    /// A highlight's words: the transcript scrolls to them rather than to the whole answer.
    var quote: MarkQuote?
    /// Read older pages until the message is loaded (up to `TranscriptController.focusPageLimit`);
    /// otherwise the nearest loaded row is taken.
    var exact = false
    /// Repeating the same focus scrolls again.
    var token = UUID()
}

/// Where a focus is in the loaded transcript.
enum TranscriptFocusMatch {
    /// The row, and the item inside it when the row is a process block (a picture, a tool call).
    case row(String, item: String?)
    /// Older than the loaded part: read another page.
    case older
}

/// The transcript's scroll state for the SwiftUI around it (turn rail, back-to-bottom button).
@MainActor
@Observable
final class TranscriptScrollState {
    var atBottom = true
    var activeTurn = 0
    var turns: [TurnTick] = []
    var hasRows = false
    /// The conversation whose list owns this state.
    var sessionId: String?
    /// The first rows are on screen.
    var loaded = false
    var flags: Set<String> = []
    @ObservationIgnored weak var controller: TranscriptController?
}

/// The conversation transcript in AppKit: an `NSTableView` whose rows are laid out on a background
/// queue (`RowBuilder`) and only placed on the main thread. Rows keep their layout until their
/// content, width, style or the reader's disclosures change; a streamed chunk re-lays out the row it
/// grew. Follows new output at the bottom until the reader scrolls up, keeps what they read in place
/// while rows above change, and opens long conversations from the end.
@MainActor
final class TranscriptController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    private struct Visible { weak var controller: TranscriptController? }
    /// Transcripts on screen, in the order they appeared. Each window has its own, and a subagent's
    /// can sit beside the main one, so lookups go by window rather than by "the last one shown".
    private static var visible: [Visible] = []

    /// The reader sent a message in conversation [sessionId]: its transcripts on screen follow the
    /// end if they are still on the latest turn (`followSent()`).
    static func followSent(in sessionId: String) {
        for controller in visible.compactMap(\.controller) where controller.showsChrome && !controller.covered && controller.feed?.sessionId == sessionId {
            controller.followSent()
        }
    }

    /// The transcript in `window` that appeared last.
    static func active(in window: NSWindow?, includingCovered: Bool = false) -> TranscriptController? {
        guard let window else { return nil }
        // One kept under the home page or a page is not what the reader is looking at.
        return visible.reversed().lazy.compactMap(\.controller).first { $0.view.window === window && (includingCovered || !$0.covered) }
    }

    private struct LayoutKey: Equatable {
        let source: ObjectIdentifier?
        let width: CGFloat
        let style: String
        let version: Int
        let gap: RowGap?
        let suppressesHeldFooter: Bool
        let speed: String?
        let stale: Bool
        let resources: Int
        let supportsRecovery: Bool
    }

    private final class Entry: @unchecked Sendable {
        let key: String
        let source: RowSource
        let identity: AnyObject?
        let layout: RowLayout?
        let layoutKey: LayoutKey?
        let height: CGFloat

        init(key: String, source: RowSource, identity: AnyObject?, layout: RowLayout?, layoutKey: LayoutKey?, height: CGFloat) {
            self.key = key
            self.source = source
            self.identity = identity
            self.layout = layout
            self.layoutKey = layoutKey
            self.height = height
        }
    }

    private struct BuildInput: @unchecked Sendable {
        let feed: TranscriptFeed
        let width: CGFloat
        let viewport: CGFloat
        let style: TranscriptStyle
        let ui: TranscriptUIStore
        let previous: [String: Entry]
        let byIdentity: [ObjectIdentifier: Entry]
        let priority: Set<String>
        let reading: Set<String>
        let refresh: [String: Int]
        let tail: (any TimelineRow)?
        let fresh: Bool
    }

    private struct BuildOutput: @unchecked Sendable {
        let entries: [Entry]
        let turns: [TurnTick]
        let flags: Set<String>
        let held: String?
        let complete: Bool
        let input: BuildInput
    }

    let ui: TranscriptUIStore
    let scrollState: TranscriptScrollState
    var actions = TranscriptActions()
    /// Kept under the home page or a page, off screen: its shortcuts stand down.
    var covered = false
    private let feedProvider: @MainActor () -> TranscriptFeed?

    private let scrollView = TranscriptScrollView()
    private let table = TranscriptTable()
    private var entries: [Entry] = []
    private var feed: TranscriptFeed?
    private var style: TranscriptStyle
    private var building = false
    private var dirty = false
    private var revealed = false
    /// Set a moment after the first reveal; see [prefetchWhenIdle].
    private var idle = false
    private var following = true
    private var userScrolling = false
    private var scrollingAway = false
    private var userScrollEnds: DispatchWorkItem?
    private var programmatic = false
    private var lastWidth: CGFloat = 0
    private var refresh: [String: Int] = [:]
    private var clock: Timer?
    private var observers: [NSObjectProtocol] = []
    private var benchTail: (any TimelineRow)?
    private var pendingFocus: TranscriptFocus?
    private var focusProvider: (@MainActor () -> TranscriptFocus?)?
    private var focusHandled: UUID?
    /// 会话内查找: its state read inside the observation, and how a hit's key maps to a row here.
    var findProvider: (@MainActor () -> FindState?)?
    var findRow: ((String) -> (row: String, item: String?)?)?
    private var findHandled: Int64 = 0
    private var pendingFind: FindTarget?
    /// The occurrence on show, held until the next target or the end of find.
    private var findShown: (row: String, nth: Int, needle: String)?
    /// The row find landed on without marking words in it (a folded tool's command, several items
    /// in one row): tinted until the next step or the end of find, as marked words stay.
    private var findHeld: String?
    /// Older pages read for the pending focus.
    private var focusPages = 0
    /// Holds a focused row in place while the transcript settles (`settle(on:quote:)`).
    private var settleTimer: Timer?
    /// The conversation's marks (收藏), read inside the observation like the feed.
    var marksProvider: (@MainActor () -> [Mark])?
    private let markIndex = TranscriptMarkIndex()
    private var turnKeys: [String: Int] = [:]
    /// The turn rail, back-to-bottom button and width handle (off for a subagent's transcript).
    var showsChrome = true
    private let rail = TurnRailView()
    /// The overview column carries the turn navigation, so the rail is not drawn as well.
    var railHidden = false {
        didSet { if railHidden != oldValue { layoutChrome() } }
    }
    private let chapters = ChapterNavigationView()
    private let chapterClip = ChapterNavigationClipView()
    private var chapterRowKey: String?
    private var chapterRowIndex: Int?
    private var chapterActive = 0
    private var chapterNavigationEnabled = true
    private let preview = TurnPreviewView()
    private let back = BackToBottomView()
    private let handle = WidthHandleView()
    private var keyMonitor: Any?
    /// The column width the current layouts were made for.
    private var column: CGFloat = 0
    /// Where the reader was when this conversation's list was last torn down; kept up to date while
    /// reading, and applied once, when the first rows go on screen.
    private let memory: TranscriptMemory?
    private var pendingRestore: TranscriptMemory.Anchor?

    init(ui: TranscriptUIStore, scrollState: TranscriptScrollState, feed: @escaping @MainActor () -> TranscriptFeed?, focus: (@MainActor () -> TranscriptFocus?)? = nil, memory: TranscriptMemory? = nil) {
        self.ui = ui
        self.scrollState = scrollState
        self.memory = memory
        feedProvider = feed
        focusProvider = focus
        style = TranscriptStyle.current(dark: NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
        super.init(nibName: nil, bundle: nil)
        scrollState.controller = self
        if let memory, !memory.atBottom { pendingRestore = memory.anchor }
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        clock?.invalidate()
        settleTimer?.invalidate()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    }

    private func applyChromeStyle() {
        rail.style = style
        chapters.style = style
        preview.style = style
        back.style = style
        handle.style = style
    }

    /// ⌘↓ goes back to the latest output, unless a text view wants it (the end of a draft).
    private func backShortcut(_ event: NSEvent) -> Bool {
        guard !covered, event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, event.keyCode == 125,
              view.window?.isKeyWindow == true, view.window === event.window, !scrollState.atBottom, view.superview != nil,
              !(view.window?.firstResponder is NSTextView) else { return false }
        scrollToBottom(animated: true)
        return true
    }

    // MARK: View

    override func loadView() {
        let root = TranscriptRootView()
        root.onAppearanceChange = { [weak self] in self?.restyle() }
        root.onLayout = { [weak self] in self?.widthChanged() }
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.intercellSpacing = .zero
        table.backgroundColor = .clear
        table.selectionHighlightStyle = .none
        table.usesAutomaticRowHeights = false
        table.style = .plain
        table.gridStyleMask = []
        table.rowSizeStyle = .custom
        table.allowsTypeSelect = false
        table.focusRingType = .none
        table.refusesFirstResponder = true
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self
        table.delegate = self
        scrollView.documentView = table
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.horizontalScrollElasticity = .none
        scrollView.onWheel = { [weak self] event in
            self?.userScrolled(after: 0.35, event: event)
        }
        scrollView.alphaValue = 0
        scrollView.frame = root.bounds
        scrollView.autoresizingMask = [.width, .height]
        root.addSubview(scrollView)
        if showsChrome {
            chapterClip.addSubview(chapters)
            for chrome in [handle, rail, back, chapterClip, preview] as [NSView] { root.addSubview(chrome) }
            chapters.onVisibilityChange = { [weak self] in
                guard let self else { return }
                self.handle.isHidden = !self.chapters.isHidden
                self.updateChapterEmphasis()
            }
            chapters.onHoverChange = { [weak self] in self?.updateChapterEmphasis() }
            rail.preview = preview
            rail.onJump = { [weak self] turn in self?.scroll(to: nativeString(turn.rowKey), center: false, animated: true) }
            chapters.onJump = { [weak self] index in
                guard let self, !self.chapters.exiting, let key = self.chapters.ownerKey,
                      let values = self.entries.first(where: { $0.key == key })?.layout?.chapters,
                      values.indices.contains(index) else { return }
                self.settle(on: key, item: nil, quote: nil, chapter: values[index].id)
            }
            back.onClick = { [weak self] in self?.scrollToBottom(animated: true) }
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                nonisolated(unsafe) let event = event
                return MainActor.assumeIsolated { self?.backShortcut(event) == true ? nil : event }
            }
        }
        applyChromeStyle()
        view = root

        let clip = scrollView.contentView
        clip.postsBoundsChangedNotifications = true
        clip.postsFrameChangedNotifications = true
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.scrolled() }
        })
        observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: clip, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.widthChanged()
                self?.viewportChanged()
            }
        })
        observers.append(center.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: scrollView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.userScrolling = true
                self?.pendingFind = nil
            }
        })
        observers.append(center.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: scrollView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.userScrolled(after: 0.15) }
        })
        observers.append(center.addObserver(forName: TranscriptResources.notification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let token = note.userInfo?["token"] as? String else { return }
                self?.resourceReady(token)
            }
        })
        let tracking = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        scrollView.addTrackingArea(tracking)
        observe()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        Self.visible.removeAll { $0.controller == nil || $0.controller === self }
        Self.visible.append(Visible(controller: self))
        TranscriptBench.current = self
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        Self.visible.removeAll { $0.controller == nil || $0.controller === self }
        if TranscriptBench.current === self { TranscriptBench.current = nil }
        settleTimer?.invalidate()
        settleTimer = nil
        chapters.dismiss(immediately: true)
        lastTop = nil
    }

    var hostScrollView: NSScrollView { scrollView }

    // MARK: Feed

    /// Re-reads the feed whenever what it read changes, on the next turn of the main loop.
    private func observe() {
        let next = withObservationTracking {
            (feedProvider(), focusProvider?(), Self.styleSignature(), marksProvider?() ?? [], DisplayPreferences.shared.chapterNavigation, findProvider?(), DisplayPreferences.shared.railDots)
        } onChange: { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.observe() } }
        }
        applyFind(next.5)
        rail.dots = next.6
        if next.2 != styleSignature {
            styleSignature = next.2
            restyle()
        }
        if next.4 != chapterNavigationEnabled {
            chapterNavigationEnabled = next.4
            updateChapters()
        }
        accept(next.0)
        if markIndex.update(next.3) { refreshMarks() }
        if let focus = next.1, focus.token != focusHandled {
            pendingFocus = focus
            focusHandled = focus.token
            focusPages = 0
            applyFocusIfReady()
        }
    }

    /// A nil feed (nothing loaded yet) shows nothing here: the SwiftUI around the list draws the
    /// loading and failure states (`TranscriptPlaceholder`) until the first rows are on screen.
    private func accept(_ next: TranscriptFeed?) {
        guard let next else { return }
        if let feed, feed.same(as: next) { return }
        feed = next
        requestBuild()
    }

    private var styleSignature = ""

    /// What the style is made of besides appearance; reading it inside the tracking registers it.
    private static func styleSignature() -> String {
        let preferences = DisplayPreferences.shared
        return "\(ThemeStore.shared.entry.id)|\(ThemeStore.shared.revision)|\(preferences.codeTheme)|\(ThemeStore.shared.codeThemeRevision)|\(AppearanceStore.shared.fonts.key)|\(preferences.textScale)|\(preferences.density)|\(preferences.contentWidth)|\(preferences.style.radii.control),\(preferences.style.radii.container),\(preferences.style.radii.floating),\(preferences.style.radii.card),\(preferences.style.text.readingLine)|\(preferences.style.fonts.ui),\(preferences.style.fonts.mono)|\(IconPack.shared.effective)"
    }

    /// The style changed (appearance, theme, text size, column width): every row lays out again.
    func restyle() {
        let dark = view.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let next = TranscriptStyle.current(dark: dark)
        guard next.key != style.key else { return }
        style = next
        applyChromeStyle()
        layoutChrome()
        requestBuild()
    }

    private func columnWidth(for width: CGFloat) -> CGFloat { max(0, min(style.column, width - style.gutter * 2)) }
    private var inset: CGFloat { floor((lastWidth - columnWidth(for: lastWidth)) / 2) }

    /// A new width relays out rows only when the reading column changes; otherwise (a sidebar or
    /// panel opening on a wide window) the rows just move, frame by frame of the animation.
    private func widthChanged() {
        let width = scrollView.contentView.bounds.width
        let changed = abs(width - lastWidth) > 0.5
        if changed {
            lastWidth = width
            let inset = inset
            for cell in visibleCells() { cell.setInset(inset) }
        }
        // The chrome follows the rows after their inset changed, including clip-view resizing
        // that arrives before the root's layout callback during a sidebar toggle.
        layoutChrome()
        if changed, abs(columnWidth(for: width) - column) > 0.5 { requestBuild() }
    }

    private func layoutChrome() {
        let bounds = view.bounds
        guard showsChrome, bounds.width > 0 else { return }
        let railHeight = rail.preferredHeight
        rail.frame = NSRect(x: bounds.width - 6 - 26, y: (bounds.height - railHeight) / 2, width: 26, height: railHeight)
        rail.setShown(rail.turns.count >= 2 && !railHidden, animated: revealed)
        back.frame = NSRect(x: (bounds.width - 30) / 2, y: bounds.height - 12 - 30, width: 30, height: 30)
        let shown = min(style.column + style.gutter * 2, bounds.width)
        let x = min(bounds.width - 8, (bounds.width + shown) / 2 + 6)
        handle.frame = NSRect(x: x - 7, y: (bounds.height - 120) / 2, width: 14, height: 120)
        layoutChapters()
    }

    private func layoutChapters() {
        guard chapterNavigationEnabled else {
            chapters.dismiss(immediately: true)
            return
        }
        let clip = scrollView.contentView
        let viewport = view.convert(clip.bounds, from: clip).intersection(view.bounds)
        guard !viewport.isNull, viewport.width > 0 else {
            chapters.dismiss()
            return
        }
        chapterClip.frame = viewport
        guard let key = chapterRowKey, let index = chapterRowIndex, entries.indices.contains(index), entries[index].key == key,
              let layout = entries[index].layout, let answerBody = layout.answerBody, layout.chapters.count >= 2,
              let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) as? TranscriptCell else {
            chapters.dismiss()
            return
        }
        // The row's origin is the rendered column edge: its negative bounds origin already
        // includes the current inset, as well as any offset introduced by the table or sidebar.
        let body = view.convert(answerBody, from: cell)
        let readingTop = viewport.minY + min(96, viewport.height * 0.2)
        guard readingTop >= body.minY, readingTop < body.maxY else { chapters.dismiss(); return }
        let left = body.minX
        let room = left - viewport.minX - 24 - 24
        let expanded = room >= 144
        let gap: CGFloat = expanded ? 24 : 8
        let width: CGFloat = expanded ? min(160, room) : min(24, max(0, left - viewport.minX - gap - 4))
        let height = min(CGFloat(layout.chapters.count) * 24, max(0, body.height - 32), max(0, viewport.height - 48), viewport.height * 0.6)
        guard width >= 12, height > 0 else { chapters.dismiss(); return }
        let top = min(max(readingTop, body.minY + 16), body.maxY - 16 - height)
        let frame = CGRect(x: (left - viewport.minX - width) / 2, y: top - viewport.minY, width: width, height: height)
        chapters.present(owner: key, titles: layout.chapters.map(\.title), active: chapterActive, frame: frame, compact: !expanded)
        updateChapterEmphasis()
    }

    // MARK: Building

    private func requestBuild() {
        guard feed != nil else { return }
        if building {
            dirty = true
            return
        }
        startBuild()
    }

    /// Runs one layout pass off the main thread. Dispatch's worker threads have a 512 KiB stack,
    /// and a Debug build's layout frames are large enough (a tool's code block alone asks for
    /// ~64 KiB) that a big transcript can walk off it; a dedicated thread gets a bigger stack.
    /// Passes never overlap (`building`), so one thread per pass is enough.
    private func runLayout(_ work: @escaping @Sendable () -> Void) {
        let thread = Thread(block: work)
        thread.name = "io.github.riffable.transcript.layout"
        thread.stackSize = 4 * 1024 * 1024
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    private func startBuild() {
        guard let feed, lastWidth > 0 || scrollView.contentView.bounds.width > 0 else { return }
        if lastWidth <= 0 { lastWidth = scrollView.contentView.bounds.width }
        restyleIfNeeded()
        building = true
        dirty = false
        var previous: [String: Entry] = [:]
        var byIdentity: [ObjectIdentifier: Entry] = [:]
        // A list built again for a conversation read a moment ago starts from the rows it laid out
        // then: the presenter hands back the same row instances, so their layouts still match.
        let laidOut = entries.isEmpty ? (memory?.rows as? [Entry] ?? []) : entries
        for entry in laidOut {
            previous[entry.key] = entry
            if let identity = entry.identity { byIdentity[ObjectIdentifier(identity)] = entry }
        }
        column = columnWidth(for: lastWidth)
        // Until the first reveal the row to restore the reader's place at is the one to lay out first.
        let restoring: Set<String> = pendingRestore.map { Set([$0.key]) } ?? Set<String>()
        let visible = Set(visibleKeys())
        let selectedRow = TextLayoutView.selectedView.flatMap { view in
            visibleCells().first { view.isDescendant(of: $0) }?.key
        }
        let reading = Set(laidOut.map(\.key).filter { ui.hasOpenDetail(inRow: $0) }).union(selectedRow.map { [$0] } ?? [])
        let input = BuildInput(
            feed: feed, width: column, viewport: scrollView.contentView.bounds.height, style: style, ui: ui,
            previous: previous, byIdentity: byIdentity, priority: visible.union(restoring),
            reading: reading, refresh: refresh, tail: benchTail, fresh: entries.isEmpty
        )
        runLayout {
            let output = Perf.measure("transcript.build") { Self.build(input) }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.finish(output) }
            }
        }
    }

    private func restyleIfNeeded() {
        let preferences = DisplayPreferences.shared
        let resolvedCodeTheme = ThemeStore.shared.codeTheme
        let resolvedCodeRevision = ThemeStore.shared.codeThemeRevision
        if preferences.textScale != style.scale || preferences.contentWidth != style.column || preferences.density != style.density || ThemeStore.shared.entry.id != style.palette.values.id || ThemeStore.shared.revision != style.palette.revision || resolvedCodeTheme.id != style.codeTheme.id || resolvedCodeRevision != style.codeThemeRevision || AppearanceStore.shared.fonts != style.fonts || preferences.style.radii != style.radii || preferences.style.text.readingLine != style.bodyLineHeight || preferences.style.fonts != style.styleFonts || IconPack.shared.effective != style.iconPack {
            style = TranscriptStyle.current(dark: style.dark)
            applyChromeStyle()
        }
    }

    private func finish(_ output: BuildOutput) {
        building = false
        Perf.measure("transcript.apply") { apply(output) }
        if dirty || !output.complete {
            startBuild()
        }
    }

    /// Lays out every row whose layout is out of date, the ones on screen first, within a time
    /// budget; rows it does not reach keep their old layout (or an estimate) for the next pass.
    nonisolated private static func build(_ input: BuildInput) -> BuildOutput {
        let feed = input.feed
        var data = feed.rows()
        if let tail = input.tail { data.rows.append(tail) }
        let states = ProcessFolds.states(data.rows)
        input.ui.sync(states) { input.reading.contains($0) }
        let speeds = Dictionary(data.speeds.map { (nativeString($0.key), $0.value) }, uniquingKeysWith: { first, _ in first })
        let stale = !feed.sessionWorking

        var sources: [(key: String, source: RowSource, identity: AnyObject?)] = []
        if feed.older == .failed { sources.append(("§older", .olderFailed, nil)) }
        if feed.older == .loading { sources.append(("§older", .olderLoading, nil)) }
        // The origin line belongs to the start of the history: while older pages remain it would
        // sit above rows it does not precede, so it waits until the reader can reach the beginning.
        if feed.older == nil, let lineage = feed.lineage { sources.append(("§lineage", .lineage(lineage), nil)) }
        for (index, row) in data.rows.enumerated() {
            let identity = row as AnyObject
            let key = input.byIdentity[ObjectIdentifier(identity)]?.key ?? nativeString(row.key)
            let compact = index < data.compact.count && data.compact[index]
            let gap = RowGap.between(index > 0 ? data.rows[index - 1] : nil, row, compact: compact)
            sources.append((key, .timeline(row, gap: gap, speed: speeds[key]), identity))
            if !feed.commandResults.isEmpty, let answer = Self.answer(of: row) {
                let match = CommandResultSpec.match(sessionId: feed.sessionId ?? "", runId: answer.runId, text: answer.text)
                for result in feed.commandResults where result.match == match { sources.append(("\(key)§result§\(result.id)", .commandResult(result), nil)) }
            }
        }
        // After the rows, ahead of the working line: it closes the history it belongs to, and rows
        // that arrive later (the conversation can continue after a handoff) take their place above it.
        if let handedOff = feed.handedOff { sources.append(("§handedOff", .handedOff(handedOff), nil)) }
        let held = data.heldFooter.map(nativeString)
        if let working = feed.working, held == nil { sources.append(("§working", .working(working), nil)) }
        if data.rows.isEmpty {
            if feed.emptyText { sources.append(("§empty", .empty(String(localized: "还没有消息")), nil)) }
            else if feed.startingText, feed.working == nil { sources.append(("§starting", .empty(String(localized: "正在启动…")), nil)) }
        }
        sources.append(("§bottom", .bottom, nil))

        func layoutKey(_ item: (key: String, source: RowSource, identity: AnyObject?)) -> LayoutKey {
            Self.layoutKey(key: item.key, source: item.source, identity: item.identity, width: input.width, style: input.style, ui: input.ui, stale: stale, suppressesHeldFooter: feed.suppressesHeldFooter, supportsRecovery: feed.supportsRecovery, refresh: input.refresh)
        }

        var builder = RowBuilder(style: input.style, width: input.width, ui: input.ui, root: feed.root, projectId: feed.projectId, stale: stale, suppressesHeldFooter: feed.suppressesHeldFooter, supportsRecovery: feed.supportsRecovery)
        var result = [Entry?](repeating: nil, count: sources.count)
        var todo: [Int] = []
        for (index, item) in sources.enumerated() {
            let key = layoutKey(item)
            if let old = input.previous[item.key], old.layoutKey == key, old.layout != nil {
                result[index] = old
            } else {
                todo.append(index)
            }
        }
        // On screen first; on a fresh open, from the end (where the list opens) upwards.
        let priority = input.priority
        var ordered = todo.filter { priority.contains(sources[$0].key) }
        let rest = todo.filter { !priority.contains(sources[$0].key) }
        ordered += input.fresh || priority.isEmpty ? rest.reversed() : rest.sorted { abs($0 - sources.count) < abs($1 - sources.count) }
        let started = CACurrentMediaTime()
        var builtHeight: CGFloat = 0
        var complete = true
        for (position, index) in ordered.enumerated() {
            let item = sources[index]
            // The first pass of a fresh open fills a little more than the viewport, then shows it.
            let budgetSpent = CACurrentMediaTime() - started > 0.03
            let freshEnough = input.fresh && builtHeight > input.viewport * 1.5
            if position > 0, budgetSpent || freshEnough, !priority.contains(item.key) {
                complete = false
                for remaining in ordered[position...] {
                    let item = sources[remaining]
                    let old = input.previous[item.key]
                    result[remaining] = Entry(key: item.key, source: item.source, identity: item.identity, layout: old?.layout, layoutKey: nil, height: old?.height ?? 96)
                }
                break
            }
            let layout = Perf.measure("transcript.layoutRow") { builder.build(item.source, key: item.key) }
            builtHeight += layout.height
            result[index] = Entry(key: item.key, source: item.source, identity: item.identity, layout: layout, layoutKey: layoutKey(item), height: layout.height)
        }
        return BuildOutput(entries: result.compactMap { $0 }, turns: data.turns, flags: data.flags, held: held, complete: complete, input: input)
    }

    nonisolated private static func layoutKey(key: String, source: RowSource, identity: AnyObject?, width: CGFloat, style: TranscriptStyle, ui: TranscriptUIStore, stale: Bool, suppressesHeldFooter: Bool, supportsRecovery: Bool, refresh: [String: Int]) -> LayoutKey {
        var gap: RowGap?, speed: String?
        // Only a lone tool row reads whether the session is running (a pending call shows as stopped
        // once it is not); every other row keeps its layout when a turn starts or ends. Process blocks
        // read their own `turnActive`, which is part of the Kotlin row.
        var readsStale = false
        var hidesFooter = false
        switch source {
        case let .timeline(row, g, s):
            gap = g; speed = s?.label
            hidesFooter = suppressesHeldFooter && row.footer == .held
            readsStale = (row as? TimelineRowSingle)?.item is TimelineItemTool
        case let .working(spec): speed = "\(spec.step ?? "")|\(spec.since?.timeIntervalSince1970 ?? 0)|\(spec.speed?.label ?? "")|\(spec.stopping)|\(spec.background ?? "")"
        case let .lineage(spec): speed = "lineage|\(spec.forked)|\(spec.agent ?? "")|\(spec.title)|\(spec.parentId)"
        case let .handedOff(spec): speed = "handedOff|\(spec.agent ?? "")|\(spec.successorId)"
        case let .commandResult(spec): speed = "result|\(spec.token)|\(spec.symbol)|\(spec.title)|\(spec.text?.hashValue ?? 0)|\(spec.error?.hashValue ?? 0)|\(spec.chooseModel)|\(spec.chooseUse)"
        case .olderFailed, .olderLoading, .empty, .bottom: break
        }
        return LayoutKey(
            source: identity.map(ObjectIdentifier.init), width: width, style: style.key, version: ui.version(key),
            gap: gap, suppressesHeldFooter: hidesFooter, speed: speed, stale: readsStale && stale, resources: refresh[key] ?? 0, supportsRecovery: supportsRecovery
        )
    }

    private func currentKey(_ entry: Entry) -> LayoutKey {
        Self.layoutKey(key: entry.key, source: entry.source, identity: entry.identity, width: column, style: style, ui: ui, stale: !(feed?.sessionWorking ?? false), suppressesHeldFooter: feed?.suppressesHeldFooter ?? false, supportsRecovery: feed?.supportsRecovery ?? false, refresh: refresh)
    }

    // MARK: Applying

    private enum Anchor {
        case bottom
        case row(String, offset: CGFloat)
    }

    private var holdKey: String?

    /// The row whose held footer slot shows the working line, and the line it shows (`progress(in:)`).
    private var progressRow: String?
    private var progressSpec: WorkingSpec?

    /// The working line for the held footer slot of row [key]; nil when that row does not show it.
    func progress(in key: String) -> WorkingSpec? { key == progressRow ? progressSpec : nil }

    private func captureAnchor() -> Anchor {
        if following { return .bottom }
        let clip = scrollView.contentView.bounds
        if let holdKey, let index = entries.firstIndex(where: { $0.key == holdKey }) {
            return .row(holdKey, offset: table.rect(ofRow: index).minY - clip.minY)
        }
        return visibleAnchor() ?? .bottom
    }

    /// The row to hold in place: the first whose top is on screen, or the one the viewport starts in.
    /// Not the "loading older" line, which comes and goes above the rows.
    private func visibleAnchor() -> Anchor? {
        let clip = scrollView.contentView.bounds
        let rows = table.rows(in: clip)
        guard rows.length > 0, NSMaxRange(rows) <= entries.count else { return nil }
        var index = rows.location
        if table.rect(ofRow: index).minY < clip.minY, index + 1 < NSMaxRange(rows) { index += 1 }
        if entries[index].key == "§older", index + 1 < entries.count { index += 1 }
        return .row(entries[index].key, offset: table.rect(ofRow: index).minY - clip.minY)
    }

    /// Notes where the reader is, for the next time this conversation's list is built.
    private func remember() {
        guard revealed, let memory, view.window != nil, scrollView.contentView.bounds.height > 0 else { return }
        memory.rows = entries
        let bottom = following || atRowsEnd
        memory.atBottom = bottom
        if !bottom, case let .row(key, offset)? = visibleAnchor() { memory.anchor = TranscriptMemory.Anchor(key: key, offset: offset) }
    }

    private func restore(_ anchor: Anchor) {
        switch anchor {
        case .bottom:
            scrollToBottom(animated: false)
        case let .row(key, offset):
            guard let index = entries.firstIndex(where: { $0.key == key }) else { return }
            let y = table.rect(ofRow: index).minY - offset
            // Rows below that shrank near the end must not pull the held row down.
            setBottomSlack(slackNeeded(at: y))
            scroll(toY: y)
        }
    }

    private func apply(_ output: BuildOutput) {
        // A row the reader toggled while this pass ran is newer here than in the pass.
        let current = Dictionary(entries.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        let next = output.entries.map { new -> Entry in
            if let old = current[new.key], let oldKey = old.layoutKey, oldKey.version > (new.layoutKey?.version ?? 0), old.identity === new.identity { return old }
            return new
        }
        let anchor = captureAnchor()
        let oldKeys = entries.map(\.key)
        let newKeys = next.map(\.key)
        let previous = entries
        entries = next
        memory?.rows = next
        // Set before the cells are configured below; a held row whose layout stays reads it in `refreshProgress`.
        let progressRows = Set([progressRow, output.held].compactMap { $0 })
        progressRow = output.held
        progressSpec = output.input.feed.working

        if previous.isEmpty || oldKeys.count == 0 {
            table.reloadData()
        } else {
            var prefix = 0
            while prefix < oldKeys.count, prefix < newKeys.count, oldKeys[prefix] == newKeys[prefix] { prefix += 1 }
            var suffix = 0
            while suffix < oldKeys.count - prefix, suffix < newKeys.count - prefix, oldKeys[oldKeys.count - 1 - suffix] == newKeys[newKeys.count - 1 - suffix] { suffix += 1 }
            let removed = IndexSet(integersIn: prefix..<(oldKeys.count - suffix))
            let inserted = IndexSet(integersIn: prefix..<(newKeys.count - suffix))
            var resized = IndexSet()
            var changed: [Int] = []
            for index in 0..<prefix where previous[index].layout !== next[index].layout {
                changed.append(index)
                if previous[index].height != next[index].height { resized.insert(index) }
            }
            for offset in 0..<suffix {
                let old = previous[oldKeys.count - 1 - offset], new = next[newKeys.count - 1 - offset]
                let index = newKeys.count - 1 - offset
                if old.layout !== new.layout {
                    changed.append(index)
                    if old.height != new.height { resized.insert(index) }
                }
            }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                table.beginUpdates()
                if !removed.isEmpty { table.removeRows(at: removed, withAnimation: []) }
                if !inserted.isEmpty { table.insertRows(at: inserted, withAnimation: []) }
                if !resized.isEmpty { table.noteHeightOfRows(withIndexesChanged: resized) }
                table.endUpdates()
            }
            for index in changed {
                if let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) as? TranscriptCell { configure(cell, index) }
            }
        }
        for key in progressRows {
            guard let index = entries.lastIndex(where: { $0.key == key }) else { continue }
            (table.view(atColumn: 0, row: index, makeIfNecessary: false) as? TranscriptCell)?.refreshProgress()
        }
        // A row that was the newest keeps a cell whose layout did not change: hand the pin on here.
        let newest = entries.last { $0.key != "§bottom" }?.key
        for cell in visibleCells() { cell.footerPinned = cell.key == newest }
        restore(anchor)
        holdKey = nil
        if scrollState.turns != output.turns {
            scrollState.turns = output.turns
            rail.turns = output.turns
            layoutChrome()
            turnKeys = Dictionary(output.turns.enumerated().map { (nativeString($1.rowKey), $0) }, uniquingKeysWith: { first, _ in first })
        }
        let hasRows = entries.contains { if case .timeline = $0.source { return true }; return false }
        if scrollState.hasRows != hasRows { scrollState.hasRows = hasRows }
        if scrollState.flags != output.flags { scrollState.flags = output.flags }
        if !scrollState.loaded { scrollState.loaded = true }
        updateClock()
        Perf.gauge("transcript.rows", Double(entries.count))
        if !revealed, output.complete || !output.input.fresh || entries.count > 0 {
            revealed = true
            prefetchWhenIdle()
            // Put the list where it opens before it is shown: the table's height is settled first, so
            // the first frame is not at the top for a turn of the main loop.
            scrollView.layoutSubtreeIfNeeded()
            if let saved = pendingRestore, let index = entries.firstIndex(where: { $0.key == saved.key }) {
                following = false
                scroll(toY: table.rect(ofRow: index).minY - saved.offset)
            } else if following {
                scrollToBottom(animated: false)
            }
            pendingRestore = nil
            scrollView.alphaValue = 1
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { if self?.following == true { self?.scrollToBottom(animated: false) } }
            }
        }
        scrolled()
        applyFocusIfReady()
        landFind()
    }

    // MARK: Table

    func numberOfRows(in tableView: NSTableView) -> Int { entries.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard row < entries.count else { return 1 }
        let slack = row == entries.count - 1 && entries[row].key == "§bottom" ? bottomSlack : 0
        return max(1, entries[row].height) + slack
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = tableView.makeView(withIdentifier: TranscriptCell.identifier, owner: nil) as? TranscriptCell ?? TranscriptCell(style: style)
        cell.controller = self
        configure(cell, row)
        return cell
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? { TranscriptRowView() }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }

    private func configure(_ cell: TranscriptCell, _ row: Int) {
        guard row < entries.count else { return }
        var entry = entries[row]
        if entry.layout == nil {
            // Scrolled to a row the background has not reached: lay it out now.
            var builder = RowBuilder(style: style, width: column, ui: ui, root: feed?.root, projectId: feed?.projectId, stale: !(feed?.sessionWorking ?? false), suppressesHeldFooter: feed?.suppressesHeldFooter ?? false, supportsRecovery: feed?.supportsRecovery ?? false)
            let layout = Perf.measure("transcript.layoutSync") { builder.build(entry.source, key: entry.key) }
            let estimated = entry.height
            entry = Entry(key: entry.key, source: entry.source, identity: entry.identity, layout: layout, layoutKey: currentKey(entry), height: layout.height)
            entries[row] = entry
            if abs(layout.height - estimated) > 0.5 {
                DispatchQueue.main.async { [weak self] in
                    MainActor.assumeIsolated { self?.noteHeight(of: entry.key) }
                }
            }
        }
        guard let layout = entry.layout else { return }
        cell.setInset(inset)
        cell.configure(key: entry.key, layout: layout, style: style, visible: visiblePart(of: row).offsetBy(dx: -inset, dy: 0))
        cell.applyMarks(rowMarks(entry, layout: layout))
        cell.holdTint(entry.key == findHeld)
        cell.footerPinned = pinsFooter(row)
        cell.rowHovered = entry.key == hoveredRow
    }

    // MARK: Marks

    private static func assistant(_ entry: Entry) -> TimelineItemAssistant? {
        guard case let .timeline(row, _, _) = entry.source, let single = row as? TimelineRowSingle else { return nil }
        return single.item as? TimelineItemAssistant
    }

    private func rowMarks(_ entry: Entry, layout: RowLayout) -> RowMarks {
        var result = markIndex.isEmpty ? RowMarks.none : markIndex.rowMarks(key: entry.key, item: Self.assistant(entry), layout: layout)
        if let shown = findShown, shown.row == entry.key {
            let text = RowText(layout)
            if let range = Self.occurrence(shown.nth, of: shown.needle, in: text.text) {
                for (block, local) in text.pieces(range) {
                    result.highlights[block.fragment, default: [:]][block.cell, default: []].append(TextHighlight(range: local, color: .yellow, markId: "", find: true))
                }
            }
        }
        return result
    }

    // MARK: Find

    /// The item key of the topmost row on screen, in the key space of the hits; nil when none is shown.
    func topItemKey() -> String? {
        guard let row = table.rows(in: scrollView.contentView.bounds).location as Int?, row != NSNotFound, row < entries.count,
              table.rows(in: scrollView.contentView.bounds).length > 0,
              case let .timeline(source, _, _) = entries[row].source else { return nil }
        if let process = source as? TimelineRowProcess { return process.items.first?.key }
        if let trigger = source as? TimelineRowTrigger { return trigger.notices.first?.key }
        return entries[row].key
    }

    private static func occurrence(_ nth: Int, of needle: String, in text: NSString) -> NSRange? {
        guard !needle.isEmpty else { return nil }
        var search = NSRange(location: 0, length: text.length)
        var count = 0
        while search.length > 0 {
            let found = text.range(of: needle, options: [.caseInsensitive], range: search)
            guard found.location != NSNotFound else { return nil }
            if count == nth { return found }
            count += 1
            let next = NSMaxRange(found)
            search = NSRange(location: next, length: text.length - next)
        }
        return nil
    }

    /// The words of the occurrence on show as a quote, so the scroll reuses [quoteRect].
    private func findQuote(row index: Int, nth: Int, needle: String) -> MarkQuote? {
        guard let layout = entries[index].layout else { return nil }
        let text = RowText(layout)
        guard let range = Self.occurrence(nth, of: needle, in: text.text) else { return nil }
        return MarkQuote(exact: text.text.substring(with: range), prefix: "", suffix: "", start: KotlinInt(int: Int32(range.location)), end: KotlinInt(int: Int32(NSMaxRange(range))))
    }

    /// Takes what find asks of the transcript: a new target to scroll to, or the end of it.
    private func applyFind(_ state: FindState?) {
        guard let state, state.open, !state.needle.isEmpty else {
            pendingFind = nil
            if findShown != nil || findHeld != nil {
                findShown = nil
                findHeld = nil
                refreshMarks()
            }
            return
        }
        if let shown = findShown, shown.needle != state.needle {
            findShown = nil
            findHeld = nil
            refreshMarks()
        }
        guard let target = state.target, target.request != findHandled else { return }
        findHandled = target.request
        pendingFind = target
        findNeedle = state.needle
        landFind()
    }

    private var findNeedle = ""

    /// Scrolls to the pending target once its row is among the rows held, then highlights it.
    private func landFind() {
        guard let target = pendingFind, revealed, let found = findRow?(target.key),
              entries.contains(where: { $0.key == found.row }) else { return }
        pendingFind = nil
        let nth = Int(target.nth), needle = findNeedle
        // [nth] counts within the target item. A row holding several items (a process, a batch of
        // notices) runs their texts together, where that nth could be an earlier item's: the item
        // flashes instead of the wrong words being marked.
        guard found.item == nil else {
            findShown = nil
            findHeld = found.row
            refreshMarks()
            settle(on: found.row, item: found.item, quote: nil)
            return
        }
        findShown = (found.row, nth, needle)
        let index = entries.firstIndex(where: { $0.key == found.row })
        findHeld = index.flatMap { findQuote(row: $0, nth: nth, needle: needle) } == nil ? found.row : nil
        refreshMarks()
        settle(on: found.row, item: nil, quote: nil, find: (nth, needle))
    }

    /// The marks changed: every row view the table holds shows the new ones.
    private func refreshMarks() {
        table.enumerateAvailableRowViews { rowView, row in
            guard row < entries.count, let layout = entries[row].layout,
                  let cell = rowView.view(atColumn: 0) as? TranscriptCell else { return }
            cell.applyMarks(rowMarks(entries[row], layout: layout))
            cell.holdTint(entries[row].key == findHeld)
        }
    }

    /// What the menu of row [key] needs to mark its answer; nil for a row that is not a finished
    /// answer, or where the transcript does not mark.
    /// What the menu of fragment [index] of row [key] needs to save the picture or file its process
    /// item shows; nil outside a process item, or where the transcript does not mark.
    func assetContext(row key: String, fragment index: Int) -> (item: any TimelineItem, marks: [Mark], perform: (MarkCommand) -> Void)? {
        guard let perform = actions.mark, let entry = entries.first(where: { $0.key == key }), let layout = entry.layout,
              let span = layout.items.first(where: { $0.fragments.contains(index) }), MarksStore.markable(span.item) else { return nil }
        return (span.item, markIndex.marks(for: span.item), perform)
    }

    func markContext(row key: String) -> TranscriptMarkContext? {
        guard let perform = actions.mark, let entry = entries.first(where: { $0.key == key }),
              let item = Self.assistant(entry), MarksStore.markable(item) else { return nil }
        return TranscriptMarkContext(item: item, marks: markIndex.marks(for: item), perform: perform)
    }

    /// The finished answer of row [key] for 导出为图片, with the question that started its turn when
    /// that is loaded; nil for any other row, or where the transcript does not export.
    func shareAnswer(row key: String) -> ShareSource? {
        guard let entry = entries.first(where: { $0.key == key }) else { return nil }
        if let item = Self.assistant(entry), MarksStore.markable(item) {
            return shareSource(row: key, kind: .message, text: item.text)
        }
        // A turn without a final answer keeps its prose on the process or result carrying its footer.
        if case let .timeline(row, _, _) = entry.source,
           let answer = (row as? TimelineRowSingle)?.answerText ?? (row as? TimelineRowProcess)?.answerText, !answer.isEmpty {
            return shareSource(row: key, kind: .message, text: answer)
        }
        return nil
    }

    /// [text] of row [key] for 导出图片, dated by the row's message or, in a process block, by the
    /// turn it ended.
    func shareSource(row key: String, kind: ShareSource.Kind, text: String) -> ShareSource? {
        guard actions.exportImage != nil, let index = entries.firstIndex(where: { $0.key == key }) else { return nil }
        var at: Date?
        if case let .timeline(row, _, _) = entries[index].source {
            if let single = row as? TimelineRowSingle { at = ServerTime.date(single.item.event.createdAt) }
            else if let process = row as? TimelineRowProcess { at = process.endedAt.flatMap(ServerTime.date) }
        }
        var runId: String?
        var fullText: String?
        if case let .timeline(row, _, _) = entries[index].source {
            let turnKey = (row as? TimelineRowSingle)?.turnKey ?? (row as? TimelineRowProcess)?.turnKey
            runId = turnKey.flatMap { runIdFromTurnKey(turnKey: $0) }
            if kind == .span { fullText = Self.assistant(entries[index])?.text ?? Self.answer(of: row)?.text }
        }
        var question: String?
        if kind == .message {
            for entry in entries[..<index].reversed() {
                guard case let .timeline(row, _, _) = entry.source, let single = row as? TimelineRowSingle,
                      let user = single.item as? TimelineItemUser else { continue }
                question = user.text
                break
            }
        }
        return ShareSource(kind: kind, text: text, projectId: feed?.projectId, at: at, fullText: fullText, runId: runId, prompt: { [question] in (question, nil) })
    }

    /// The settled answer of [row] and its run: what a plugin command runs on and a result is matched by.
    nonisolated static func answer(of row: any TimelineRow) -> (text: String, runId: String?)? {
        switch onEnum(of: row) {
        case let .single(single):
            guard single.settled, !(single.item is TimelineItemUser) else { return nil }
            let text = single.answerText ?? (single.item as? TimelineItemAssistant)?.text
            return text.map { ($0, runIdFromTurnKey(turnKey: single.turnKey)) }
        case let .process(process):
            guard process.settled, let text = process.answerText else { return nil }
            return (text, runIdFromTurnKey(turnKey: process.turnKey))
        default:
            return nil
        }
    }

    /// Runs the message command [id] on the answer of row [key], when it has one a command can take.
    func runMessageCommand(_ id: String, row key: String) {
        guard let entry = entries.first(where: { $0.key == key }), case let .timeline(row, _, _) = entry.source,
              let answer = Self.answer(of: row) else { return }
        actions.runMessageCommand(id, answer.text, answer.runId)
    }

    /// Whether the answer of row [key] can take a message command: settled, not empty, within the budget.
    func takesMessageCommands(row key: String) -> Bool {
        guard !actions.messageCommands.isEmpty, let entry = entries.first(where: { $0.key == key }), case let .timeline(row, _, _) = entry.source,
              let answer = Self.answer(of: row) else { return false }
        return !answer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && answer.text.utf16.count <= Int(BudgetsKt.PLUGIN_COMMAND_BUDGET_MESSAGE_CHARS)
    }

    /// Opens 导出图片 once the menu that asked for it has closed.
    func exportImage(_ source: ShareSource) {
        DispatchQueue.main.async { [weak self] in self?.actions.exportImage?(source) }
    }

    func restoreInput(row key: String) -> (() -> Void)? {
        guard let restore = actions.restoreInput,
              let entry = entries.first(where: { $0.key == key }),
              case let .timeline(row, _, _) = entry.source,
              let single = row as? TimelineRowSingle, let user = single.item as? TimelineItemUser,
              let run = user.run, SessionComposerKt.canRestoreUnsentMessage(run: run) else { return nil }
        return { restore(run) }
    }

    private func noteHeight(of key: String) {
        guard let index = entries.firstIndex(where: { $0.key == key }) else { return }
        let anchor = captureAnchor()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: index))
        }
        restore(anchor)
    }

    /// The part of [row] on screen in the row's coordinates; for a row prepared just off screen, the
    /// end of it that will scroll in first.
    private func visiblePart(of row: Int) -> CGRect {
        let rect = table.rect(ofRow: row)
        let clip = scrollView.contentView.bounds
        let shown = rect.intersection(clip)
        if !shown.isNull, shown.height > 0 { return shown.offsetBy(dx: -rect.minX, dy: -rect.minY) }
        let height = clip.height
        return rect.minY >= clip.maxY
            ? CGRect(x: 0, y: 0, width: rect.width, height: height)
            : CGRect(x: 0, y: max(0, rect.height - height), width: rect.width, height: height)
    }

    /// Lets each visible row materialise the fragments that scrolled near the viewport.
    private func revealFragments() {
        let rows = table.rows(in: scrollView.contentView.bounds)
        guard rows.length > 0 else { return }
        for row in rows.location..<NSMaxRange(rows) {
            (table.view(atColumn: 0, row: row, makeIfNecessary: false) as? TranscriptCell)?.show(visiblePart(of: row))
        }
    }

    private func visibleKeys() -> [String] {
        let rows = table.rows(in: scrollView.contentView.bounds)
        guard rows.length > 0, NSMaxRange(rows) <= entries.count else { return [] }
        return (rows.location..<NSMaxRange(rows)).map { entries[$0].key }
    }

    private func visibleCells() -> [TranscriptCell] {
        let rows = table.rows(in: scrollView.contentView.bounds)
        guard rows.length > 0 else { return [] }
        return (rows.location..<NSMaxRange(rows)).compactMap { table.view(atColumn: 0, row: $0, makeIfNecessary: false) as? TranscriptCell }
    }

    // MARK: Actions

    func perform(_ action: TranscriptAction, row key: String) {
        switch action {
        case let .toggleToolRun(id, open):
            guard let index = entries.firstIndex(where: { $0.key == key }) else { return }
            ui.setToolRunChoice(id, open: !open, row: key)
            relayout(index)
        case .toggleProcess, .toggle, .toggleWrap, .toggleRendered:
            guard let index = entries.firstIndex(where: { $0.key == key }) else { return }
            if case .toggleProcess = action, case let .timeline(row, _, _) = entries[index].source, let process = row as? TimelineRowProcess {
                ui.toggleProcess(process, key: key)
            } else {
                ui.toggle(action, row: key)
            }
            relayout(index)
        case let .openSubagent(id, title):
            actions.openSubagent?(id, title)
        case .openSessionInfo:
            actions.openSessionInfo()
        case let .copyText(text):
            copyToPasteboard(text)
        case let .dismissCommandResult(id):
            actions.dismissCommandResult(id)
        case let .retryCommandResult(id):
            actions.retryCommandResult(id)
        case let .chooseCommandModel(use):
            actions.chooseCommandModel(use)
        case .retryHistory:
            actions.retryHistory()
        case let .checkRun(run):
            actions.checkRun?(run)
        case let .retryRun(run):
            actions.retryRun?(run)
        case let .openFile(path, line):
            actions.openFile(path, line)
        case let .openURL(url):
            if let id = SessionLink.sessionId(url) {
                actions.openSession(id)
            } else if let target = FileLink.parse(url) {
                actions.openFile(actions.resolveFile(target.path), target.line)
            } else if url.scheme != MathText.scheme {
                NSWorkspace.shared.open(url)
            }
        case let .openImage(item):
            ImageViewer.shared.show(item)
        case let .previewAttachment(id, name):
            AttachmentPreview.present(id: id, name: name)
        case let .downloadAttachment(id, name):
            Task {
                if let error = await ProjectDownloads.saveAttachment(id: id, name: name) {
                    let alert = NSAlert()
                    alert.messageText = String(localized: "无法下载附件")
                    alert.informativeText = error
                    alert.runModal()
                }
            }
        case let .openVisualization(path, title, wide):
            actions.openVisualization(path, title, wide)
        case let .stopActivity(id, warning):
            if let warning {
                let alert = NSAlert()
                alert.messageText = String(localized: "停止后台任务？")
                alert.informativeText = warning
                alert.addButton(withTitle: String(localized: "停止"))
                alert.addButton(withTitle: String(localized: "取消"))
                guard alert.runModal() == .alertFirstButtonReturn else { return }
            }
            ui.setStopping(id, true, row: key)
            relayout(row: key)
            Task { @MainActor in
                if await actions.stopActivity(id) {
                    // The server's state is the answer; a CLI that refused leaves the task running.
                    try? await Task.sleep(for: .seconds(TranscriptUIStore.stopGrace))
                }
                ui.setStopping(id, false, row: key)
                relayout(row: key)
            }
        case let .loadSessionReference(blobRef):
            ui.beginActivityText(blobRef, row: key)
            relayout(row: key)
            Task { @MainActor in
                let raw = await actions.activityText(blobRef)
                ui.finishReference(blobRef, pages: raw.map { sessionReferencePages(raw: $0) }, row: key)
                relayout(row: key)
            }
        case let .sessionReferencePage(blobRef, page):
            ui.moveReference(blobRef, page: page, row: key)
            relayout(row: key)
        case let .loadActivityText(blobRef):
            ui.beginActivityText(blobRef, row: key)
            relayout(row: key)
            Task { @MainActor in
                ui.finishActivityText(blobRef, text: await actions.activityText(blobRef), row: key)
                relayout(row: key)
            }
        }
    }

    private func relayout(row key: String) {
        guard let index = entries.firstIndex(where: { $0.key == key }) else { return }
        relayout(index)
    }

    /// Lays one row out again on the spot (a disclosure the reader just toggled), keeping the row
    /// where it is on screen.
    private func relayout(_ index: Int) {
        let entry = entries[index]
        if building { dirty = true }
        var builder = RowBuilder(style: style, width: column, ui: ui, root: feed?.root, projectId: feed?.projectId, stale: !(feed?.sessionWorking ?? false), suppressesHeldFooter: feed?.suppressesHeldFooter ?? false, supportsRecovery: feed?.supportsRecovery ?? false)
        let layout = Perf.measure("transcript.toggle") { builder.build(entry.source, key: entry.key) }
        let clip = scrollView.contentView.bounds
        let offset = table.rect(ofRow: index).minY - clip.minY
        let wasFollowing = following
        // Opening a row is not a request to follow the end.
        following = following && offset + layout.height <= clip.height
        entries[index] = Entry(key: entry.key, source: entry.source, identity: entry.identity, layout: layout, layoutKey: currentKey(entry), height: layout.height)
        if let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) as? TranscriptCell { configure(cell, index) }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: index))
        }
        if following && wasFollowing {
            scrollToBottom(animated: false)
        } else {
            // Collapsing near the end leaves less below the row than the viewport needs: slack under
            // the last row keeps the header that was clicked where it was.
            let y = table.rect(ofRow: index).minY - offset
            setBottomSlack(slackNeeded(at: y))
            scroll(toY: y)
        }
        updateClock()
    }

    private func resourceReady(_ token: String) {
        var hit = false
        for entry in entries where entry.layout?.pending.contains(token) == true {
            refresh[entry.key, default: 0] += 1
            hit = true
        }
        if hit { requestBuild() }
    }

    // MARK: Scrolling

    private func userScrolled(after delay: Double, event: NSEvent? = nil) {
        userScrolling = true
        // The first upward wheel delta leaves follow mode, even inside the 48-point zone used
        // for the back button. A slow gesture otherwise gets pulled down by the next streamed row.
        if let event, event.momentumPhase.isEmpty {
            if event.scrollingDeltaY > 0 {
                scrollingAway = true
                following = false
            } else if event.scrollingDeltaY < 0 {
                scrollingAway = false
            }
        }
        userScrollEnds?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.userScrolling = false
                // Back at the end of the rows: follow again, and give up any slack under them.
                if !self.scrollingAway, self.atRowsEnd, self.bottomSlack > 0 {
                    self.scrollToBottom(animated: true)
                } else {
                    self.following = !self.scrollingAway && self.bottomSlack == 0 && self.atRowsEnd
                }
                self.scrollingAway = false
            }
        }
        userScrollEnds = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// The composer passes the wheel here when its draft cannot scroll further.
    func forwardedWheel() { userScrolled(after: 0.35) }

    /// Before a send lands: follow the end when the latest turn's first row is not below the
    /// viewport, so the message and its reply stay in view; a reader back in an earlier turn stays.
    private func followSent() {
        guard revealed, !following else { return }
        if let index = entries.lastIndex(where: startsTurn), table.rect(ofRow: index).minY > scrollView.contentView.bounds.maxY { return }
        scrollToBottom(animated: false)
    }

    /// A prompt on the turn rail, or the notices that woke a turn.
    private func startsTurn(_ entry: Entry) -> Bool {
        if turnKeys[entry.key] != nil { return true }
        if case let .timeline(row, _, _) = entry.source { return row is TimelineRowTrigger }
        return false
    }

    private var maxY: CGFloat {
        max(-scrollView.contentInsets.top, table.frame.height - scrollView.contentView.bounds.height + scrollView.contentInsets.bottom)
    }

    // MARK: Bottom slack

    /// Blank space added under the last row (`§bottom`) when rows near the end shrink under a reader
    /// who is not following (a block collapsed, a row laid out shorter): without it the list would
    /// clamp to its new end and move what the reader is looking at down. It is given up as soon as
    /// it is out of view: the reader scrolling up, or rows growing into it.
    private var bottomSlack: CGFloat = 0

    /// Where the rows end, without the slack.
    private var rowsEnd: CGFloat {
        guard !entries.isEmpty, table.numberOfRows == entries.count else { return table.frame.height - bottomSlack }
        return table.rect(ofRow: entries.count - 1).maxY - bottomSlack
    }

    /// Following resumes only at the actual end. The wider 48-point threshold is for chrome.
    private var atRowsEnd: Bool {
        scrollView.contentView.bounds.maxY >= rowsEnd + scrollView.contentInsets.bottom - 0.5
    }

    /// The slack that lets the list scroll to [y]: none while the rows alone reach it.
    private func slackNeeded(at y: CGFloat) -> CGFloat {
        let insets = scrollView.contentInsets
        let reach = rowsEnd - scrollView.contentView.bounds.height + insets.bottom
        return y > max(-insets.top, reach) + 0.5 ? y - reach : 0
    }

    private func setBottomSlack(_ value: CGFloat) {
        guard !entries.isEmpty, table.numberOfRows == entries.count else { return }
        let value = entries[entries.count - 1].key == "§bottom" ? max(0, ceil(value)) : 0
        guard value != bottomSlack else { return }
        bottomSlack = value
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            context.allowsImplicitAnimation = false
            table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: entries.count - 1))
        }
    }

    /// Keeps only the slack still in view.
    private func trimBottomSlack() {
        guard bottomSlack > 0 else { return }
        let needed = slackNeeded(at: scrollView.contentView.bounds.minY)
        if needed < bottomSlack { setBottomSlack(needed) }
    }

    private func scroll(toY y: CGFloat) {
        let clip = scrollView.contentView
        var bounds = clip.bounds
        bounds.origin.y = y
        programmatic = true
        clip.scroll(to: clip.constrainBoundsRect(bounds).origin)
        scrollView.reflectScrolledClipView(clip)
        programmatic = false
    }

    func scrollToBottom(animated: Bool) {
        settleTimer?.invalidate()
        settleTimer = nil
        following = true
        scrollingAway = false
        if showsChrome { back.setShown(false) }
        if animated {
            let clip = scrollView.contentView
            var bounds = clip.bounds
            // Down to the end of the rows; slack under them goes once the list is there.
            bounds.origin.y = bottomSlack > 0 ? max(-scrollView.contentInsets.top, maxY - bottomSlack) : maxY
            let target = clip.constrainBoundsRect(bounds).origin
            programmatic = true
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.28
                context.allowsImplicitAnimation = true
                clip.animator().setBoundsOrigin(target)
            } completionHandler: {
                MainActor.assumeIsolated {
                    self.programmatic = false
                    if self.following { self.setBottomSlack(0) }
                    self.scrollView.reflectScrolledClipView(clip)
                    self.scrolled()
                }
            }
        } else {
            setBottomSlack(0)
            scroll(toY: maxY)
        }
        scrollState.atBottom = true
    }

    /// Jumps to the row [key] (a turn on the rail, a search hit); stops following.
    func scroll(to key: String, center: Bool, animated: Bool, flash: Bool = false) {
        settleTimer?.invalidate()
        settleTimer = nil
        guard let index = entries.firstIndex(where: { $0.key == key }) else { return }
        following = false
        let rect = table.rect(ofRow: index)
        let clip = scrollView.contentView
        let y = center ? rect.midY - clip.bounds.height / 2 : rect.minY - 8
        if animated {
            var bounds = clip.bounds
            bounds.origin.y = y
            let target = clip.constrainBoundsRect(bounds).origin
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.3
                context.allowsImplicitAnimation = true
                clip.animator().setBoundsOrigin(target)
            } completionHandler: {
                MainActor.assumeIsolated { self.scrollView.reflectScrolledClipView(clip) }
            }
        } else {
            scroll(toY: y)
        }
        if flash { (table.view(atColumn: 0, row: index, makeIfNecessary: true) as? TranscriptCell)?.flash() }
    }

    /// The viewport's top edge, measured down from the top of the window's content.
    private var lastTop: CGFloat?

    private func viewportTop() -> CGFloat? {
        guard let content = view.window?.contentView else { return nil }
        return content.convert(content.bounds, to: nil).maxY - scrollView.convert(scrollView.bounds, to: nil).maxY
    }

    private func viewportChanged() {
        let top = viewportTop()
        defer { lastTop = top }
        if following { scrollToBottom(animated: false); return }
        // Something above the list came or went (a notice): the rows being read stay where they are
        // on screen. At the start of the list they move with the edge instead, so the first rows stay in view.
        if revealed, let top, let lastTop, abs(top - lastTop) > 0.5,
           scrollView.contentView.bounds.minY > -scrollView.contentInsets.top + 0.5 {
            let y = scrollView.contentView.bounds.minY + top - lastTop
            setBottomSlack(slackNeeded(at: y))
            scroll(toY: y)
        }
        scrolled()
    }

    private func scrolled() {
        trimBottomSlack()
        let clip = scrollView.contentView.bounds
        // The end of the rows in view is the bottom, whatever slack is held under them.
        let bottom = clip.maxY >= rowsEnd + scrollView.contentInsets.bottom - 48
        if scrollState.atBottom != bottom { scrollState.atBottom = bottom }
        if showsChrome { back.setShown(!bottom && scrollState.hasRows) }
        // With slack under the rows, following resumes when the scroll ends (`userScrolled`), which lets the slack go.
        if !programmatic, userScrolling { following = !scrollingAway && atRowsEnd && bottomSlack == 0 }
        revealFragments()
        updateActiveTurn()
        updateChapters()
        updateHover(nil)
        loadOlderIfNeeded()
        remember()
    }

    private func updateActiveTurn() {
        let turns = scrollState.turns
        guard turns.count >= 2 else { return }
        var active = turns.count - 1
        if !scrollState.atBottom {
            let clip = scrollView.contentView.bounds
            let line = clip.minY + min(96, clip.height * 0.2)
            let row = table.row(at: NSPoint(x: clip.midX, y: line))
            if row >= 0 {
                active = 0
                var index = min(row, entries.count - 1)
                while index >= 0 {
                    if let turn = turnKeys[entries[index].key] { active = turn; break }
                    index -= 1
                }
            }
        }
        if scrollState.activeTurn != active { scrollState.activeTurn = active }
        rail.active = active
    }

    /// Only the standalone answer under the reading line owns navigation. A user message,
    /// process, footer or gap never borrows the next answer's headings.
    private func updateChapters() {
        defer { layoutChapters() }
        chapterRowKey = nil
        chapterRowIndex = nil
        guard showsChrome, chapterNavigationEnabled, !entries.isEmpty else {
            return
        }
        let clip = scrollView.contentView.bounds
        let readingY = clip.minY + min(96, clip.height * 0.2)
        let index = table.row(at: NSPoint(x: clip.midX, y: readingY))
        guard entries.indices.contains(index), let layout = entries[index].layout,
              let body = layout.answerBody, layout.chapters.count >= 2 else {
            return
        }
        let localY = readingY - table.rect(ofRow: index).minY
        guard localY >= body.minY, localY < body.maxY else { return }
        chapterRowKey = entries[index].key
        chapterRowIndex = index
        chapterActive = layout.chapters.lastIndex { $0.rect.minY <= localY } ?? 0
    }

    /// Older history is read before the reader gets to it: within about two screens of the oldest
    /// loaded row. The store ignores the request while a page is in flight; this runs again when
    /// the page has landed (the feed changes), so a short transcript fills up. Rows keep their
    /// keys, so [apply] holds the reader's place while the page goes in above.
    private func loadOlderIfNeeded() {
        guard revealed, feed?.older == .idle else { return }
        let clip = scrollView.contentView.bounds
        guard clip.minY + scrollView.contentInsets.top <= Self.olderPrefetchScreens * clip.height else { return }
        // At the bottom of a long transcript nobody is near the top: only the one idle prefetch below.
        if !following || idle { actions.loadOlder() }
    }

    /// How far above the viewport (in viewports) the oldest loaded row may be before older history is read.
    private static let olderPrefetchScreens: CGFloat = 2

    /// The first rows have been on screen for a moment: read one page ahead.
    private func prefetchWhenIdle() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.idle = true
                if self.feed?.older == .idle { self.actions.loadOlder() }
            }
        }
    }

    /// Scrolls to the pending focus once its row is loaded. An exact focus not loaded yet reads
    /// older pages, one at a time as each lands, and gives up at the start of the history or after
    /// `focusPageLimit` pages.
    private func applyFocusIfReady() {
        guard let focus = pendingFocus, revealed, let match = focusRowKey(focus) else { return }
        switch match {
        case let .row(key, item):
            pendingFocus = nil
            settle(on: key, item: item, quote: focus.quote)
        case .older:
            switch feed?.older {
            case .idle? where focusPages < Self.focusPageLimit:
                focusPages += 1
                actions.loadOlder()
            case .loading?:
                break
            default:
                pendingFocus = nil
                actions.focusMissed()
            }
        }
    }

    static let focusPageLimit = 30

    /// Scrolls to row [key], or to the words [quote] names in it, and holds the place while the rows
    /// around it settle: rows above are measured and older pages land after the first placement, and
    /// each moves the content under a fixed scroll offset. A short target is centred; a tall one
    /// starts near the top, so its beginning is what the reader sees. Scrolling by hand ends it.
    private func settle(on key: String, item: String?, quote: MarkQuote?, chapter: String? = nil, find: (nth: Int, needle: String)? = nil) {
        settleTimer?.invalidate()
        settleTimer = nil
        following = false
        if chapter != nil {
            userScrollEnds?.cancel()
            userScrolling = false
            scrollingAway = false
        }
        // An item inside a folded process block: open the block so the item is drawn.
        if let item, let index = entries.firstIndex(where: { $0.key == key }), case let .timeline(row, _, _) = entries[index].source,
           let process = row as? TimelineRowProcess, !ui.processOpen(process, key: key),
           entries[index].layout?.items.contains(where: { $0.item.key == item }) != true {
            ui.toggleProcess(process, key: key)
            relayout(index)
        }
        // An item inside a folded run of tools: open the run.
        if let item, let index = entries.firstIndex(where: { $0.key == key }),
           entries[index].layout?.items.contains(where: { $0.item.key == item }) != true,
           ui.revealToolRun(containing: item, row: key) {
            relayout(index)
        }
        let deadline = Date().addingTimeInterval(1.5)
        var still = 0
        let place: @MainActor () -> Bool = { [weak self] in
            guard let self, !self.userScrolling, let index = self.entries.firstIndex(where: { $0.key == key }) else { return false }
            let chapterRect = chapter.flatMap { chapter -> CGRect? in
                guard let value = self.entries[index].layout?.chapterAnchors.first(where: { $0.id == chapter }) else { return nil }
                return value.rect.offsetBy(dx: 0, dy: self.table.rect(ofRow: index).minY)
            }
            if chapter != nil, chapterRect == nil { return false }
            let words = quote ?? find.flatMap { self.findQuote(row: index, nth: $0.nth, needle: $0.needle) }
            let rect = chapterRect ?? words.flatMap { self.quoteRect(row: index, quote: $0) } ?? item.flatMap { self.itemRect(row: index, item: $0) } ?? self.table.rect(ofRow: index)
            let clip = self.scrollView.contentView
            var bounds = clip.bounds
            bounds.origin.y = chapter != nil || rect.height > bounds.height * 0.6 ? rect.minY - 56 : rect.midY - bounds.height / 2
            let target = clip.constrainBoundsRect(bounds).origin.y
            if abs(target - clip.bounds.minY) > 1 { self.scroll(toY: target); still = 0 } else { still += 1 }
            let pending = chapter != nil && (self.building || self.entries[index].layout?.pending.isEmpty == false)
            return (still < 12 || pending) && Date() < deadline
        }
        let more = place()
        if chapter == nil, let index = entries.firstIndex(where: { $0.key == key }),
           find == nil || findQuote(row: index, nth: find!.nth, needle: find!.needle) == nil {
            (table.view(atColumn: 0, row: index, makeIfNecessary: true) as? TranscriptCell)?.flash()
        }
        guard more else { return }
        settleTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard place() else {
                    timer.invalidate()
                    if self?.settleTimer === timer { self?.settleTimer = nil }
                    return
                }
            }
        }
    }

    /// Where item [key] of a process block is drawn in row [index], in the table's coordinates.
    private func itemRect(row index: Int, item key: String) -> CGRect? {
        guard let layout = entries[index].layout, let span = layout.items.first(where: { $0.item.key == key }), !span.fragments.isEmpty else { return nil }
        let drawn = span.fragments.map { layout.fragments[$0].frame }.reduce(CGRect.null) { $0.union($1) }
        let row = table.rect(ofRow: index)
        return drawn.offsetBy(dx: row.minX, dy: row.minY)
    }

    /// Where the words [quote] names are drawn in row [index], in the table's coordinates; nil when
    /// the row does not hold them. A table cell counts as its whole table.
    private func quoteRect(row index: Int, quote: MarkQuote) -> CGRect? {
        guard let layout = entries[index].layout else { return nil }
        let text = RowText(layout)
        guard let range = text.locate(quote) else { return nil }
        var union: CGRect?
        for (block, local) in text.pieces(range) {
            let fragment = layout.fragments[block.fragment]
            var rect = fragment.frame
            switch fragment.kind {
            case .text, .codeBody:
                let manager = block.layout.manager
                let glyphs = manager.glyphRange(forCharacterRange: local, actualCharacterRange: nil)
                var drawn = manager.boundingRect(forGlyphRange: glyphs, in: block.layout.container)
                if case let .codeBody(spec) = fragment.kind { drawn = drawn.offsetBy(dx: spec.inset, dy: spec.inset) }
                rect = drawn.offsetBy(dx: fragment.frame.minX, dy: fragment.frame.minY)
            default: break
            }
            union = union.map { $0.union(rect) } ?? rect
        }
        let row = table.rect(ofRow: index)
        return union?.offsetBy(dx: row.minX, dy: row.minY)
    }

    /// Where [focus] is among the loaded rows (`TimelineGrouping.rowOfItem`); nil until the rows are there.
    var focusRowKey: (TranscriptFocus) -> TranscriptFocusMatch? = { _ in nil }

    // MARK: Hover and clock

    override func mouseMoved(with event: NSEvent) { updateHover(event.locationInWindow, moved: true) }
    override func mouseEntered(with event: NSEvent) { updateHover(event.locationInWindow, moved: true) }
    override func mouseExited(with event: NSEvent) {
        updateChapterEmphasis()
        setHoverTarget(nil)
        restFooter(on: nil, moved: true)
        if let shown = cursorShown, shown !== NSCursor.arrow { NSCursor.arrow.set() }
        cursorShown = nil
    }

    private weak var hoverTarget: (NSView & HoverTarget)?
    private var cursorShown: NSCursor?

    /// Hover for the fragment under the pointer, from the list's one tracking area.
    /// The cursor changes only when the pointer moves: setting it is expensive
    /// with a customised system pointer, and content scrolling under a still pointer needs none.
    private func updateHover(_ location: NSPoint?, moved: Bool = false) {
        updateChapterEmphasis(location)
        guard let window = view.window else { return setHoverTarget(nil) }
        let point = location ?? window.mouseLocationOutsideOfEventStream
        guard scrollView.bounds.contains(scrollView.convert(point, from: nil)), let superview = table.superview else {
            setHoverTarget(nil)
            restFooter(on: nil, moved: true)
            return
        }
        restFooter(on: footerKey(at: point), moved: moved)
        var target: (NSView & HoverTarget)?
        var hit = table.hitTest(superview.convert(point, from: nil))
        while let view = hit, view !== table {
            if let candidate = view as? (NSView & HoverTarget) {
                target = candidate
                break
            }
            hit = view.superview
        }
        setHoverTarget(target)
        guard moved else { return }
        // Only on pointer moves: changing the tooltip re-sets the cursor, too costly while scrolling.
        var helped = table.hitTest(superview.convert(point, from: nil))
        var help: String?
        while let view = helped, view !== table, help == nil {
            help = (view as? FragmentView)?.help
            helped = view.superview
        }
        if scrollView.toolTip != help { scrollView.toolTip = help }
        let cursor = target.map { $0.cursor(at: $0.convert(point, from: nil)) } ?? .arrow
        if cursor !== cursorShown {
            cursor.set()
            cursorShown = cursor
        }
    }

    /// A footer's invisible padding may cross into the next row's gap. Check only nearby,
    /// already materialised cells, keeping the current target when padded regions overlap.
    private func footerKey(at windowPoint: NSPoint) -> String? {
        let point = table.convert(windowPoint, from: nil)
        let above = style.rhythm.footerHoverPadding
        let below = style.rhythm.block
        let rows = table.rows(in: CGRect(x: table.bounds.minX, y: point.y - below, width: table.bounds.width, height: above + below))
        guard rows.location != NSNotFound, rows.length > 0, rows.location < entries.count else { return nil }
        let end = rows.location + min(rows.length, entries.count - rows.location)
        var first: String?
        var resting: String?
        for row in rows.location..<end {
            guard let cell = table.view(atColumn: 0, row: row, makeIfNecessary: false) as? TranscriptCell,
                  cell.showsFooter(at: windowPoint) else { continue }
            let key = entries[row].key
            if key == hoveredRow { return key }
            if key == restingRow { resting = key }
            if first == nil { first = key }
        }
        return resting ?? first
    }

    /// The prose, its navigation and their narrow connecting gutter are one hover region.
    private func updateChapterEmphasis(_ location: NSPoint? = nil) {
        guard let window = view.window, let key = chapters.ownerKey, key == chapterRowKey,
              let index = chapterRowIndex, entries.indices.contains(index), entries[index].key == key,
              let body = entries[index].layout?.answerBody,
              let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) as? TranscriptCell else {
            chapters.emphasized = false
            return
        }
        let prose = view.convert(body, from: cell)
        let navigation = view.convert(chapters.bounds, from: chapters)
        let region = prose.union(navigation).intersection(view.convert(scrollView.contentView.bounds, from: scrollView.contentView))
        let point = view.convert(location ?? window.mouseLocationOutsideOfEventStream, from: nil)
        chapters.emphasized = region.contains(point)
    }

    /// The row under the pointer shows its message footer; the others keep it hidden.
    private var hoveredRow: String?

    /// The footer the pointer is on, until it has rested there long enough to show.
    private var restingRow: String?
    private var restTimer: Timer?
    /// How long the pointer stays still on a footer's line before its time and actions appear.
    private static let footerRest: TimeInterval = 0.15

    /// A footer shows once the pointer has rested on its line for `footerRest`, and hides as soon
    /// as the pointer leaves it. Moving along the line starts the wait again; scrolling does not.
    private func restFooter(on key: String?, moved: Bool) {
        guard let key else {
            restTimer?.invalidate()
            restTimer = nil
            restingRow = nil
            setHoveredRow(nil)
            return
        }
        if key == hoveredRow { return }
        if hoveredRow != nil { setHoveredRow(nil) }
        if key == restingRow, !moved { return }
        restingRow = key
        restTimer?.invalidate()
        restTimer = Timer.scheduledTimer(withTimeInterval: Self.footerRest, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.restingRow == key else { return }
                self.restingRow = nil
                self.restTimer = nil
                self.setHoveredRow(key)
            }
        }
    }

    private func setHoveredRow(_ key: String?) {
        guard key != hoveredRow else { return }
        hoveredRow = key
        for cell in visibleCells() { cell.rowHovered = cell.key == key }
    }

    /// The newest row keeps its footer on screen: its time, speed and copy are what one reaches for.
    private func pinsFooter(_ row: Int) -> Bool {
        row == entries.lastIndex { $0.key != "§bottom" }
    }

    private func setHoverTarget(_ target: (NSView & HoverTarget)?) {
        guard target !== hoverTarget else { return }
        hoverTarget?.setHovered(false)
        target?.setHovered(true)
        hoverTarget = target
    }

    private func updateClock() {
        let needed = entries.contains { $0.layout?.ticking == true }
        if needed, clock == nil {
            clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.visibleCells().forEach { $0.tick() } }
            }
        } else if !needed {
            clock?.invalidate()
            clock = nil
        }
    }

    // MARK: Bench

    func debugDump() -> String {
        var out = "clip=\(scrollView.contentView.bounds) table=\(table.frame.size) rows=\(entries.count)\n"
        let visible = table.rows(in: scrollView.contentView.bounds)
        for row in max(0, min(visible.location, entries.count - 4))..<entries.count {
            let entry = entries[row]
            let rect = table.rect(ofRow: row)
            let rowView = table.rowView(atRow: row, makeIfNecessary: false)
            let misplaced = rowView.map { abs($0.frame.minY - rect.minY) > 0.5 || abs($0.frame.height - rect.height) > 0.5 } ?? false
            out += "\(misplaced ? "!! " : "")row \(row) key=\(entry.key.prefix(60)) entryH=\(entry.height) layoutH=\(entry.layout?.height ?? -1) rect=\(rect) rowView=\(rowView?.frame ?? .zero)\n"
            if let cell = table.view(atColumn: 0, row: row, makeIfNecessary: false) as? TranscriptCell {
                out += "  cell frame=\(cell.frame) subviews=\(cell.subviews.count) \(cell.debugShown)\n"
            }
            for (i, f) in (entry.layout?.fragments ?? []).enumerated().suffix(12) {
                out += "  f\(i) \(String(describing: f.kind).prefix(60)) \(f.frame)\n"
            }
        }
        return out
    }

    fileprivate var benchRevealed: Bool { revealed }
    fileprivate var benchRows: Int { entries.count }

    /// The [index]th disclosure counted from the end, scrolled into view.
    fileprivate func benchDisclosure(_ index: Int) -> (String, TranscriptAction)? {
        var found: [(String, TranscriptAction)] = []
        for entry in entries.reversed() {
            for fragment in entry.layout?.fragments ?? [] {
                guard case let .disclosure(spec) = fragment.kind else { continue }
                switch spec.action {
                case .toggleProcess, .toggle: found.append((entry.key, spec.action))
                default: continue
                }
            }
            if found.count > index { break }
        }
        guard found.indices.contains(index) else { return nil }
        let (key, action) = found[index]
        scroll(to: key, center: false, animated: false)
        return (key, action)
    }

    fileprivate func benchSetTail(_ tail: (any TimelineRow)?) {
        benchTail = tail
        requestBuild()
    }

    fileprivate var benchEvent: ProjectedEvent? {
        for entry in entries.reversed() {
            if case let .timeline(row, _, _) = entry.source, let single = row as? TimelineRowSingle { return single.item.event }
        }
        return nil
    }
}

extension TranscriptController: TranscriptBenchTarget {
    var benchSessionId: String? { feed?.sessionId }
    var benchScrollView: NSScrollView? { scrollView }
    var benchReady: Bool { benchRevealed && benchRows > 0 }
    var benchRowCount: Int { benchRows }

    func benchToggle(_ index: Int) -> Bool {
        guard let (key, action) = benchDisclosure(index) else { return false }
        perform(action, row: key)
        return true
    }

    func benchStream(text: String, chunk: Int, interval: Double) async {
        guard let event = benchEvent else { return }
        var end = text.startIndex
        while end < text.endIndex {
            end = text.index(end, offsetBy: chunk, limitedBy: text.endIndex) ?? text.endIndex
            let item = TimelineItemAssistant(key: "bench-stream", text: String(text[..<end]), event: event, phase: nil)
            let settled = end == text.endIndex
            benchSetTail(TimelineRowSingle(key: "bench-stream", item: item, turnKey: "bench-stream", settled: settled, footer: settled ? .shown : .held, answerText: nil, stopped: false))
            try? await Task.sleep(for: .seconds(interval))
        }
        try? await Task.sleep(for: .milliseconds(300))
        benchSetTail(nil)
    }
}

/// Holds the transcript and reports what the controller must react to.
final class TranscriptRootView: NSView {
    var onAppearanceChange: (() -> Void)?
    var onLayout: (() -> Void)?

    override var isFlipped: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearanceChange?()
    }

    override func layout() {
        super.layout()
        onLayout?()
    }
}

final class TranscriptScrollView: NSScrollView {
    var onWheel: ((NSEvent) -> Void)?

    override func scrollWheel(with event: NSEvent) {
        onWheel?(event)
        super.scrollWheel(with: event)
    }
}

final class TranscriptTable: NSTableView {
    override func validateProposedFirstResponder(_ responder: NSResponder, for event: NSEvent?) -> Bool { true }
}
