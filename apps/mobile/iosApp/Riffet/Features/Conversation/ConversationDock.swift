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

/// One docked card: a one-line header that is also its collapse control, and a body while it is open.
private struct DockCard<Header: View, Content: View>: View {
    @State private var expanded: Bool
    let label: String
    @ViewBuilder let header: () -> Header
    @ViewBuilder let content: () -> Content
    @Environment(\.palette) private var palette

    init(expanded: Bool = false, label: String, @ViewBuilder header: @escaping () -> Header, @ViewBuilder content: @escaping () -> Content) {
        _expanded = State(initialValue: expanded)
        self.label = label
        self.header = header
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    header().lineLimit(1)
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
        DockCard(label: String(localized: "目标", bundle: .riffet)) {
            Label("目标 · \(goalStatusLabel(goal: goal))", systemImage: "target").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg)
            Text(goal.objective).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
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
        DockCard(label: String(localized: "待办", bundle: .riffet)) {
            Label(todoProgress(entries: entries), systemImage: "checklist").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg)
        } content: {
            ScrollView { ConversationTodoList(entries: entries).frame(maxWidth: .infinity, alignment: .leading) }
                .frame(maxHeight: RiffetMetrics.rowMinHeight * 2).scrollIndicators(.hidden)
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
    private var canSteer: Bool { workbench.isConnected && workbench.status?.phase == .busy && workbench.interaction == nil && workbench.uncertain.isEmpty && !workbench.sendState.sending && !workbench.sendState.interrupting }

    var body: some View {
        DockCard(expanded: true, label: String(localized: "等待发送", bundle: .riffet)) {
            Label("等待发送", systemImage: "clock").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg)
            if let first = workbench.queued.first {
                Text(first.prompt).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
            }
        } content: {
            // Three rows show; more scroll inside the card, so the dock never grows past the transcript.
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(workbench.queued, id: \.id) { run in queuedRun(run) }
                    if workbench.status?.queue?.held?.reason == .unconfirmed {
                        Text("等待上一条消息确认").riffetFont(.caption).foregroundStyle(palette.fg3)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: RiffetMetrics.rowMinHeight * 3)
        }
    }

    private func queuedRun(_ run: Run) -> some View {
        HStack(spacing: 0) {
            Text(run.prompt).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            let showsSteer = supportsSteer && workbench.status?.activeTurn != nil
            let usesSteer = showsSteer && canSteer
            if usesSteer {
                Button { steer(run) } label: { Image(systemName: "arrow.turn.up.right").frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
                    .disabled(!canSteer).accessibilityLabel("补充到当前任务")
            } else if supportsTargetedStop {
                Button { sendNow(run) } label: { Image(systemName: "arrow.up").frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
                    .accessibilityLabel("停止并发送")
            }
            Menu {
                if usesSteer && supportsTargetedStop {
                    Button("停止并发送", systemImage: "arrow.up") { sendNow(run) }
                } else if showsSteer {
                    Button("补充到当前任务", systemImage: "arrow.turn.up.right") { steer(run) }.disabled(!canSteer)
                }
                Button("移回输入框", systemImage: "square.and.pencil") { Task { await workbench.perform {
                    if let taken = try await workbench.store.takeBackQueued(run: run) {
                        if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft.text = taken.text } else { draft.text += "\n\n" + taken.text }
                        let ids = Set(draft.attachments.map(\.id)); draft.attachments.append(contentsOf: taken.attachments.filter { !ids.contains($0.id) })
                        draft.references = mergeRestoredReferences(current: draft.references, restored: taken.context)
                    }
                } } }
                Button("取消", systemImage: "trash", role: .destructive) { Task { await workbench.perform { _ = try await workbench.store.cancelRun(run: run) } } }
            } label: { Image(systemName: "ellipsis").frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
                .accessibilityLabel("更多操作")
        }
        .riffetFont(.caption).foregroundStyle(palette.fg3)
        .disabled(workbench.sendState.pendingRunIds.contains(run.id) || !SendPhaseKt.inQueue(run: run))
    }

    private func steer(_ run: Run) {
        guard let target = workbench.status?.activeTurn?.target() else { return }
        Task { await workbench.perform { _ = try await workbench.store.steerQueued(run: run, target: target) } }
    }
    private func sendNow(_ run: Run) {
        Task { await workbench.perform { _ = try await workbench.store.sendQueuedNow(run: run) } }
    }
}
