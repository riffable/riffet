import Foundation
import RiffetKit

/// The project terminal docked below the conversation and its composer: whether it shows, which
/// shell each project last chose, and opening one.
@MainActor
@Observable
final class TerminalDock {
    /// The workbench it belongs to, set once by it: the project and page the dock follows.
    @ObservationIgnored weak var workbench: Workbench?

    /// The dock is open.
    var shown = false {
        didSet { if shown { workbench?.exitInspectorMaximized() } }
    }
    /// The dock opened by itself for an interaction the card cannot render; it closes the same way.
    var automatic = false
    /// A shell to reveal in its project's panel, including one just created from the home page.
    var focus: TerminalInfo?
    /// Keep each project's chosen terminal when its dock is closed or another project is opened.
    var selections: [String: String] = [:]
    private(set) var focusRequest = 0
    private(set) var openingShell = false
    var error: String?
    @ObservationIgnored private var navigationRevision = 0
    /// Bounded LRU keep-alive pool of terminal controllers (`TERMINAL_BUDGET_KEEP_ALIVE_LIMIT`) so
    /// switching shells or collapsing the dock preserves live sockets, scrollback, and selection.
    @ObservationIgnored private var controllers: [String: TerminalController] = [:]
    @ObservationIgnored private var controllerOrder: [String] = []

    func controller(for terminalId: String) -> TerminalController {
        if let existing = controllers[terminalId] {
            controllerOrder.removeAll { $0 == terminalId }
            controllerOrder.append(terminalId)
            return existing
        }
        let created = TerminalController()
        controllers[terminalId] = created
        controllerOrder.append(terminalId)
        let limit = max(1, Int(BudgetsKt.TERMINAL_BUDGET_KEEP_ALIVE_LIMIT))
        var evicted: [TerminalController] = []
        while controllerOrder.count > limit {
            let evictedId = controllerOrder.removeFirst()
            if let removed = controllers.removeValue(forKey: evictedId) {
                evicted.append(removed)
            }
        }
        if !evicted.isEmpty {
            // Defer observable mutations out of SwiftUI `body` evaluation.
            DispatchQueue.main.async {
                for controller in evicted { controller.stop() }
            }
        }
        return created
    }

    func evictController(for terminalId: String) {
        controllerOrder.removeAll { $0 == terminalId }
        controllers.removeValue(forKey: terminalId)?.stop()
    }

    func stopAllControllers() {
        for controller in controllers.values { controller.stop() }
        controllers.removeAll()
        controllerOrder.removeAll()
    }

    /// Shared by the conversation menu, home page, command palette and keyboard shortcut.
    /// Fetching the list also excludes shells that have exited since this window last saw them.
    func openShell(projectId: String? = nil, createNew: Bool = false) async {
        guard let workbench, !openingShell, !workbench.quickChatContext, !workbench.assistantContext, workbench.page == nil,
              let projectId = projectId ?? workbench.currentProjectId, projectId == workbench.currentProjectId else { return }
        let request = RequestContext { self.navigationContext }
        openingShell = true
        defer { openingShell = false }
        do {
            guard let api = workbench.host.api else { throw LocalPairing.Failure(message: String(localized: "服务器未连接，请稍后重试")) }
            let info: TerminalInfo
            if createNew {
                info = try await api.createShellTerminal(projectId: projectId, title: nil)
            } else {
                let shells = try await api.terminals().filter { $0.projectId == projectId && $0.kind == .shell && $0.state != .exited }
                if let existing = shells.first(where: { $0.id == selections[projectId] }) ?? shells.first {
                    info = existing
                } else {
                    guard request.isCurrent else { return }
                    info = try await api.createShellTerminal(projectId: projectId, title: nil)
                }
            }
            guard request.isCurrent else { return }
            error = nil
            reveal(info)
        } catch {
            if request.isCurrent { self.error = error.riffetMessage }
        }
    }

    private var navigationContext: String {
        guard let workbench else { return "" }
        return "\(workbench.showingHome ? "home" : workbench.selected?.id ?? "")|\(workbench.currentProjectId ?? "")|\(workbench.page?.rawValue ?? "")|\(navigationRevision)"
    }

    func reveal(_ terminal: TerminalInfo) {
        guard let workbench, terminal.projectId == workbench.currentProjectId, workbench.page == nil else { return }
        focus = terminal
        select(terminal.id, projectId: terminal.projectId)
        workbench.showsTerminalPage = false
        shown = true
    }

    func select(_ id: String?, projectId: String) {
        selections[projectId] = id
        guard projectId == workbench?.currentProjectId else { return }
        automatic = false
        focusRequest += 1
    }

    func showAgentTerminal(_ session: Session, automatically: Bool = false) {
        guard let workbench, !workbench.quickChatContext, !workbench.showingHome, workbench.page == nil, workbench.selected?.id == session.id, let id = session.terminalId else { return }
        // A background attention event must not replace a shell the reader is using.
        if automatically && (shown || workbench.showsTerminalPage) { return }
        focus = nil
        selections[session.projectId] = id
        automatic = automatically
        if !automatically { focusRequest += 1 }
        workbench.showsTerminalPage = false
        shown = true
    }

    func hide() {
        navigationRevision += 1
        // Every switch hides the dock; writing only what changes leaves its readers alone.
        if shown { shown = false }
        if automatic { automatic = false }
        if focus != nil { focus = nil }
    }

    func toggle() {
        guard workbench?.quickChatContext != true, workbench?.assistantContext != true else { return }
        if shown && workbench?.showsTerminalPage == false {
            hide()
            NotificationCenter.default.post(name: .riffetFocusComposer, object: workbench)
        } else {
            Task { await openShell() }
        }
    }
}
