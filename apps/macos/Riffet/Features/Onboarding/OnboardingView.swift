import SwiftUI
import RiffetKit

/// The first-launch guide: the whole window, one decision per page (docs/design/system/patterns.md §1.5).
/// Finishing or skipping lands on the main window with whatever is done; the setup card finishes the rest.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var flow = OnboardingFlow()

    var body: some View {
        VStack(spacing: 0) {
            topBar
            GeometryReader { geometry in
                ScrollView {
                    page
                        .frame(width: 440)
                        .padding(.top, flow.page == .welcome ? geometry.size.height * 0.18 : geometry.size.height * 0.13)
                        .padding(.bottom, Space.xxl + Space.lg)
                        .frame(maxWidth: .infinity)
                        .id(flow.page)
                        .transition(.asymmetric(
                            insertion: .offset(x: flow.forward ? Space.lg : -Space.lg).combined(with: .opacity),
                            removal: .opacity
                        ))
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.bg.ignoresSafeArea())
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: Space.md) {
            Group {
                if flow.canGoBack {
                    Button { flow.back(model: model) } label: { Image(icon: "chevron.left") }
                        .buttonStyle(IconButtonStyle(size: 28))
                        .help("返回")
                } else {
                    Color.clear.frame(width: 28, height: 28)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            progress
            Button("跳过") { model.finishOnboarding() }
                .buttonStyle(SolidButtonStyle(kind: .quiet))
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, Space.md)
        .frame(height: 52)
    }

    private var progress: some View {
        HStack(spacing: 6) {
            ForEach(0..<flow.segments, id: \.self) { n in
                Capsule()
                    .fill(n < flow.index ? palette.fg : palette.lineStrong)
                    .frame(width: 24, height: 3)
            }
        }
        .opacity(flow.page == .welcome ? 0 : 1)
        .animation(Motion.standard, value: flow.index)
        .accessibilityHidden(true)
    }

    // MARK: Pages

    @ViewBuilder
    private var page: some View {
        switch flow.page {
        case .welcome: WelcomePage(flow: flow)
        case .server: ServerPage(flow: flow)
        case .agent: AgentPage(flow: flow)
        case .project: ProjectPage(flow: flow)
        case .phone: PhonePage(flow: flow)
        case .notify: NotifyPage(flow: flow)
        }
    }
}

// MARK: - Welcome

private struct WelcomePage: View {
    let flow: OnboardingFlow
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var step = 0

    var body: some View {
        VStack(spacing: 0) {
            LiveBrandMark(front: palette.fg, back: palette.accent, once: true)
                .frame(width: 88, height: 88)
                .padding(.bottom, Space.xl)
            Text(verbatim: "Riffet")
                .font(RiffetFont.brandTitle)
                .foregroundStyle(palette.fg)
                .reveal(step >= 1)
            Text("在电脑上运行编程 Agent，在任何设备上查看和接手")
                .font(RiffetFont.label)
                .foregroundStyle(palette.fg3)
                .multilineTextAlignment(.center)
                .padding(.top, Space.sm)
                .reveal(step >= 2)
            HStack {
                OnboardingPrimaryButton(title: "开始") { flow.advance(from: .welcome, model: model) }
            }
            .frame(width: 240)
            .padding(.top, Column.gutter)
            .reveal(step >= 3)
        }
        .frame(maxWidth: .infinity)
        .task {
            guard !reduceMotion else { step = 3; return }
            try? await Task.sleep(for: .milliseconds(1900))
            step = 1
            try? await Task.sleep(for: .milliseconds(150))
            step = 2
            try? await Task.sleep(for: .milliseconds(150))
            step = 3
        }
    }
}

private extension View {
    /// Fades up into place once [shown]; the welcome page's lines follow the mark's drawing.
    func reveal(_ shown: Bool) -> some View {
        opacity(shown ? 1 : 0).offset(y: shown ? 0 : Space.xs).animation(Motion.expressive, value: shown)
    }
}

// MARK: - Server

private struct ServerPage: View {
    let flow: OnboardingFlow
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        @Bindable var flow = flow
        OnboardingColumn(title: "Agent 在哪台电脑上运行", subtitle: "之后可以在设置里更改") {
            ChoiceCard(title: String(localized: "这台 Mac"), detail: String(localized: "使用 App 自带的服务器"), selected: flow.server == .mac, action: { flow.server = .mac }) {
                Image(icon: "desktopcomputer").font(RiffetFont.body).foregroundStyle(palette.fg2)
            }
            ChoiceCard(title: String(localized: "其他服务器"), detail: String(localized: "需要地址和配对码"), selected: flow.server == .remote, action: { flow.server = .remote }) {
                Image(icon: "server.rack").font(RiffetFont.body).foregroundStyle(palette.fg2)
            }
            if flow.server == .remote {
                VStack(alignment: .leading, spacing: Space.md) {
                    field("地址", text: $flow.address, prompt: "192.168.1.10:4337")
                        .onChange(of: flow.address) { _, value in flow.applyPayload(value) }
                    field("配对码", text: $flow.code, prompt: "riffet pair")
                }
                .padding(.horizontal, Space.xs)
                .padding(.top, Space.sm)
                .transition(.opacity)
            }
            if let error = flow.error {
                Text(error).font(RiffetFont.caption).foregroundStyle(palette.danger)
                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }
        } foot: {
            OnboardingPrimaryButton(
                title: flow.connecting ? (flow.server == .mac ? "正在启动" : "正在连接") : (flow.server == .mac ? "启动" : "连接"),
                busy: flow.connecting,
                enabled: flow.server == .mac || (!flow.address.isEmpty && !flow.code.isEmpty)
            ) { Task { await flow.connect(model: model) } }
        }
        .animation(Motion.standard, value: flow.server)
    }

    private func field(_ title: LocalizedStringResource, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title).font(RiffetFont.caption).foregroundStyle(palette.fg3)
            TextField(text: text, prompt: Text(verbatim: prompt)) { Text(title) }
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .controlSize(.large)
        }
    }
}

// MARK: - Agent

private struct AgentPage: View {
    let flow: OnboardingFlow
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        if let workbench = model.workbench {
            if flow.agentMode == .many {
                OnboardingColumn(title: "默认用哪个 Agent", subtitle: "新建会话时可以换") {
                    ForEach(workbench.backends.filter(\.isPickable), id: \.agent) { entry in
                        let usable = entry.available && entry.needsLogin?.boolValue != true
                        ChoiceCard(title: entry.label, detail: status(entry), selected: flow.agent == entry.agent, enabled: usable, action: { flow.agent = entry.agent }) {
                            AgentMarkView(backend: entry.agent, size: 20, color: palette.fg)
                        }
                    }
                } foot: {
                    OnboardingPrimaryButton(title: "继续") { Task { await flow.saveAgent(workbench, model: model) } }
                }
            } else {
                OnboardingColumn(
                    title: "还没有可用的 Agent",
                    subtitle: workbench.local ? "Riffet 调用这台 Mac 上安装的 CLI，装好任意一个即可" : "Riffet 调用服务器上安装的 CLI，装好任意一个即可"
                ) {
                    AgentInstallList(rows: AgentInstall.rows(for: workbench.backends))
                } foot: {
                    OnboardingPrimaryButton(title: "重新检测", busy: flow.rechecking) { Task { await flow.recheck(workbench, model: model) } }
                }
            }
        }
    }

    private func status(_ entry: NativeBackendCatalogEntry) -> String {
        if entry.available, entry.needsLogin?.boolValue != true { return String(localized: "可用") }
        if entry.needsLogin?.boolValue == true { return String(localized: "未登录") }
        return entry.reason ?? String(localized: "未安装")
    }
}

// MARK: - Project

private struct ProjectPage: View {
    let flow: OnboardingFlow
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        if let workbench = model.workbench {
            OnboardingColumn(title: "从哪个目录开始", subtitle: "Agent 会在所选目录里读写文件") {
                Button { flow.chooseDirectory(workbench) } label: {
                    HStack(spacing: Space.md) {
                        Image(icon: "folder").font(RiffetFont.body).foregroundStyle(palette.fg2)
                        if let directory = flow.directory {
                            Text(abbreviateHome(directory)).font(RiffetFont.label).foregroundStyle(palette.fg).lineLimit(1).truncationMode(.head)
                        } else {
                            Text("选择目录…").font(RiffetFont.label).foregroundStyle(palette.fg3)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Space.md)
                    .frame(height: 48)
                    .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
                    .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                }
                .buttonStyle(.plain)
                if let error = flow.error {
                    Text(error).font(RiffetFont.caption).foregroundStyle(palette.danger).frame(maxWidth: .infinity, alignment: .leading)
                }
            } foot: {
                Button("先不选") { flow.skipProject(workbench, model: model) }.buttonStyle(OnboardingButtonStyle(kind: .ghost))
                OnboardingPrimaryButton(title: "继续", enabled: flow.directory != nil) { flow.advance(from: .project, model: model) }
            }
            .sheet(isPresented: Bindable(flow).browsing) {
                DirectoryBrowser(workbench: workbench) { path in Task { await flow.open(path, workbench) } }
            }
        }
    }
}

// MARK: - Phone

private struct PhonePage: View {
    let flow: OnboardingFlow
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        OnboardingColumn(title: "在手机上接着看", subtitle: "用手机上的 Riffet 扫码，离开电脑也能处理审批") {
            VStack(spacing: Space.md) {
                if flow.needsNetworkAccess && flow.pairing == nil {
                    // The code's place, held until the server can be reached from the network: the QR
                    // then appears where this stood.
                    Group {
                        if flow.openingNetwork {
                            VStack(spacing: Space.sm) {
                                Spinner(size: .small)
                                Text("正在重启服务器").font(RiffetFont.label).foregroundStyle(palette.fg3)
                            }
                        } else {
                            Image(icon: "qrcode").font(RiffetFont.pageTitle).foregroundStyle(palette.fg4)
                        }
                    }
                    .frame(width: 172, height: 172)
                    .padding(Space.lg)
                    .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                    if flow.openingNetwork { RestartBlockersView(server: model.server, onboarding: true) }
                    if let error = flow.networkError {
                        Text(verbatim: error).font(RiffetFont.caption).foregroundStyle(palette.danger).multilineTextAlignment(.center)
                    }
                } else {
                    Group {
                        if let image = flow.pairingQR {
                            Image(nsImage: image).interpolation(.none).resizable().frame(width: 172, height: 172)
                        } else {
                            Spinner(size: .small).frame(width: 172, height: 172)
                        }
                    }
                    .padding(Space.lg)
                    .background(.white, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.lineSoft))
                    if let device = flow.pairedDevice {
                        Label("\(device.name) 已连接", icon: "checkmark.circle")
                            .font(RiffetFont.label).foregroundStyle(palette.fg)
                        if device.allowControl {
                            Text("在「技能与工具」里可以让 Agent 操作这台手机")
                                .font(RiffetFont.caption).foregroundStyle(palette.fg3).multilineTextAlignment(.center)
                        }
                    } else {
                        HStack(spacing: Space.sm) {
                            Spinner(size: .small)
                            Text("等待扫码").font(RiffetFont.label).foregroundStyle(palette.fg3)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity)
        } foot: {
            if flow.pairedDevice == nil {
                Button("以后再说") { flow.advance(from: .phone, model: model) }.buttonStyle(OnboardingButtonStyle(kind: .ghost))
                if flow.needsNetworkAccess && flow.pairing == nil {
                    OnboardingPrimaryButton(title: "允许同一网络的设备连接", busy: flow.openingNetwork) {
                        Task { await flow.allowNetworkAccess(model: model) }
                    }
                    .disabled(!flow.openingNetwork && (model.server.restartBlockers != nil || model.server.maintenance?.running == true))
                }
            } else {
                OnboardingPrimaryButton(title: "继续") { flow.advance(from: .phone, model: model) }
            }
        }
        .task { await flow.watchDevices(model: model) }
    }
}

// MARK: - Notifications and login

private struct NotifyPage: View {
    let flow: OnboardingFlow
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        @Bindable var flow = flow
        OnboardingColumn(title: "需要你时通知你", subtitle: "Agent 等待审批、提问或完成时") {
            Toggle("登录时打开 Riffet", isOn: $flow.launchAtLogin)
                .toggleStyle(.switch)
                .font(RiffetFont.label)
                .foregroundStyle(palette.fg)
                .padding(.horizontal, Space.md)
                .frame(height: 48)
                .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
        } foot: {
            if flow.asksNotifications {
                Button("以后再说") { Task { await flow.finish(askNotifications: false, model: model) } }
                    .buttonStyle(OnboardingButtonStyle(kind: .ghost))
                    .disabled(flow.finishing)
                OnboardingPrimaryButton(title: "允许通知", busy: flow.finishing) {
                    Task { await flow.finish(askNotifications: true, model: model) }
                }
            } else {
                OnboardingPrimaryButton(title: "完成", busy: flow.finishing) {
                    Task { await flow.finish(askNotifications: false, model: model) }
                }
            }
        }
    }
}
