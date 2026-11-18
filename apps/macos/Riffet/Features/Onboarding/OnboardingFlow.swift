import SwiftUI
import RiffetKit

/// The first-launch guide's state: which page, what has been decided, and the work each page starts.
/// A page exists only while it asks for a decision, so the list of pages follows what is known.
@MainActor
@Observable
final class OnboardingFlow {
    enum Page: Equatable { case welcome, server, agent, project, phone }
    enum ServerChoice { case mac, remote }
    enum AgentMode { case missing, many }

    private(set) var page = Page.welcome
    private(set) var forward = true

    // Server
    var server = ServerChoice.mac
    var address = ""
    var code = ""
    private var payloadName: String?
    private var payloadAddress: String?
    private(set) var connecting = false
    private(set) var error: String?

    // What is known once connected. Nil until then: the page is assumed to be needed.
    private(set) var agentMode: AgentMode?
    var agent = ""
    private(set) var needsProject = true
    private(set) var rechecking = false

    // Project
    private(set) var directory: String?
    private(set) var choosingDirectory = false
    var browsing = false

    // Phone
    private(set) var pairing: PairingCodeResponse?
    private(set) var pairingQR: NSImage?
    private(set) var pairedDevice: PublicDevice?
    private(set) var phoneAvailable = true
    /// The local server listens on this Mac alone: the page offers to open it to the network instead of a code.
    private(set) var needsNetworkAccess = false
    private(set) var openingNetwork = false
    private(set) var networkError: String?
    @ObservationIgnored private var baseline: Set<String> = []

    /// The full order. A page is skipped when it is not needed, but the current one always stays in the
    /// list, so deciding something on it (one Agent found, no phone pairing) never moves the reader.
    private static let order: [Page] = [.welcome, .server, .agent, .project, .phone]

    private func needed(_ candidate: Page) -> Bool {
        switch candidate {
        case .welcome, .server: true
        case .agent: agentMode != nil
        case .project: needsProject
        case .phone: phoneAvailable
        }
    }

    var pages: [Page] { Self.order.filter { $0 == page || needed($0) } }

    var index: Int { pages.firstIndex(of: page) ?? 0 }
    /// The pages after the welcome one, which the progress segments count.
    var segments: Int { max(pages.count - 1, 0) }
    var canGoBack: Bool { index > 1 }

    // MARK: Navigation

    /// Moves on from [current] (the page whose action this is), using the list as it stands now.
    func advance(from current: Page, model: AppModel) {
        guard page == current else { return }
        guard let at = Self.order.firstIndex(of: current),
              let next = Self.order.dropFirst(at + 1).first(where: needed) else { return model.finishOnboarding() }
        go(to: next, forward: true, model: model)
    }

    func back(model: AppModel) {
        guard canGoBack else { return }
        go(to: pages[index - 1], forward: false, model: model)
    }

    private func go(to next: Page, forward: Bool, model: AppModel) {
        self.forward = forward
        error = nil
        withAnimation(Motion.standard) { page = next }
        if next == .phone {
            Task {
                await preparePairing(model: model)
                // Nothing to scan on this server: the page would only spin.
                if !phoneAvailable { model.finishOnboarding() }
            }
        }
    }

    // MARK: Server

    private var connectedKind: ServerChoice? {
        guard AppModel.shared.workbench != nil else { return nil }
        return AppModel.shared.target == .local ? .mac : .remote
    }

    func connect(model: AppModel) async {
        guard !connecting else { return }
        connecting = true
        error = nil
        defer { connecting = false }
        if connectedKind != server {
            switch server {
            case .mac:
                await model.startServer()
            case .remote:
                do {
                    try await model.pairRemote(address: address, code: code.trimmingCharacters(in: .whitespaces), name: address == payloadAddress ? payloadName : nil)
                } catch {
                    self.error = error.riffetMessage
                    return
                }
            }
        }
        guard let workbench = model.workbench else {
            error = Self.failure(model)
            return
        }
        await settle(workbench, model: model)
        advance(from: .server, model: model)
    }

    private static func failure(_ model: AppModel) -> String {
        if case let .failed(message) = model.phase { return message }
        if case let .failed(message) = model.server.state { return message }
        return String(localized: "无法连接 Riffet")
    }

    /// What the connected server already has decides which of the later pages are needed.
    private func settle(_ workbench: Workbench, model: AppModel) async {
        await workbench.loadBackends()
        for _ in 0..<30 where !workbench.list.loaded { try? await Task.sleep(for: .milliseconds(100)) }
        needsProject = !workbench.homeProjectChosen
        readAgents(workbench)
        await preparePairing(model: model)
    }

    func applyPayload(_ raw: String) {
        guard let payload = PairingPayload(parsing: raw) else { return }
        address = payload.address
        code = payload.code
        payloadAddress = payload.address
        payloadName = payload.name
    }

    // MARK: Agent

    private func readAgents(_ workbench: Workbench) {
        let usable = workbench.backends.filter { $0.isPickable && $0.available && $0.needsLogin?.boolValue != true }
        switch usable.count {
        case 0: agentMode = .missing
        case 1: agentMode = nil
        default:
            agentMode = .many
            let saved = workbench.settings?.defaultAgent ?? ""
            agent = usable.contains { $0.agent == saved } ? saved : usable[0].agent
        }
    }

    func recheck(_ workbench: Workbench, model: AppModel) async {
        rechecking = true
        await workbench.loadBackends()
        rechecking = false
        readAgents(workbench)
        if agentMode != .missing { advance(from: .agent, model: model) }
    }

    func saveAgent(_ workbench: Workbench, model: AppModel) async {
        if !agent.isEmpty { await workbench.rememberDefaults(agent: agent, makeDefault: true) }
        advance(from: .agent, model: model)
    }

    // MARK: Project

    func chooseDirectory(_ workbench: Workbench) {
        if workbench.local {
            Task {
                guard let url = await DirectoryPanel.choose(prompt: String(localized: "在此新建会话")) else { return }
                await open(url.path, workbench)
            }
        } else {
            browsing = true
        }
    }

    func open(_ path: String, _ workbench: Workbench) async {
        do {
            let project = try await workbench.openDirectory(path)
            workbench.selectHomeProject(project.id)
            directory = path
            error = nil
        } catch {
            self.error = error.riffetMessage
        }
    }

    func skipProject(_ workbench: Workbench, model: AppModel) {
        if workbench.supportsProjectlessTasks { workbench.selectHomeProject(nil) }
        advance(from: .project, model: model)
    }

    // MARK: Phone

    /// A pairing code lasts five minutes; the one already issued is reused while it has a minute left.
    /// [tolerant]: a failed request leaves the page as it is (the server is restarting) instead of dropping it.
    func preparePairing(model: AppModel, fresh: Bool = false, tolerant: Bool = false) async {
        guard let api = model.workbench?.host.api else { return }
        if !fresh, let expiry = pairing?.expiresAt, Date().timeIntervalSince1970 * 1000 < Double(expiry) - 60_000 { return }
        do {
            let next = try await api.pairingCode(name: nil)
            if next.localOnly {
                // A phone cannot scan a server that listens on this Mac alone: the local one can be opened to the
                // network here; any other has nothing to offer.
                guard model.target == .local, let manager = model.server.state.running?.manager, model.server.canSetNetworkAccess(manager) else {
                    phoneAvailable = false
                    return
                }
                needsNetworkAccess = true
                return
            }
            needsNetworkAccess = false
            pairing = next
            pairingQR = ConnectionSettings.qrImage(next)
            pairedDevice = nil
            baseline = Set((try? await api.devices())?.map(\.id) ?? [])
        } catch {
            if !tolerant { phoneAvailable = false }
        }
    }

    /// Opens the local server to the network, then shows the code once it answers again.
    func allowNetworkAccess(model: AppModel) async {
        guard !openingNetwork else { return }
        openingNetwork = true
        networkError = nil
        defer { openingNetwork = false }
        do {
            guard try await model.server.setNetworkAccess(true) else { return }
            for _ in 0..<60 where pairing == nil {
                await preparePairing(model: model, fresh: true, tolerant: true)
                if pairing == nil { try? await Task.sleep(for: .milliseconds(500)) }
            }
            if pairing == nil { networkError = String(localized: "无法连接 Riffet") }
        } catch {
            networkError = error.riffetMessage
        }
    }

    /// Watches for a phone that took the code; the page's task runs it while the page is up.
    func watchDevices(model: AppModel) async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            guard let api = model.workbench?.host.api, let devices = try? await api.devices() else { continue }
            if let found = devices.first(where: { !baseline.contains($0.id) && ($0.platform == "ios" || $0.platform == "android") }) {
                pairedDevice = found
            }
            if let expiry = pairing?.expiresAt, pairedDevice == nil, Date().timeIntervalSince1970 * 1000 > Double(expiry) - 15_000 {
                await preparePairing(model: model, fresh: true)
            }
        }
    }
}
