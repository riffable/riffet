import ServiceManagement
import SwiftUI
import RiffetKit

/// The menu bar item: a mark that turns into a count while conversations run or wait. With
/// "在菜单栏显示运行进度" on it says more: how many wait, or which conversation runs and for how long.
struct MenuBarLabel: View {
    static let progressKey = "riffet.menu-bar-progress"

    private static let mark = BrandMark.templateImage()

    let model: AppModel
    @AppStorage(MenuBarLabel.progressKey) private var showProgress = false

    var body: some View {
        let workbench = model.workbench
        let waiting = workbench?.waitingSessions.count ?? 0
        let running = (workbench?.activeSessions.count ?? 0) - waiting
        HStack(spacing: 3) {
            if waiting > 0 {
                Image(icon: "exclamationmark.bubble.fill")
            } else {
                Image(nsImage: Self.mark)
            }
            if showProgress, waiting > 0 {
                Text("\(waiting) 待确认")
            } else if showProgress, running == 1, let session = workbench?.activeSessions.first(where: { $0.state != .waiting }) {
                RunningProgress(session: session)
            } else if showProgress, running > 1 {
                Text("\(running) 个运行中")
            } else if waiting > 0 {
                Text("\(waiting)")
            } else if running > 0 {
                Text("\(running)")
            }
        }
    }
}

/// The running conversation's title and elapsed time. It exists only while one conversation runs,
/// so the one-second timeline does not tick when nothing does; the fixed-width digits ("05:12") keep
/// the item from shifting every second.
private struct RunningProgress: View {
    let session: Session

    var body: some View {
        let title = session.title.ifEmpty(String(localized: "新会话"))
        let shown = title.count > 16 ? String(title.prefix(16)) + "…" : title
        if let since = ServerTime.date(session.activeSince) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text("\(shown) \(Self.elapsed(context.date.timeIntervalSince(since)))").monospacedDigit()
            }
        } else {
            Text(shown)
        }
    }

    private static func elapsed(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        let (hours, minutes) = (seconds / 3600, seconds % 3600 / 60)
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds % 60)
            : String(format: "%02d:%02d", minutes, seconds % 60)
    }
}

/// Current conversations and shortcuts into the app. Approvals stay available in the menu;
/// navigation closes it before bringing the destination forward.
struct MenuBarPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openSettings) private var openSettings
    @State private var windowAnchor = NSView()
    @State private var approvalSession: Session?
    @State private var approvalInteraction: NativeInteraction?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            header.padding(.leading, Space.sm)
            ServiceAlertBanner(compact: true)
            if let workbench = model.workbench {
                if let session = approvalSession, let interaction = approvalInteraction {
                    VStack(spacing: 0) {
                        HStack {
                            Button { approvalSession = nil; approvalInteraction = nil } label: { Image(icon: "chevron.left") }
                                .buttonStyle(IconButtonStyle()).accessibilityLabel(Text("返回"))
                            Text("审批").font(.riffet(size: S(13), weight: .semibold)).lineLimit(1)
                            Spacer()
                        }
                        .padding(.horizontal, Space.sm).padding(.vertical, Space.xs)
                        Divider()
                        InteractionCardView(workbench: workbench, interaction: interaction, sessionID: session.id, detailsOnly: true, onInteractionChange: { fresh in
                            guard approvalSession?.id == session.id,
                                  approvalInteraction?.id == interaction.id,
                                  approvalInteraction?.revision == interaction.revision else { return }
                            approvalInteraction = fresh
                            if fresh == nil { approvalSession = nil }
                        })
                            .frame(height: min(520, max(280, (NSScreen.main?.visibleFrame.height ?? 800) - 180)))
                    }
                    .task(id: workbench.waitingSessions.first(where: { $0.id == session.id })?.updatedAt) {
                        let requested = approvalInteraction
                        do {
                            let fresh = try await workbench.store.currentInteraction(sessionId: session.id)
                            guard !Task.isCancelled, approvalSession?.id == session.id,
                                  approvalInteraction?.id == requested?.id,
                                  approvalInteraction?.revision == requested?.revision else { return }
                            approvalInteraction = fresh
                            if fresh == nil { approvalSession = nil }
                        } catch { /* Keep the request and its retry controls during a transient disconnect. */ }
                    }
                    .onChange(of: workbench.waitingSessions.map(\.id)) { _, ids in
                        if !ids.contains(session.id) { approvalSession = nil; approvalInteraction = nil }
                    }
                } else {
                    sessions(workbench)
                }
            } else {
                Text(phaseText).font(.riffet(size: S(12.5))).foregroundStyle(palette.fg3).padding(.horizontal, Space.sm)
            }
            HStack(spacing: Space.sm) {
                Button {
                    navigate {
                        WindowRouter.shared.showMain()
                        model.whenReady { $0.showHomeTab(quickChat: false) }
                    }
                } label: {
                    Label("新建任务", icon: "square.and.pencil").frame(maxWidth: .infinity)
                }
                Button { navigate { QuickPrompt.show() } } label: {
                    Label("快速对话", icon: "questionmark.bubble").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(SolidButtonStyle(kind: .secondary))
        }
        .padding(Space.sm)
        .frame(width: 360)
        .background(MenuBarWindowAnchor(view: windowAnchor).frame(width: 0, height: 0))
    }

    /// The server's state only when it needs attention; a healthy one keeps its manager and port in the tooltip.
    private var header: some View {
        HStack(spacing: Space.sm) {
            Text("Riffet").font(.riffet(size: S(13), weight: .semibold))
                .help(serverDetail ?? "")
            Spacer()
            if let serverText {
                Circle().fill(serverColor).frame(width: 6, height: 6)
                Text(serverText).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3)
            }
            HStack(spacing: Space.xxs) {
                Button { navigate { openSettings(); NSApp.activate() } } label: { Image(icon: "gearshape") }
                    .help("设置")
                    .accessibilityLabel(Text("设置"))
                Button { NSApp.terminate(nil) } label: { Image(icon: "power") }
                    .help("退出 Riffet（服务器继续运行）")
                    .accessibilityLabel(Text("退出 Riffet（服务器继续运行）"))
            }
            .buttonStyle(IconButtonStyle())
        }
    }

    /// The panel sizes to its content: rows fade in and out as conversations start and finish, and
    /// past a screenful the list scrolls instead of the panel growing down the screen.
    private func sessions(_ workbench: Workbench) -> some View {
        let waiting = workbench.waitingSessions
        let running = workbench.activeSessions.filter { $0.state != .waiting }
        return ScrollView {
            VStack(alignment: .leading, spacing: Space.xxs) {
                if waiting.isEmpty && running.isEmpty {
                    Text("没有运行中的会话").font(.riffet(size: S(12.5))).foregroundStyle(palette.fg4).padding(.horizontal, Space.sm).padding(.vertical, Space.xs)
                        .transition(.opacity)
                }
                ForEach(waiting, id: \.id) { session in
                    WaitingRow(workbench: workbench, session: session, open: { open(workbench, session) }) { interaction in
                        approvalSession = session
                        approvalInteraction = interaction
                    }
                        .transition(.opacity)
                }
                ForEach(running, id: \.id) { session in
                    runningRow(workbench, session)
                        .transition(.opacity)
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: 420)
        .fixedSize(horizontal: false, vertical: true)
        .animation(reduceMotion ? nil : Motion.standard, value: waiting.map(\.id) + [""] + running.map(\.id))
    }

    private func runningRow(_ workbench: Workbench, _ session: Session) -> some View {
        Button { open(workbench, session) } label: {
            HStack(spacing: Space.sm) {
                Spinner(size: .mini).frame(width: 14)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.title.ifEmpty(String(localized: "新会话"))).font(.riffet(size: S(12.5))).foregroundStyle(palette.fg).lineLimit(1)
                    if let project = workbench.project(session.projectId) {
                        Text(project.name).font(.riffet(size: S(11))).foregroundStyle(palette.fg3).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let since = ServerTime.date(session.activeSince) {
                    Text(since, style: .timer)
                        .font(.riffet(size: S(11)).monospacedDigit())
                        .foregroundStyle(palette.fg3)
                        .fixedSize()
                }
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
        }
        .buttonStyle(HoverRowStyle())
    }

    private func open(_ workbench: Workbench, _ session: Session) {
        navigate {
            WindowRouter.shared.showMain()
            workbench.open(session)
        }
    }

    private func navigate(_ action: () -> Void) {
        windowAnchor.window?.orderOut(nil)
        action()
    }

    private var phaseText: String {
        switch model.phase {
        case .needsServer: String(localized: "本机服务器没有运行")
        case let .failed(message): message
        default: String(localized: "正在连接…")
        }
    }

    /// Nil while the local server runs or the remote one is connected.
    private var serverText: String? {
        if model.target != .local { return model.phase == .ready ? nil : String(localized: "远程服务器") }
        switch model.server.state {
        case .running: return nil
        case .starting: return String(localized: "正在启动")
        case .stopped: return String(localized: "未运行")
        case .checking: return String(localized: "检测中")
        case .failed: return String(localized: "异常")
        }
    }

    private var serverDetail: String? {
        if model.target != .local { return String(localized: "远程服务器") }
        guard case let .running(server) = model.server.state else { return nil }
        return "\(server.manager.label) · :\(server.record.port)"
    }

    private var serverColor: Color {
        if model.target != .local { return model.phase == .ready ? palette.success : palette.warning }
        switch model.server.state {
        case .running: return palette.success
        case .failed: return palette.danger
        default: return palette.warning
        }
    }
}

/// Captures only this menu's window, so opening a destination never hides another app window.
private struct MenuBarWindowAnchor: NSViewRepresentable {
    let view: NSView

    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ view: NSView, context: Context) {}
}

/// Menu approvals expose at most three preview lines; the complete request opens in the panel.
struct WaitingRow: View {
    let workbench: Workbench
    let session: Session
    let open: () -> Void
    let showDetails: (NativeInteraction) -> Void
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var interaction: NativeInteraction?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Button(action: open) {
                HStack(alignment: .top, spacing: Space.sm) {
                    Circle().fill(palette.warning).frame(width: 6, height: 6).padding(.top, 6)
                    Text(session.title.ifEmpty(String(localized: "新会话"))).font(RiffetFont.label).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let interaction {
                InteractionCardView(workbench: workbench, interaction: interaction, sessionID: session.id, summaryOnly: true, onOpenDetails: { showDetails(interaction) }, summaryTitle: session.title)
            } else {
                Text("等待你确认").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
            }
        }
        .padding(Space.sm)
        .animation(reduceMotion ? nil : Motion.standard, value: interaction?.id)
        .task(id: session.updatedAt) {
            interaction = try? await workbench.store.currentInteraction(sessionId: session.id)
        }
    }
}

/// "服务器已停止 · 重新启动 / 查看日志" or "重启服务器以使用新版本": what the health check of the local
/// server found, with the way out. Shown in the menu bar panel and meant for the top of the main
/// window; it renders nothing while the server is fine.
struct ServiceAlertBanner: View {
    var compact = false
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var dismissal = UUID()

    private var shownAlert: ServiceAlert? {
        guard let alert = model.serviceAlert, compact || alert == .stopped || model.serviceError != nil else { return nil }
        return alert
    }

    var body: some View {
        FeedbackRegion(value: shownAlert) { alert, live in
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(icon: alert == .stopped ? "exclamationmark.triangle.fill" : "info.circle")
                        .foregroundStyle(live && alert == .stopped ? palette.warning : palette.fg3)
                    Text(alert.message).font(.riffet(size: S(12.5))).foregroundStyle(palette.fg).lineLimit(2)
                    Spacer(minLength: 0)
                    if live && model.recoveringService { Spinner(size: .mini) }
                    if !live, model.serviceAlert == nil, model.phase == .ready {
                        Text("已恢复").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                    }
                }
                if live, let blockers = model.server.restartBlockers, !blockers.isEmpty || model.server.restartProblem != nil {
                    Text(verbatim: ([model.server.restartProblem].compactMap { $0 } + blockers.map { "\($0.title.isEmpty ? backendLabel($0.backendId) : $0.title) · \($0.reasonLabel)" }).joined(separator: "\n"))
                        .font(.riffet(size: S(11))).foregroundStyle(palette.fg3).lineLimit(4)
                }
                HStack(spacing: Space.xs) {
                    if live, model.server.restartBlockers?.isEmpty == false || model.server.restartProblem != nil {
                        // A restart waiting for these conversations: go ahead now, or give it up.
                        Button("仍然重启") { model.server.restartAnyway() }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                        Button("取消") { model.server.cancelRestart() }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                    } else if live && model.canRecoverService {
                        Button(alert.actionTitle) {
                            guard shownAlert == alert else { return }
                            Task { await model.recoverService() }
                        }
                            .buttonStyle(SolidButtonStyle(kind: alert == .stopped ? .primary : .secondary))
                            .disabled(model.recoveringService)
                    }
                    Button("查看日志") { model.server.openLog() }
                        .buttonStyle(SolidButtonStyle(kind: .secondary))
                    if live && model.server.appAgentStatus == .requiresApproval {
                        Button("登录项设置") { SMAppService.openSystemSettingsLoginItems() }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                    }
                    Spacer(minLength: 0)
                    if live, case .outdated = alert {
                        Button("稍后") {
                            guard shownAlert == alert else { return }
                            model.dismissServiceAlert()
                            dismissal = UUID()
                        }.buttonStyle(.plain).foregroundStyle(palette.fg3)
                    }
                }
                if live, alert == .stopped, !model.canRecoverService {
                    Text("这个服务器由终端里的 riffet start 启动，请在终端重新执行。").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                }
                if live, let error = model.serviceError {
                    Text(error).font(.riffet(size: S(11))).foregroundStyle(palette.danger).lineLimit(3).textSelection(.enabled)
                }
            }
            .padding(compact ? Space.sm : 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(live && alert == .stopped ? palette.warningSoft : palette.bgSubtle, in: RoundedRectangle(cornerRadius: compact ? 10 : 0, style: .continuous))
            // The soft tints are translucent: in a window the strip needs a solid ground under them,
            // or the conversation behind a glass window shows through the text.
            .background(compact ? Color.clear : palette.bg)
        }
        .id(dismissal)
    }
}
