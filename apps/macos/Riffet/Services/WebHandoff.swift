import AppKit
import SwiftUI
import RiffetKit

/// A page of the connected server's Web (`apps/web/src/app/state/page-url.ts`).
enum WebPage: Equatable {
    case stats, extensions, automations, marks, tasks, council
    case plugins(id: String? = nil)
    /// A settings section by its Web id (`settingsSections.ts`); nil opens the dialog where it was.
    case settings(section: String? = nil)

    var path: String {
        switch self {
        case .stats: "/stats"
        case .extensions: "/extensions"
        case .automations: "/automations"
        case .marks: "/marks"
        case .tasks: "/tasks"
        case .council: "/council"
        case .plugins: "/plugins"
        case .settings(let section): section.map { "/settings/\($0)" } ?? "/settings"
        }
    }

    var query: [URLQueryItem] {
        if case .plugins(let id?) = self { return [URLQueryItem(name: "id", value: id)] }
        return []
    }
}

extension WorkbenchPage {
    /// Where the Web shows what this page shows; nil for a page that is not a management page.
    var webPage: WebPage? {
        switch self {
        case .assistant: nil
        case .stats: .stats
        case .tasks: .automations
        case .extensions: .extensions
        case .plugins: .plugins()
        case .marks: .marks
        // The Web's service status is on the 服务管理 section.
        case .activity: .settings(section: "service")
        }
    }
}

extension SettingsSection {
    /// The Web section that shows this one, for the sections that are server-side management. nil for
    /// the Mac's own preferences and for sections the Web has no counterpart of.
    var webSection: String? {
        switch pane {
        case .profile: "profile"
        case .assistant: "assistant"
        case .workItems: "workitems"
        case .quickChat: "quickchat"
        case .agents: "backends"
        case .modelProviders: "providers"
        case .auxiliaryModels: "auxiliary"
        case .shares: "shares"
        case .channels: "channels"
        case .storage: "storage"
        case .backup: "backup"
        case .diagnostics: "diagnostics"
        default: nil
        }
    }
}

/// A settings section the Web has and the Mac does not: its row opens the Web section.
struct WebSettingsRow: Identifiable {
    let section: String
    let title: String
    let symbol: String
    let group: SettingsGroup
    var id: String { section }

    /// Voice input is a part of the Web's 输入 page.
    @MainActor static var all: [WebSettingsRow] {
        [
            WebSettingsRow(section: "titles", title: String(localized: "标题规则"), symbol: "pencil.line", group: .behavior),
            WebSettingsRow(section: "interaction", title: String(localized: "语音输入"), symbol: "mic", group: .behavior),
        ]
    }
}

/// The one way the Mac sends the reader to the Web: the connected server's page in the system
/// browser, carrying a one-time pairing code in the fragment so a browser that is not signed in
/// signs in (the Web drops the code when it already is). The fragment never reaches the server.
@MainActor
enum WebHandoff {
    /// A server stands behind the workbench: without one there is no address to open.
    static func isAvailable(_ workbench: Workbench) -> Bool {
        workbench.connected && workbench.host.api != nil
    }

    /// How long a click waits for the pairing code before the browser opens without one.
    private static let codeWait: Duration = .seconds(2)

    static func url(for page: WebPage, base: URL, code: String?) -> URL? {
        guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        // A server behind a path prefix keeps it.
        parts.path = (parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path) + page.path
        parts.queryItems = page.query.isEmpty ? nil : page.query
        parts.fragment = code.map { "handoff=\($0)" }
        return parts.url
    }

    static func open(_ page: WebPage, in workbench: Workbench) {
        guard isAvailable(workbench) else { return }
        let base = workbench.baseURL
        let api = workbench.host.api
        Task {
            // Offline, refused or slow: the plain address still lands on the page, where a browser
            // that is not signed in shows the sign-in page.
            let request = Task { try? await api?.pairingCode(name: nil).code }
            let limit = Task { try? await Task.sleep(for: codeWait); request.cancel() }
            let code = await request.value
            limit.cancel()
            guard let url = url(for: page, base: base, code: code) ?? url(for: page, base: base, code: nil) else { return }
            NSWorkspace.shared.open(url)
        }
    }
}

/// 在 Web 中打开: an icon-only action for a page's toolbar, hidden while no server is connected.
struct WebHandoffButton: View {
    let page: WebPage
    let workbench: Workbench

    var body: some View {
        if WebHandoff.isAvailable(workbench) {
            let title = String(localized: "在 Web 中打开")
            if DisplayPreferences.shared.style.backend == .native {
                Button { WebHandoff.open(page, in: workbench) } label: { Label(title, icon: "arrow.up.right.square") }
                    .help(title)
            } else {
                Button { WebHandoff.open(page, in: workbench) } label: { Image(icon: "arrow.up.right.square") }
                    .buttonStyle(IconButtonStyle())
                    .help(title)
                    .accessibilityLabel(title)
            }
        }
    }
}
