import AppKit
import QuartzCore
import SwiftUI
import RiffetKit

/// A row's context menu actions; they never make two rows differ.
struct SessionRowMenu {
    let togglePin: () -> Void
    let rename: () -> Void
    let editTags: (() -> Void)?
    let reveal: (() -> Void)?
    let toggleArchive: () -> Void
    let openInWindow: () -> Void
    /// Nil when the server cannot delete; the closure says whether the entry is enabled (its preview is loading).
    let delete: (() -> Void)?
    var deleteEnabled = true
    /// The tabs, while the header draws them: the row can add its conversation to the bar or take it out.
    var tabs: SessionTabs?
}

/**
 * What a sidebar row no longer spends width on — the project, the agent and the last activity —
 * composed for its hover card. The relative label is in the text (not just the clock), so a
 * row's card ages at the same minute tick the list already re-renders on.
 */
@MainActor func sessionHoverInfo(session: Session, project: String?, models: [ModelInfo], now: Int64) -> SessionHoverInfo {
    let at = activityAt(session: session)
    let when = [relativeLabel(value: at, now: now) ?? "", formatDateTime(value: at) ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    // The stored model is a raw selection (`…[context=1m,effort=high]`); the card repeats the
    // picker's own summary — the catalog name plus its translated parameter tags — never the spec.
    let model = session.model.map { modelSelectionSummary(catalog: models, selection: $0) } ?? ""
    return SessionHoverInfo(
        title: session.shownTitle.isEmpty ? String(localized: "新会话") : session.shownTitle,
        state: session.state,
        project: project,
        backend: session.agentID,
        agent: backendLabel(session.agentID),
        model: model.isEmpty ? nil : model,
        activity: when.isEmpty ? String(localized: "更早") : when
    )
}

/// One conversation in the sidebar: its state, its title and its tags. The project and the
/// relative time it used to carry live in the hover card (see `sessionHoverInfo`), which
/// keeps a grouped list to one quiet line per conversation. Rows compare by what they show, so
/// re-rendering the list re-measures only the rows that changed: each row is a self-sizing
/// hosting view, and measuring all of them on every switch cost tens of milliseconds.
struct SessionRow: View, Equatable {
    let session: Session
    /// The hover card's text, composed only as the card is about to show: lists re-render their rows
    /// on every switch, and composing it for each row (model names, times) was most of that cost.
    let info: () -> SessionHoverInfo
    var selected = false
    /// Work finished here since the reader last had it open (never true for the open one).
    var unread = false
    /// The row's relative activity, when the surface shows it beside the title (the quick-chat page).
    var activity: String?
    /// The conversation has a saved reply.
    var marked = false
    /// A quick chat: its menu keeps only the actions that apply to one.
    var quickChat = false
    var menu: SessionRowMenu?
    /// The pointer entered (true) or left the row.
    var hover: ((Bool) -> Void)?
    @Environment(\.palette) private var palette
    @State private var anchorBox = HoverAnchorBox()

    init(session: Session, info: @autoclosure @escaping () -> SessionHoverInfo, selected: Bool = false, unread: Bool = false, activity: String? = nil, marked: Bool = false, quickChat: Bool = false, menu: SessionRowMenu? = nil, hover: ((Bool) -> Void)? = nil) {
        self.session = session
        self.info = info
        self.selected = selected
        self.unread = unread
        self.activity = activity
        self.marked = marked
        self.quickChat = quickChat
        self.menu = menu
        self.hover = hover
    }

    static func == (lhs: SessionRow, rhs: SessionRow) -> Bool {
        lhs.session == rhs.session && lhs.selected == rhs.selected && lhs.unread == rhs.unread && lhs.activity == rhs.activity
            && lhs.marked == rhs.marked && lhs.quickChat == rhs.quickChat
    }

    var body: some View {
        HStack(spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 1) {
                Text(session.shownTitle.isEmpty ? String(localized: "新会话") : session.shownTitle)
                    .font(.riffet(size: S(13), weight: unread ? .semibold : selected ? .medium : .regular))
                    .lineLimit(1)
                    .foregroundStyle(session.archivedAt != nil ? palette.fg3 : selected || unread ? palette.fg : palette.fg2)
                if !quickChat, !session.tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(session.tags.prefix(3), id: \.self) { tag in
                            Text(tag).padding(.horizontal, 4).background(selected ? palette.markSoft : palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control))
                        }
                    }
                    .font(.riffet(size: S(10.5)))
                    .foregroundStyle(selected ? palette.fg3 : palette.fg4)
                }
            }
            Spacer(minLength: 0)
            if let activity {
                Text(activity)
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg4)
                    .lineLimit(1)
            }
            if SessionStatePill.shows(session.state, unread: unread) {
                SessionStatePill(state: session.state)
            } else if SessionStatePill.running(session.state) {
                Spinner(size: .mini).help("运行中").accessibilityLabel("运行中")
            } else if unread {
                Circle().fill(palette.fg).frame(width: 6, height: 6).accessibilityLabel("未读")
            } else if session.terminalHold != nil {
                Image(icon: "terminal")
                    .font(.riffet(size: S(10)))
                    .foregroundStyle(palette.fg4)
                    .help("在终端中")
            } else if marked {
                Image(icon: "bookmark.fill")
                    .font(.riffet(size: S(10)))
                    .foregroundStyle(palette.fg4)
            }
        }
        .padding(.vertical, session.tags.isEmpty || quickChat ? 2 : 1)
        .contentShape(Rectangle())
        .sessionRowHover(box: anchorBox, info: info) { hover?($0) }
        .contextMenu {
            if let menu { SessionRowMenuItems(session: session, menu: menu, quickChat: quickChat) }
        }
    }
}

/// Settings' selected row, applied to the List's direct row so SwiftUI forwards the row trait. Like
/// the drawn sidebar's and the web's `bg-active`: a neutral wash, no outline — an outline reads as
/// keyboard focus, and the accent is kept for states that ask for attention.
struct SidebarSelectionBackground: View {
    @Environment(\.palette) private var palette
    /// An inactive window quiets the wash to the hover tone, as AppKit's source lists do.
    @Environment(\.appearsActive) private var appearsActive

    var body: some View {
        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            .fill(appearsActive ? palette.bgActive : palette.bgHover)
            // List row backgrounds span the full sidebar; keep the highlight inside its chrome
            // without changing the native content insets or reducing the text's available width.
            .padding(.horizontal, Space.sm + Space.xxs)
    }
}

/// Running spins, waiting asks for attention, a failure not yet seen is red; idle conversations show nothing.
struct SessionStateMark: View {
    let state: SessionState
    @Environment(\.palette) private var palette

    /// Whether the state is one the row calls out. A failure once seen is told in the conversation
    /// itself, not on the row (docs/design/DECISIONS.md 2026-11-17).
    static func shows(_ state: SessionState, unread: Bool) -> Bool {
        [.running, .starting, .cancelling, .waiting].contains(state) || state == .failed && unread
    }

    var body: some View {
        Group {
            switch state {
            case .running, .starting, .cancelling:
                Spinner(size: .mini)
            case .waiting:
                Circle().fill(palette.warning).frame(width: 7, height: 7)
            case .failed:
                Circle().fill(palette.danger).frame(width: 7, height: 7)
            default:
                Color.clear.frame(width: 7, height: 7)
            }
        }
        .frame(width: 12, height: 12)
    }
}

/// The 16-wide slot before a sidebar conversation's title (web `SessionIndicator`, patterns.md 「侧栏导航」):
/// one mark by priority — in the terminal, running, waiting, a failure or a result not yet seen, the
/// task's status ring — so every title starts on the same line as the navigation labels.
struct SessionLeadingMark: View {
    let session: Session
    let unread: Bool
    /// The status of the task the conversation belongs to (`WorkItemSummary.status`).
    let taskStatus: String?
    @Environment(\.palette) private var palette

    var body: some View {
        let running = SessionStatePill.running(session.state)
        // A ZStack, not a Group: a Group hands its frame to each child, and with no mark the slot
        // would take no width and the title would slide left.
        ZStack {
            if session.terminalHold != nil {
                Image(icon: "terminal")
                    .font(.riffet(size: S(DisplayPreferences.shared.style.text.label - 1)))
                    .foregroundStyle(palette.fg3)
                    .help("在终端中")
            } else if running, let taskStatus {
                WorkItemStatusIcon(status: taskStatus, running: true)
            } else if running {
                Spinner(size: .mini).help("运行中").accessibilityLabel("运行中")
            } else if session.state == .waiting {
                dot(palette.warning)
            } else if unread {
                dot(session.state == .failed ? palette.danger : palette.accent).accessibilityLabel("未读")
            } else if let taskStatus {
                WorkItemStatusIcon(status: taskStatus)
            }
        }
        .frame(width: 16, height: 16)
    }

    private func dot(_ color: Color) -> some View {
        Circle().fill(color).frame(width: 7, height: 7)
    }
}

/// A task's status ring (web `StatusIcon`, docs/TASK-BOARD.md §9): it fills as the work advances,
/// each status in its own colour. `running`: the outer ring opens into an arc and turns around the
/// still fill, so the row needs no spinner beside it.
struct WorkItemStatusIcon: View {
    let status: String
    var running = false
    @Environment(\.palette) private var palette

    var body: some View {
        let tone = tone
        ZStack {
            if running {
                TurningArc(color: NSColor(tone))
            } else if status != "done" {
                Circle().inset(by: 1.5)
                    .stroke(tone, style: StrokeStyle(lineWidth: 1.25, dash: status == "todo" ? [1.4, 2] : []))
            }
            switch status {
            case "doing": sector(to: 90).fill(tone)
            case "review": sector(to: 180).fill(tone)
            case "watching": Circle().fill(tone).frame(width: 4, height: 4)
            case "done":
                if !running { Circle().fill(tone).frame(width: 12.2, height: 12.2) }
                check.stroke(running ? tone : palette.bg, style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round))
            case "cancelled":
                Path { $0.move(to: CGPoint(x: 4.6, y: 9.4)); $0.addLine(to: CGPoint(x: 9.4, y: 4.6)) }
                    .stroke(tone, style: StrokeStyle(lineWidth: 1.25, lineCap: .round))
            default: EmptyView()
            }
        }
        .frame(width: 14, height: 14)
        .accessibilityElement()
        .accessibilityLabel(running ? "\(label) · \(String(localized: "运行中"))" : label)
        .help(label)
    }

    /// The fill from twelve o'clock clockwise to [degrees] past three o'clock: half for 进行中, three quarters for 待验收.
    private func sector(to degrees: Double) -> Path {
        Path { path in
            let center = CGPoint(x: 7, y: 7)
            path.move(to: center)
            path.addArc(center: center, radius: 3.4, startAngle: .degrees(-90), endAngle: .degrees(degrees), clockwise: false)
            path.closeSubpath()
        }
    }

    private var check: Path {
        Path { path in
            path.move(to: CGPoint(x: 4.5, y: 7.2))
            path.addLine(to: CGPoint(x: 6.2, y: 8.9))
            path.addLine(to: CGPoint(x: 9.6, y: 5.4))
        }
    }

    private var tone: Color {
        switch status {
        case "doing": palette.accent
        case "watching": palette.fg3
        case "review": palette.warning
        case "done": palette.success
        default: palette.fg4
        }
    }

    private var label: String {
        switch status {
        case "todo": String(localized: "待办")
        case "doing": String(localized: "进行中")
        case "watching": String(localized: "观测中")
        case "review": String(localized: "待验收")
        case "done": String(localized: "完成")
        case "cancelled": String(localized: "无需关注")
        default: status
        }
    }
}

/// The running status ring's open arc, turned by Core Animation: a repeating SwiftUI animation would
/// redraw the whole window every frame (docs/MACOS.md「性能规范」P2).
private struct TurningArc: NSViewRepresentable {
    let color: NSColor

    /// Keeps the added layer at the screen's scale: AppKit sets it only on the layers it owns.
    final class ArcView: NSView {
        override func viewDidChangeBackingProperties() {
            super.viewDidChangeBackingProperties()
            let scale = window?.backingScaleFactor ?? 2
            layer?.sublayers?.forEach { $0.contentsScale = scale }
        }
    }

    func makeNSView(context: Context) -> NSView {
        let view = ArcView(frame: NSRect(x: 0, y: 0, width: 14, height: 14))
        view.wantsLayer = true
        let arc = CAShapeLayer()
        arc.frame = view.bounds
        arc.path = CGPath(ellipseIn: view.bounds.insetBy(dx: 1.5, dy: 1.5), transform: nil)
        arc.fillColor = nil
        arc.lineWidth = 1.25
        arc.lineCap = .round
        arc.strokeEnd = 0.7
        arc.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        view.layer?.addSublayer(arc)
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let turn = CABasicAnimation(keyPath: "transform.rotation.z")
            turn.fromValue = 0
            turn.toValue = -2 * Double.pi
            turn.duration = 1
            // motion-loop: a task conversation running, as the web's `animate-spin`; still under Reduce Motion
            turn.repeatCount = .infinity
            turn.isRemovedOnCompletion = false
            arc.add(turn, forKey: "turn")
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        (view.layer?.sublayers?.first as? CAShapeLayer)?.strokeColor = color.cgColor
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSView, context: Context) -> CGSize? {
        CGSize(width: 14, height: 14)
    }
}

/// What a sidebar row says in words: only the states that need the reader. Running is the agent
/// mark breathing, not a word or a spinner (docs/design/macos-native.md 1.2).
struct SessionStatePill: View {
    let state: SessionState
    @Environment(\.palette) private var palette
    @Environment(\.appearsActive) private var appearsActive

    /// A failure only until it is seen, as `SessionStateMark.shows`.
    static func shows(_ state: SessionState, unread: Bool) -> Bool { state == .waiting || state == .failed && unread }
    static func running(_ state: SessionState) -> Bool { [.running, .starting, .cancelling].contains(state) }

    var body: some View {
        let tint = !appearsActive ? palette.fg3 : state == .failed ? palette.danger : palette.warning
        Text(state == .failed ? String(localized: "出错") : String(localized: "待确认"))
            .font(.riffet(size: S(10.5), weight: .medium))
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .frame(height: 16)
            .background(tint.opacity(0.12), in: Capsule())
            .fixedSize()
    }
}

/// The agent a conversation runs on, in its own colour.
struct SessionAgentMark: View {
    let backend: String?
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            if let backend {
                AgentIcon(id: backend, size: 12, color: agentMarkColor(backend, palette) ?? palette.fg3)
            } else {
                Color.clear
            }
        }
        .frame(width: 12, height: 12)
    }
}

/// Light, dark or the system's, then the palette; neither choice writes the other (the web's
/// theme menu). Shared by the sidebar footer's menu and 显示 ▸ 外观.
struct AppearanceMenuItems: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        @Bindable var prefs = DisplayPreferences.shared
        let theme = ThemeStore.shared
        Group {
            Picker("明暗", selection: $prefs.appearance) {
                Label("跟随系统", icon: "circle.lefthalf.filled").tag("system")
                Label("浅色", icon: "sun.max").tag("light")
                Label("深色", icon: "moon").tag("dark")
            }
            .pickerStyle(.inline)
            // Every item carries an image: a menu re-rendered while open otherwise re-lays out its
            // text column and the theme names jump sideways.
            Picker("主题", selection: Binding(
                get: { theme.entry.id },
                set: { id in if let entry = theme.choices.first(where: { $0.id == id }) { theme.choose(entry) } }
            )) {
                ForEach(theme.choices, id: \.id) { entry in
                    Label { Text(entry.name) } icon: { Image(nsImage: Self.swatch(scheme == .dark ? entry.values.dark : entry.values.light)) }
                        .tag(entry.id)
                }
            }
            .pickerStyle(.inline)
        }
    }

    /// The palette's background with its accent inside, as a menu-sized dot.
    static func swatch(_ palette: RiffetPaletteValues) -> NSImage {
        func color(_ rgba: RiffetRGBA) -> NSColor { NSColor(srgbRed: rgba.red, green: rgba.green, blue: rgba.blue, alpha: rgba.alpha) }
        let image = NSImage(size: NSSize(width: 14, height: 14), flipped: false) { rect in
            let outer = NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1))
            color(palette.bg).setFill()
            outer.fill()
            color(palette.fg).withAlphaComponent(0.25).setStroke()
            outer.lineWidth = 1
            outer.stroke()
            color(palette.accent).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 4, dy: 4)).fill()
            return true
        }
        image.isTemplate = false
        return image
    }
}

/// Runs a block once the next frame is on screen, so what changed before it (a row drawn selected)
/// is shown before the block's work holds the main thread.
@MainActor
final class AfterNextFrame: NSObject {
    private var body: (() -> Void)?
    private var link: CADisplayLink?

    static func run(in view: NSView?, _ body: @escaping () -> Void) {
        guard let view, view.window != nil else { return body() }
        let runner = AfterNextFrame()
        runner.body = body
        // The link holds its target until it is invalidated.
        let link = view.displayLink(target: runner, selector: #selector(fire))
        runner.link = link
        link.add(to: .main, forMode: .common)
        // A window that gets no frames (fully covered) still opens what was picked.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { runner.fire() }
    }

    @objc private func fire() {
        link?.invalidate()
        link = nil
        let body = self.body
        self.body = nil
        body?()
    }
}

/// Settings' sidebar list: SwiftUI supplies the theme-coloured row background, so AppKit's inactive
/// grey highlight must not cover it when focus moves to the form or another window.
struct SidebarListAppearance: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Probe() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    final class Probe: NSView {

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            // The list's table is in the window only after this pass.
            DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.apply() } }
        }

        private func apply() {
            let frame = convert(bounds, to: nil)
            var ancestor = superview
            while let view = ancestor {
                if let table = Self.table(in: view, over: frame) {
                    table.selectionHighlightStyle = .none
                    return
                }
                ancestor = view.superview
            }
        }

        /// The table under [frame]: the window holds others (the transcript) beside the list.
        private static func table(in view: NSView, over frame: NSRect) -> NSTableView? {
            if let table = view as? NSTableView, (table.enclosingScrollView ?? table).convert((table.enclosingScrollView ?? table).bounds, to: nil).intersects(frame) {
                return table
            }
            for child in view.subviews {
                if let table = table(in: child, over: frame) { return table }
            }
            return nil
        }
    }
}
