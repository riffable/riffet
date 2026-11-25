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
                Circle().strokeBorder(palette.fg4, lineWidth: 1.25)
            case .current:
                Circle().strokeBorder(palette.fg, lineWidth: 1.25)
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

/// The composer's shape and material: the three steps in a row on top, the current step's body below,
/// both on the card's one text edge. Nothing in the body draws a box of its own: the card is the only one.
struct SetupCard<Content: View>: View {
    let steps: [SetupStep]
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                    if index > 0 { palette.line.frame(minWidth: 8, maxWidth: 16, maxHeight: 1) }
                    HStack(spacing: 6) {
                        SetupGlyph(state: step.state)
                        Text(label(step)).riffetFont(.label, weight: weight(step)).foregroundStyle(color(step)).lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                }
                Spacer(minLength: 0)
            }
            .frame(height: RiffetMetrics.settingsRowHeight)
            VStack(alignment: .leading, spacing: RiffetMetrics.groupGap) { content }
                .padding(.bottom, RiffetMetrics.groupInset)
        }
        .padding(.horizontal, RiffetMetrics.groupInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.composerRadius, style: .continuous))
    }

    private func label(_ step: SetupStep) -> String {
        if case let .done(result) = step.state { return result }
        return step.title
    }
    private func color(_ step: SetupStep) -> Color {
        switch step.state {
        case .pending: palette.fg4
        case .done: palette.fg2
        default: palette.fg
        }
    }
    private func weight(_ step: SetupStep) -> Font.Weight {
        if case .done = step.state { return .regular }
        return .medium
    }
}

// MARK: - Server step

/// A server to connect to, saved or found on the network: the settings tile, its name, its address when the
/// name is not already the address, and the verb at the end in the accent colour. The row is the button.
struct SetupServerRow: View {
    let symbol: String
    let name: String
    var detail: String? = nil
    let verb: String
    var busy = false
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(spacing: RiffetMetrics.groupGap) {
                SettingsIcon(symbol: symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                    if let detail { Text(detail).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.middle) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if busy { ProgressView() }
                else { Text(verb).riffetFont(.label).foregroundStyle(palette.accent) }
            }
            .frame(minHeight: RiffetMetrics.settingsRowHeight)
        }
        .buttonStyle(RiffetRowPressStyle())
        .accessibilityElement(children: .combine)
    }
}

/// One Mac found on the network: 连接 opens pairing with the address filled in (the pairing code is still asked for).
struct LanServerRow: View {
    let found: DiscoveredRiffetServer
    let connect: () -> Void

    var body: some View {
        SetupServerRow(symbol: "wifi", name: found.name, detail: found.host, verb: String(localized: "连接", bundle: .riffet), action: connect)
    }
}

/// The server step's body: the servers to pick from, then scanning, then typing an address.
struct ServerStepBody<Rows: View>: View {
    let discovery: BonjourDiscovery
    let scan: () -> Void
    let connect: (DiscoveredRiffetServer) -> Void
    let manual: () -> Void
    @ViewBuilder var saved: Rows

    var body: some View {
        ServerRowList {
            saved
            ForEach(discovery.servers) { found in LanServerRow(found: found) { connect(found) } }
        }
        VStack(spacing: 0) {
            Button(action: scan) {
                Label(String(localized: "扫码配对", bundle: .riffet), systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .accessibilityIdentifier("pairNew")
            Button(String(localized: "输入地址", bundle: .riffet), action: manual)
                .buttonStyle(.borderless).frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget)
        }
    }
}

/// Server rows with a hairline between them, inset to the text so the tiles stand clear.
struct ServerRowList<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette
    @ScaledMetric(relativeTo: .body) private var tile = RiffetMetrics.iconSlot

    var body: some View {
        Group(subviews: content) { rows in
            if !rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(rows) { row in
                        if row.id != rows.first?.id {
                            palette.line.frame(height: 1).padding(.leading, tile + RiffetMetrics.groupGap)
                        }
                        row
                    }
                }
            }
        }
    }
}

/// Servers this phone already holds a pairing for, shown while none is connected (the last one is
/// offline, or its pairing expired): 连接 tries it again, 重新配对 pairs again when the pairing is gone.
struct SavedServerRows: View {
    @Bindable var model: AppModel
    let pair: (PairedServer) -> Void

    var body: some View {
        ForEach(model.pairedServers.sorted { $0.lastUsedAt > $1.lastUsedAt }, id: \.origin) { server in
            let failure = model.serverFailures[server.origin]
            let expired = failure == String(localized: "需重新配对", bundle: .riffet)
            let address = server.baseUrl.replacingOccurrences(of: #"^[a-z]+://"#, with: "", options: .regularExpression)
            SetupServerRow(symbol: "desktopcomputer", name: server.displayName,
                           detail: failure.flatMap { expired ? nil : $0 } ?? (address == server.displayName ? nil : address),
                           verb: expired ? String(localized: "重新配对", bundle: .riffet) : String(localized: "连接", bundle: .riffet),
                           busy: model.switchingOrigin == server.origin) {
                if expired { pair(server) } else { Task { await model.switchServer(server) } }
            }
            .disabled(model.connectionBusy)
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
                VStack(alignment: .leading, spacing: RiffetMetrics.groupGap) {
                    Text(String(localized: "Agent 会在所选目录里读写文件", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg2)
                        
                    HStack(spacing: 8) {
                        Button(String(localized: "跳过", bundle: .riffet), action: skip)
                            .buttonStyle(.bordered).tint(palette.fg).controlSize(.large).fixedSize()
                        Button(action: pickProject) { Text(String(localized: "选择项目", bundle: .riffet)).frame(maxWidth: .infinity) }
                            .buttonStyle(.borderedProminent).controlSize(.large)
                            .accessibilityIdentifier("newTaskProject")
                    }
                }
            } else if workbench.backendsLoaded {
                VStack(alignment: .leading, spacing: RiffetMetrics.groupGap) {
                    Text(workbench.backendError ?? String(localized: "没有找到可用的 Agent", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg2)
                        
                    Button {
                        Task { workbench.store.invalidateBackendCatalog(); await workbench.loadBackends() }
                    } label: { Text(String(localized: "重新读取 Agent", bundle: .riffet)).frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).tint(palette.fg).controlSize(.large)
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

/// 新会话 with no server: the mark, and the setup card at the server step where the composer will be.
struct UnconnectedNewTaskView: View {
    @Bindable var model: AppModel
    @Environment(\.palette) private var palette
    @State private var discovery = BonjourDiscovery()
    @State private var target: PairingPrefill?

    var body: some View {
        GeometryReader { viewport in
            ScrollView {
                NewTaskLayout(minHeight: viewport.size.height, markShown: true) {
                    LiveBrandMark(front: palette.fg, back: palette.accent)
                    SetupCard(steps: steps) {
                        notice
                        ServerStepBody(discovery: discovery,
                                       scan: { target = PairingPrefill(scan: true) },
                                       connect: { target = PairingPrefill(address: $0.baseURL, name: $0.name) },
                                       manual: { target = PairingPrefill(address: model.address) }) {
                            SavedServerRows(model: model) { target = PairingPrefill(address: $0.baseUrl, name: $0.name) }
                        }
                    }
                    .riffetTypeBoundary()
                    .padding(.horizontal, RiffetMetrics.pageInset)
                    Color.clear.frame(height: 0)
                }
                .frame(maxWidth: .infinity)
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

    /// The step's one sentence: why the last connection failed, or why nothing was found on the network.
    @ViewBuilder private var notice: some View {
        if let error = model.error { RiffetNotice(kind: .error, message: error) }
        else if let failure = discovery.failure {
            RiffetNotice(kind: .warning, message: failure, actionTitle: String(localized: "重新查找", bundle: .riffet), action: { discovery.stop(); discovery.start() })
        }
    }

    private var steps: [SetupStep] {
        [SetupStep(title: String(localized: "服务器", bundle: .riffet), state: model.connectionBusy ? .busy : .current),
         SetupStep(title: String(localized: "Agent", bundle: .riffet), state: .pending),
         SetupStep(title: String(localized: "项目", bundle: .riffet), state: .pending)]
    }
}
