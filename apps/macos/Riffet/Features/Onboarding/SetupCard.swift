import ServiceManagement
import SwiftUI
import RiffetKit

/// Where the three things a new session needs stand: a server, an Agent that can run, and a project
/// (or the decision to go without). Read by the new-session page, which shows the setup card until
/// all three are done.
@MainActor
struct SetupProgress {
    enum State { case pending, current, busy, done }

    let server: State
    let agent: State
    let project: State
    let serverValue: String
    let agentValue: String
    let projectValue: String

    var complete: Bool { server == .done && agent == .done && project == .done }

    init(model: AppModel, workbench: Workbench) {
        let connected = workbench.connected
        if connected {
            server = .done
        } else if model.phase == .connecting || model.phase == .launching || model.server.state == .starting {
            server = .busy
        } else {
            server = .current
        }
        serverValue = workbench.local ? String(localized: "这台 Mac") : (workbench.baseURL.host() ?? String(localized: "远程"))

        if server != .done {
            agent = .pending
        } else if !workbench.backendsLoaded {
            // A failed read is unknown, not empty: the composer stays rather than an endless check.
            agent = workbench.backendsReadFailed ? .done : .busy
        } else {
            agent = workbench.hasAvailableAgent ? .done : .current
        }
        agentValue = workbench.defaultBackend.map { AgentDirectory.shared.title($0.agent) } ?? ""

        project = agent == .done ? (workbench.backendsReadFailed && !workbench.backendsLoaded || workbench.homeProjectChosen ? .done : .current) : .pending
        projectValue = workbench.homeTaskProjectId.flatMap { workbench.project($0)?.name } ?? String(localized: "无项目")
    }
}

/// The new-session page's setup card: in the composer's place and shape while a server, an Agent or a
/// project is missing. The top row is the three steps; only the current one has a body.
struct SetupCard: View {
    let workbench: Workbench
    let progress: SetupProgress
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showRemote = false
    @State private var browsing = false
    @State private var rechecking = false
    @State private var error: String?
    @State private var pulse = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.floating, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            steps
            if let body = stepBody {
                body
                    .padding(.horizontal, Space.lg)
                    .padding(.bottom, Space.md)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            shape
                .fill(palette.bgElevated)
                .elevation(DisplayPreferences.shared.style.surface == .outlined ? nil : .float)
        )
        .overlay(shape.strokeBorder(palette.line, lineWidth: 1))
        .overlay(shape.strokeBorder(palette.fg3, lineWidth: 1.5).opacity(pulse ? 1 : 0).allowsHitTesting(false))
        .animation(Motion.standard, value: progress.server)
        .animation(Motion.standard, value: progress.agent)
        .animation(Motion.standard, value: progress.project)
        .onChange(of: model.setupHighlight) { _, _ in highlight() }
        .sheet(isPresented: $showRemote) { RemotePairingSheet() }
        .sheet(isPresented: $browsing) {
            DirectoryBrowser(workbench: workbench) { path in choose(path: path) }
        }
    }

    // MARK: Steps

    private var steps: some View {
        HStack(spacing: Space.sm) {
            step(String(localized: "服务器"), progress.server, progress.serverValue)
            separator
            step(String(localized: "Agent"), progress.agent, progress.agentValue)
            separator
            step(String(localized: "项目"), progress.project, progress.projectValue)
        }
        .padding(.horizontal, Space.lg)
        .frame(height: 48)
    }

    private var separator: some View {
        Rectangle().fill(palette.lineStrong).frame(minWidth: Space.md, maxWidth: 28, maxHeight: 1).frame(height: 1)
    }

    private func step(_ name: String, _ state: SetupProgress.State, _ value: String) -> some View {
        HStack(spacing: Space.sm) {
            StepGlyph(state: state)
            Text(state == .done ? value : name)
                .font(RiffetFont.text(RiffetTextSize.sm, weight: state == .done ? .regular : .medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 160, alignment: .leading)
        }
        .foregroundStyle(state == .done ? palette.fg2 : state == .pending ? palette.fg4 : palette.fg)
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
    }

    // MARK: The current step's body

    private var stepBody: AnyView? {
        if progress.server == .busy { return AnyView(line(model.target == .local ? "正在启动" : "正在连接", quiet: true)) }
        if progress.server == .current { return AnyView(serverBody) }
        if progress.agent == .busy { return AnyView(line("正在检查 Agent", quiet: true)) }
        if progress.agent == .current { return AnyView(agentBody) }
        if progress.project == .current { return AnyView(projectBody) }
        return nil
    }

    private func line<Actions: View>(_ text: LocalizedStringResource, quiet: Bool = false, @ViewBuilder actions: () -> Actions) -> some View {
        HStack(spacing: Space.md) {
            Text(text)
                .font(RiffetFont.label)
                .foregroundStyle(quiet ? palette.fg3 : palette.fg2)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: Space.xs) { actions() }
        }
        .frame(minHeight: 32)
    }

    private func line(_ text: LocalizedStringResource, quiet: Bool = false) -> some View {
        line(text, quiet: quiet) { EmptyView() }
    }

    // Server

    @ViewBuilder
    private var serverBody: some View {
        switch model.phase {
        case let .failed(message):
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(spacing: Space.md) {
                    Text(message).font(RiffetFont.label).foregroundStyle(palette.fg2).lineLimit(3).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: Space.xs) {
                        Button("连接其他服务器…") { showRemote = true }.buttonStyle(SolidButtonStyle(kind: .quiet))
                        if model.target != .local {
                            Button("连接本机") { Task { await model.connectLocal() } }.buttonStyle(SolidButtonStyle(kind: .secondary))
                        }
                        Button("重试") { Task { await model.start() } }.buttonStyle(SolidButtonStyle(kind: .primary))
                    }
                }
                .frame(minHeight: 32)
            }
        default:
            VStack(alignment: .leading, spacing: Space.xs) {
                line("这台 Mac 上的服务器没有运行") {
                    Button("连接其他服务器…") { showRemote = true }.buttonStyle(SolidButtonStyle(kind: .quiet))
                    if canStart {
                        Button("重新检测") { Task { await model.connectLocal() } }.buttonStyle(SolidButtonStyle(kind: .quiet))
                        Button("启动") { Task { await model.startServer() } }.buttonStyle(SolidButtonStyle(kind: .primary))
                    } else {
                        Button("重新检测") { Task { await model.connectLocal() } }.buttonStyle(SolidButtonStyle(kind: .primary))
                    }
                }
                if case let .failed(reason) = model.server.state {
                    HStack(spacing: Space.md) {
                        Text(reason).font(RiffetFont.caption).foregroundStyle(palette.danger).lineLimit(3).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("打开 server.log") { model.server.openLog() }.buttonStyle(.link)
                        if model.server.appAgentStatus == .requiresApproval {
                            Button("打开登录项设置") { SMAppService.openSystemSettingsLoginItems() }.buttonStyle(.link)
                        }
                    }
                }
            }
        }
    }

    private var canStart: Bool { model.server.hasLoginService || model.server.canHostServer }

    // Agent

    private var agentBody: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            line("没有找到可用的 Agent") {
                Button("重新检测") {
                    rechecking = true
                    Task { await workbench.loadBackends(); rechecking = false }
                }
                .buttonStyle(SolidButtonStyle(kind: .secondary))
                .disabled(rechecking)
            }
            AgentInstallList(rows: AgentInstall.rows(for: workbench.backends))
        }
    }

    // Project

    private var projectBody: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            line("Agent 会在所选目录里读写文件") {
                if workbench.supportsProjectlessTasks {
                    Button("跳过") { workbench.selectHomeProject(nil) }.buttonStyle(SolidButtonStyle(kind: .quiet))
                }
                Button("选择目录…") { chooseDirectory() }.buttonStyle(SolidButtonStyle(kind: .primary))
            }
            if let error { Text(error).font(RiffetFont.caption).foregroundStyle(palette.danger).lineLimit(2) }
        }
    }

    private func chooseDirectory() {
        if workbench.local {
            Task {
                guard let url = await DirectoryPanel.choose(prompt: String(localized: "在此新建会话")) else { return }
                choose(path: url.path)
            }
        } else {
            browsing = true
        }
    }

    private func choose(path: String) {
        Task {
            do {
                let opened = try await workbench.openDirectory(path)
                workbench.selectHomeProject(opened.id)
                error = nil
            } catch {
                self.error = error.riffetMessage
            }
        }
    }

    private func highlight() {
        guard !reduceMotion else { return }
        withAnimation(Motion.fast) { pulse = true }
        Task {
            try? await Task.sleep(for: .milliseconds(700))
            withAnimation(Motion.expressive) { pulse = false }
        }
    }
}

/// A step's status mark: an empty ring, the current ring with a dot, a spinner, a filled check.
private struct StepGlyph: View {
    let state: SetupProgress.State
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            switch state {
            case .pending:
                Circle().strokeBorder(palette.fg4, lineWidth: 1.25)
            case .current:
                Circle().strokeBorder(palette.fg, lineWidth: 1.25)
                Circle().fill(palette.fg).frame(width: 6, height: 6)
            case .busy:
                Spinner(size: .small)
            case .done:
                Circle().fill(palette.fg2)
                Image(icon: "checkmark").font(RiffetFont.caption).imageScale(.small).fontWeight(.medium).foregroundStyle(palette.bg)
            }
        }
        .frame(width: 16, height: 16)
        .animation(Motion.fast, value: state)
    }
}
