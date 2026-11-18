import SwiftUI
import RiffetKit

// First-launch setup (patterns.md §1.5): the card that stands where the new-session composer is until a
// server, an Agent and a project exist, and the empty state of pages that need a server.

/// Switches to 新会话, where the setup card is. Set by the tabs; a settings page's 连接 pops itself first.
private struct ConnectServerKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

extension EnvironmentValues {
    var connectServer: () -> Void {
        get { self[ConnectServerKey.self] }
        set { self[ConnectServerKey.self] = newValue }
    }
}

/// A page that needs a server, with no server: assistant, tasks, and the settings rows marked 未连接.
struct NeedsServerView: View {
    @Environment(\.connectServer) private var connect
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        ContentUnavailableView {
            Label { Text(String(localized: "需要连接服务器", bundle: .riffet)).riffetFont(.headline).foregroundStyle(palette.fg) }
                icon: { Image(systemName: "server.rack").foregroundStyle(palette.fg3) }
        } actions: {
            Button(String(localized: "连接", bundle: .riffet)) { dismiss(); connect() }
                .buttonStyle(.bordered)
        }
        .background(palette.bg)
    }
}

// MARK: - The card

enum SetupStepState: Equatable {
    case pending, current, busy
    /// Done, with its result: the server's name, the Agent's, the project's.
    case done(String)
}

struct SetupStep: Identifiable {
    let title: String
    let state: SetupStepState
    var id: String { title }
}

private struct SetupGlyph: View {
    let state: SetupStepState
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            switch state {
            case .pending:
                Circle().strokeBorder(palette.fg4, lineWidth: 1.5)
            case .current:
                Circle().strokeBorder(palette.fg, lineWidth: 1.5)
                Circle().fill(palette.fg).frame(width: 6, height: 6)
            case .busy:
                ProgressView().controlSize(.mini)
            case .done:
                Circle().fill(palette.fg2)
                Image(systemName: "checkmark").riffetFont(.caption, weight: .bold).foregroundStyle(palette.bg).scaleEffect(0.62)
            }
        }
        .frame(width: 16, height: 16)
    }
}

/// The composer's shape and material with the three steps on top and the current step's body below.
struct SetupCard<Content: View>: View {
    let steps: [SetupStep]
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                ForEach(steps) { step in
                    HStack(spacing: 6) {
                        SetupGlyph(state: step.state)
                        Text(label(step)).riffetFont(.caption, weight: .medium).foregroundStyle(color(step)).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                }
            }
            content
        }
        .padding(RiffetMetrics.groupInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.composerRadius, style: .continuous))
    }

    private func label(_ step: SetupStep) -> String {
        if case let .done(result) = step.state { return result }
        return step.title
    }
    private func color(_ step: SetupStep) -> Color {
        switch step.state {
        case .pending: palette.fg3
        default: palette.fg
        }
    }
}

// MARK: - Server step

/// One Mac found on the network: its name and address, 连接 opens pairing with the address filled in
/// (the pairing code is still asked for).
struct LanServerRow: View {
    let found: DiscoveredRiffetServer
    let connect: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "wifi").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
            VStack(alignment: .leading, spacing: 2) {
                Text(found.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                Text(found.host).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
            }
            Spacer(minLength: 8)
            Button(String(localized: "连接", bundle: .riffet), action: connect).buttonStyle(.bordered).controlSize(.small)
        }
        .frame(minHeight: RiffetMetrics.hitTarget)
    }
}

/// The server step's body: scanning, the Macs found on the network, typing an address.
struct ServerStepBody: View {
    let discovery: BonjourDiscovery
    let scan: () -> Void
    let connect: (DiscoveredRiffetServer) -> Void
    let manual: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: scan) {
                Label(String(localized: "扫码配对", bundle: .riffet), systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .accessibilityIdentifier("pairNew")
            ForEach(discovery.servers) { found in LanServerRow(found: found) { connect(found) } }
            Button(String(localized: "输入地址", bundle: .riffet), action: manual)
                .buttonStyle(.borderless).frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget)
        }
    }
}

/// Servers this phone already holds a pairing for, shown while none is connected (the last one is
/// offline, or its pairing expired): a row connects, or pairs again when the pairing is gone.
struct SavedServerRows: View {
    @Bindable var model: AppModel
    let pair: (PairedServer) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        ForEach(model.pairedServers.sorted { $0.lastUsedAt > $1.lastUsedAt }, id: \.origin) { server in
            Button {
                if model.serverFailures[server.origin] == String(localized: "需重新配对", bundle: .riffet) { pair(server) }
                else { Task { await model.switchServer(server) } }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "server.rack").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(server.displayName).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                        Text(server.baseUrl).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if model.switchingOrigin == server.origin { ProgressView() }
                    else if let failure = model.serverFailures[server.origin] { Text(failure).riffetFont(.caption).foregroundStyle(palette.fg3) }
                }
                .frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.connectionBusy)
        }
    }
}

// MARK: - Connected, not yet ready

/// The card once a server is connected and an Agent or a project is still missing; it gives way to the
/// composer in place when both are there. Wording: an Agent the server did not find, or a project to pick.
struct ConnectedSetupCard: View {
    let workbench: Workbench
    let pickProject: () -> Void
    let skip: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    private var serverName: String {
        model.pairedServers.first(where: model.isCurrent)?.displayName ?? workbench.baseURL.host() ?? ""
    }
    private var agents: [NativeBackendCatalogEntry] { workbench.backends.filter { $0.backendId != .chat && $0.available } }
    private var agentName: String? {
        let preferred = workbench.settings?.defaultBackendId.flatMap { id in agents.first { $0.backendId == id } }
        return (preferred ?? agents.first)?.label
    }
    private var agentReady: Bool { agentName != nil }
    private var steps: [SetupStep] {
        let server = SetupStep(title: String(localized: "服务器", bundle: .riffet), state: .done(serverName))
        let agentTitle = String(localized: "Agent", bundle: .riffet)
        let agent: SetupStep
        if let agentName { agent = SetupStep(title: agentTitle, state: .done(agentName)) }
        else { agent = SetupStep(title: agentTitle, state: workbench.backendsLoaded ? .current : .busy) }
        let project = SetupStep(title: String(localized: "项目", bundle: .riffet), state: agentReady ? .current : .pending)
        return [server, agent, project]
    }

    var body: some View {
        SetupCard(steps: steps) {
            if agentReady {
                VStack(alignment: .leading, spacing: 12) {
                    Text(String(localized: "Agent 会在所选目录里读写文件", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg)
                    HStack(spacing: 8) {
                        Button(action: skip) { Text(String(localized: "跳过", bundle: .riffet)).frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered).controlSize(.large)
                        Button(action: pickProject) { Text(String(localized: "选择项目", bundle: .riffet)).frame(maxWidth: .infinity) }
                            .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity)
                            .layoutPriority(1)
                            .accessibilityIdentifier("newTaskProject")
                    }
                }
            } else if workbench.backendsLoaded {
                VStack(alignment: .leading, spacing: 12) {
                    Text(workbench.backendError ?? String(localized: "没有找到可用的 Agent", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg)
                    Button {
                        Task { workbench.store.invalidateBackendCatalog(); await workbench.loadBackends() }
                    } label: { Text(String(localized: "重新读取 Agent", bundle: .riffet)).frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).controlSize(.large)
                }
            }
        }
    }

    /// Whether the card replaces the composer: no usable Agent once the list is read, or no project at all.
    static func needed(_ workbench: Workbench, skipped: Bool) -> Bool {
        let noAgent = workbench.backendsLoaded && workbench.backendError == nil
            && !workbench.backends.contains { $0.backendId != .chat && $0.available }
        let noProject = workbench.list.loaded && workbench.list.error == nil && workbench.projects.isEmpty
        return noAgent || (noProject && !skipped)
    }
}

// MARK: - Unconnected

/// 新会话 with no server: the mark, and the setup card at the server step.
struct UnconnectedNewTaskView: View {
    @Bindable var model: AppModel
    @Environment(\.palette) private var palette
    @State private var discovery = BonjourDiscovery()
    @State private var target: PairingPrefill?

    var body: some View {
        GeometryReader { viewport in
            ScrollView {
                VStack(spacing: 24) {
                    LiveBrandMark(front: palette.fg, back: palette.accent).frame(width: 96, height: 96)
                    VStack(alignment: .leading, spacing: 8) {
                        SetupCard(steps: steps) {
                            VStack(alignment: .leading, spacing: 8) {
                                SavedServerRows(model: model) { target = PairingPrefill(address: $0.baseUrl, name: $0.name) }
                                ServerStepBody(discovery: discovery,
                                               scan: { target = PairingPrefill(scan: true) },
                                               connect: { target = PairingPrefill(address: $0.baseURL, name: $0.name) },
                                               manual: { target = PairingPrefill(address: model.address) })
                            }
                        }
                        .riffetTypeBoundary()
                        if let error = model.error { RiffetNotice(kind: .error, message: error, boxed: true) }
                        else if let failure = discovery.failure {
                            RiffetNotice(kind: .warning, message: failure, actionTitle: String(localized: "重新查找", bundle: .riffet), action: { discovery.stop(); discovery.start() }, boxed: true)
                        }
                    }
                }
                .padding(.horizontal, RiffetMetrics.pageInset)
                .frame(maxWidth: .infinity, minHeight: viewport.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(palette.bg)
        .navigationTitle(String(localized: "新会话", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $target) { prefill in
            PairingView(model: model, initialAddress: prefill.address, initialName: prefill.name, initialScan: prefill.scan)
        }
        .task {
            await model.refreshPairedServers()
            discovery.start()
        }
        .onDisappear { discovery.stop() }
    }

    private var steps: [SetupStep] {
        [SetupStep(title: String(localized: "服务器", bundle: .riffet), state: model.connectionBusy ? .busy : .current),
         SetupStep(title: String(localized: "Agent", bundle: .riffet), state: .pending),
         SetupStep(title: String(localized: "项目", bundle: .riffet), state: .pending)]
    }
}
