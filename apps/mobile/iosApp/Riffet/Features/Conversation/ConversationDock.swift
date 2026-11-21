import SwiftUI
import RiffetKit

extension Workbench {
    /// The phone has no connection to the server: reconnecting or given up. A stream still opening is not.
    var offline: Bool { connection is RiffetConnectionStateReconnecting || connection is RiffetConnectionStateFailed }
}

/// The cards docked above the composer (mobile.md §9.1), top to bottom: the slash or @ menu, the queue, the
/// todos, the goal, and the question or approval the agent waits on, which sits against the input. At most
/// two cards at a time, the question first; each collapses to one line with its own control. The dock lives
/// in the composer's bottom inset, so its height is part of the transcript's bottom inset.
struct ConversationDock: View {
    let workbench: Workbench
    let session: Session
    let draft: MessageDraft
    /// The question or approval waiting for the reader; its answer is recorded in the transcript afterwards.
    let interaction: NativeInteraction?
    var openTerminal: (() -> Void)?
    let onSubmitted: (NativeInteractionResult, NativeInteraction) -> Void
    var supportsSteer = false
    var supportsTargetedStop = false
    var supportsSessionReferences = false
    @Binding var menu: ComposerMenuToken?
    let onMenuPicked: () -> Void

    private enum Card { case queue, todos, goal, question }

    /// The cards that fit, by priority; two at most.
    private var shown: [Card] {
        var wanted: [Card] = []
        if interaction != nil { wanted.append(.question) }
        if !workbench.queued.isEmpty { wanted.append(.queue) }
        if workbench.goal != nil { wanted.append(.goal) }
        if !workbench.todos.isEmpty { wanted.append(.todos) }
        let kept = Set(wanted.prefix(2))
        return [Card.queue, .todos, .goal, .question].filter(kept.contains)
    }

    var body: some View {
        VStack(spacing: 8) {
            if let menu {
                ComposerMenuDock(workbench: workbench, session: session, draft: draft, token: menu,
                                 allowsFiles: session.backendId != .chat, allowsSessions: supportsSessionReferences, picked: onMenuPicked)
                    .transition(.opacity)
            }
            ForEach(shown, id: \.self) { card in
                switch card {
                case .queue: QueueDockCard(workbench: workbench, draft: draft, supportsSteer: supportsSteer, supportsTargetedStop: supportsTargetedStop)
                case .todos: TodosDockCard(entries: workbench.todos)
                case .goal: if let goal = workbench.goal { GoalDockCard(goal: goal) }
                case .question:
                    if let interaction {
                        // Its own state per question: one folded away does not fold the next.
                        QuestionDockCard(workbench: workbench, interaction: interaction, sessionID: session.id, openTerminal: openTerminal) { onSubmitted($0, interaction) }
                            .id(interaction.id)
                    }
                }
            }
        }
        .padding(.horizontal, 12) // design-rules: allow the composer's own side inset, so the cards line up with it
        .riffetAnimation(RiffetMotion.spatial, value: shown.map(String.init(describing:)))
        .riffetAnimation(RiffetMotion.release, value: menu != nil)
    }
}

/// One docked card: a one-line header that is also its collapse control, and a body while it is open. The header
/// is told whether the card is open, so a preview of the body shows only while the body does not.
private struct DockCard<Header: View, Content: View>: View {
    @State private var expanded: Bool
    let label: String
    @ViewBuilder let header: (_ expanded: Bool) -> Header
    @ViewBuilder let content: () -> Content
    @Environment(\.palette) private var palette

    init(expanded: Bool = false, label: String, @ViewBuilder header: @escaping (_ expanded: Bool) -> Header, @ViewBuilder content: @escaping () -> Content) {
        _expanded = State(initialValue: expanded)
        self.label = label
        self.header = header
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    header(expanded).lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg4)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .riffetAnimation(RiffetMotion.chevron, value: expanded)
                }
                .frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label).accessibilityValue(expanded ? String(localized: "已展开", bundle: .riffet) : "")
            if expanded { content().padding(.bottom, RiffetMetrics.pageInset) }
        }
        .padding(.horizontal, RiffetMetrics.groupInset)
        .dockSurface()
    }
}

/// A docked card's body: as tall as its rows up to `maxHeight`, scrolling past it. A `ScrollView` under
/// `.frame(maxHeight:)` takes all of `maxHeight` however few rows it holds, and so does the frame itself.
private struct DockScroll<Content: View>: View {
    let maxHeight: CGFloat
    @ViewBuilder let content: () -> Content
    var body: some View {
        HeightCap(maxHeight: maxHeight) {
            ViewThatFits(in: .vertical) {
                content()
                ScrollView { content() }.scrollIndicators(.hidden)
            }
        }
    }
}

/// Offers its one subview at most `maxHeight` and takes the height the subview chose, not the height offered.
private struct HeightCap: Layout {
    let maxHeight: CGFloat
    private func capped(_ proposal: ProposedViewSize) -> ProposedViewSize {
        ProposedViewSize(width: proposal.width, height: min(proposal.height ?? maxHeight, maxHeight))
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(capped(proposal)) ?? .zero
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: capped(ProposedViewSize(bounds.size)))
    }
}

extension View {
    /// What a docked card or menu rests on: opaque, so the transcript passing behind it does not show through.
    func dockSurface() -> ModifiedContent<Self, DockSurface> {
        modifier(DockSurface())
    }
}

struct DockSurface: ViewModifier {
    @Environment(\.palette) private var palette
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous)
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.bgSubtle, in: shape)
            .background(palette.bg, in: shape)
            .clipShape(shape)
    }
}

private struct GoalDockCard: View {
    let goal: SessionGoal
    @Environment(\.palette) private var palette
    var body: some View {
        DockCard(label: String(localized: "目标", bundle: .riffet)) { expanded in
            Label("目标 · \(goalStatusLabel(goal: goal))", systemImage: "target").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg)
            if !expanded { Text(goal.objective).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
        } content: {
            VStack(alignment: .leading, spacing: 6) {
                Text(goal.objective)
                if goal.status == "blocked", let reason = goal.reason { Text(reason).foregroundStyle(palette.warning) }
            }
            .riffetFont(.label, weight: .regular).foregroundStyle(palette.fg).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TodosDockCard: View {
    let entries: [TodoEntry]
    @Environment(\.palette) private var palette
    var body: some View {
        DockCard(label: String(localized: "待办", bundle: .riffet)) { _ in
            Label(todoProgress(entries: entries), systemImage: "checklist").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg)
        } content: {
            DockScroll(maxHeight: RiffetMetrics.rowMinHeight * 2) { ConversationTodoList(entries: entries).frame(maxWidth: .infinity, alignment: .leading) }
        }
    }
}

/// The waiting question or approval as the interaction card the transcript used to hold, with a control
/// that folds it into one line. Its long detail still opens as the card's own sheet.
private struct QuestionDockCard: View {
    let workbench: Workbench
    let interaction: NativeInteraction
    let sessionID: String
    var openTerminal: (() -> Void)?
    let onSubmitted: (NativeInteractionResult) -> Void
    @State private var expanded = true
    @Environment(\.palette) private var palette

    var body: some View {
        if expanded {
            InteractionCardView(workbench: workbench, interaction: interaction, sessionID: sessionID, openTerminal: openTerminal,
                                onSubmitted: onSubmitted, onCollapse: { expanded = false })
                .id("approval." + interaction.id)
                .background(palette.bg, in: RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous))
                .accessibilityIdentifier("dockedInteraction")
        } else {
            Button { expanded = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "hand.raised").riffetFont(.label, weight: .regular).foregroundStyle(palette.warning)
                    Text(interaction.title.isEmpty ? String(localized: "等待你处理", bundle: .riffet) : interaction.title)
                        .riffetFont(.label, weight: .regular).foregroundStyle(palette.fg).lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg4)
                }
                .frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.horizontal, RiffetMetrics.groupInset).dockSurface()
            .accessibilityLabel(String(localized: "等待你处理", bundle: .riffet)).accessibilityIdentifier("pendingApprovalLink")
        }
    }
}

/// Messages waiting to be sent, with the ways to send one sooner or take it back.
private struct QueueDockCard: View {
    let workbench: Workbench
    let draft: MessageDraft
    var supportsSteer = false
    var supportsTargetedStop = false
    @Environment(\.palette) private var palette
    private var canSteer: Bool {
        if let control = workbench.control {
            return workbench.isConnected && control.activeTurn?.canSteer == true && workbench.uncertain.isEmpty && !workbench.sendState.sending && !workbench.sendState.interrupting
        }
        return workbench.isConnected && workbench.status?.phase == .busy && workbench.interaction == nil && workbench.uncertain.isEmpty && !workbench.sendState.sending && !workbench.sendState.interrupting
    }
    private func allows(_ action: String, _ run: Run) -> Bool {
        guard let control = workbench.control else { return false }
        return SessionStoreStateKt.allowsQueuedAction(control: control, runId: run.id, commandId: run.commandId, action: action)
    }

    var body: some View {
        DockCard(expanded: true, label: String(localized: "等待发送", bundle: .riffet)) { expanded in
            Label("等待发送", systemImage: "clock").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg)
            if expanded {
                if workbench.queued.count > 1 { Text(workbench.queued.count, format: .number).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
            } else if let first = workbench.queued.first {
                Text(first.prompt).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
            }
        } content: {
            // Three rows show; more scroll inside the card, so the dock never grows past the transcript.
            DockScroll(maxHeight: RiffetMetrics.rowMinHeight * 3) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(workbench.queued, id: \.id) { run in queuedRun(run) }
                    if (workbench.control?.held ?? workbench.status?.queue?.held)?.reason == .unconfirmed {
                        Text("等待上一条消息确认").riffetFont(.caption).foregroundStyle(palette.fg3)
                    }
                }
            }
        }
    }

    private func queuedRun(_ run: Run) -> some View {
        HStack(spacing: 0) {
            Text(run.prompt).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            let governed = workbench.control != nil
            let showsSteer = governed ? allows("steer", run) : (supportsSteer && workbench.status?.activeTurn != nil)
            let showSendNow = governed ? allows("send_now", run) && workbench.control?.activeTurn?.canStop == true : supportsTargetedStop
            let showEdit = !governed || allows("edit", run)
            let showCancel = !governed || allows("cancel", run)
            let usesSteer = showsSteer && canSteer
            if usesSteer {
                Button { steer(run) } label: { Image(systemName: "arrow.turn.up.right").frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
                    .disabled(!canSteer).accessibilityLabel("补充到当前任务")
            } else if showSendNow {
                Button { sendNow(run) } label: { Image(systemName: "arrow.up").frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
                    .accessibilityLabel("停止并发送")
            }
            if (usesSteer && showSendNow) || (showsSteer && !usesSteer) || showEdit || showCancel {
            Menu {
                if usesSteer && showSendNow {
                    Button("停止并发送", systemImage: "arrow.up") { sendNow(run) }
                } else if showsSteer {
                    Button("补充到当前任务", systemImage: "arrow.turn.up.right") { steer(run) }.disabled(!canSteer)
                }
                if showEdit {
                Button("移回输入框", systemImage: "square.and.pencil") { Task { await workbench.perform {
                    if let taken = try await workbench.store.takeBackQueued(run: run) {
                        if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft.text = taken.text } else { draft.text += "\n\n" + taken.text }
                        let ids = Set(draft.attachments.map(\.id)); draft.attachments.append(contentsOf: taken.attachments.filter { !ids.contains($0.id) })
                        draft.references = mergeRestoredReferences(current: draft.references, restored: taken.context)
                    }
                } } }
                }
                if showCancel {
                Button("取消", systemImage: "trash", role: .destructive) { Task { await workbench.perform { _ = try await workbench.store.cancelRun(run: run) } } }
                }
            } label: { Image(systemName: "ellipsis").frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
                .accessibilityLabel("更多操作")
            }
        }
        .riffetFont(.caption).foregroundStyle(palette.fg3)
        .disabled(workbench.sendState.pendingRunIds.contains(run.id) || !SendPhaseKt.inQueue(run: run, control: workbench.control))
    }

    private func steer(_ run: Run) {
        let target = workbench.status?.activeTurn?.target() ?? workbench.control?.activeTurn.flatMap { turn in
            guard let nativeSessionId = turn.nativeSessionId, let turnId = turn.nativeTurnId ?? turn.turnId else { return nil }
            return NativeTurnTarget(nativeSessionId: nativeSessionId, turnId: turnId)
        }
        guard let target else { return }
        Task { await workbench.perform { _ = try await workbench.store.steerQueued(run: run, target: target) } }
    }
    private func sendNow(_ run: Run) {
        Task { await workbench.perform { _ = try await workbench.store.sendQueuedNow(run: run) } }
    }
}
