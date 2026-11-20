import AppIntents
import AppKit
import CoreSpotlight
import Sparkle
import UniformTypeIdentifiers
import RiffetKit

/// `riffet://session/<id>` opens a conversation; `riffet://new?prompt=…&project=…` starts one
/// (or prefills the app's quick-chat page when no project is named). A link that arrives before the
/// workbench exists (a cold launch from it) waits for it, see `AppModel.whenReady`.
@MainActor
enum URLRouter {
    static func handle(_ url: URL) {
        guard url.scheme == "riffet" else { return }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        // A repeated key keeps its first value: a hand-written link must not crash the app.
        let query = Dictionary((components?.queryItems ?? []).compactMap { item in item.value.map { (item.name, $0) } }, uniquingKeysWith: { first, _ in first })
        switch url.host() {
        case "session":
            let id = url.pathComponents.dropFirst().first ?? ""
            WindowRouter.shared.showMain()
            AppModel.shared.whenReady { workbench in
                workbench.open(sessionId: id)
                if let path = query["path"], !path.isEmpty {
                    workbench.preview(path: path, line: query["line"].flatMap(Int.init))
                } else if query["panel"] == "terminal" {
                    // Existing session links now reveal the bottom dock, not an inspector tab.
                    workbench.terminalDock.automatic = false
                    workbench.terminalDock.shown = true
                } else if let panel = query["panel"] {
                    // The panel state is per conversation; a plugin view waits for what it depends on.
                    workbench.showPanel(panel, session: id)
                }
            }
        case "home":
            WindowRouter.shared.showMain()
            AppModel.shared.whenReady { $0.showHome(projectId: query["project"]) }
        case "settings":
            if let section = query["section"], SettingsSection(rawValue: section) != nil {
                UserDefaults.standard.set(section, forKey: PreferenceKey.settingsSection)
            }
            WindowRouter.shared.showSettings()
        case "stats":
            WindowRouter.shared.showMain()
            AppModel.shared.whenReady { $0.showingStats = true }
        case "plugins":
            // `riffet://plugins/install?id=&version=&source=` from the plugin market: the page asks before anything is installed.
            WindowRouter.shared.showMain()
            AppModel.shared.whenReady { workbench in
                workbench.page = .plugins
                guard url.pathComponents.dropFirst().first == "install", let id = query["id"], !id.isEmpty else { return }
                Task { await workbench.pageModels.plugins.requestMarketInstall(id: id, version: query["version"].flatMap { $0.isEmpty ? nil : $0 }, source: query["source"].flatMap { $0.isEmpty ? nil : $0 }) }
            }
        case "tasks", "extensions", "marks":
            let page = WorkbenchPage(rawValue: url.host() ?? "") ?? .extensions
            WindowRouter.shared.showMain()
            AppModel.shared.whenReady { $0.page = page }
        case "perf":
            // Any web page can open a link; these drive the window and write files, so they answer
            // only once turned on from this machine (`scripts/perf-bench.sh` does it).
            guard UserDefaults.standard.bool(forKey: PerfMonitor.linksKey) else { break }
            switch url.pathComponents.dropFirst().first ?? "" {
            case "bench":
                Task { await PerfBenchmark.shared.run(sessionId: query["session"]) }
            case "switch":
                if let session = query["session"] { Task { await PerfBenchmark.shared.switchBench(sessionId: session, other: query["other"]) } }
            case "pages":
                Task { await PerfBenchmark.shared.pages(sessionId: query["session"]) }
            case "inspector":
                Task { await PerfBenchmark.shared.inspector(sessionId: query["session"]) }
            case "cold":
                if let session = query["session"] { Task { await PerfBenchmark.shared.cold(sessionId: session, other: query["other"]) } }
            case "sidebar":
                Task { await PerfBenchmark.shared.toggleSidebar() }
            case "lists":
                Task { await PerfBenchmark.shared.scrollLists() }
            case "settings":
                Task { await PerfBenchmark.shared.settings() }
            case "dump":
                try? (TranscriptController.active(in: NSApp.keyWindow ?? NSApp.mainWindow)?.debugDump() ?? "none").write(toFile: "/tmp/transcript-dump.txt", atomically: true, encoding: .utf8)
            case "preview":
                if let path = query["path"] { Task { await PerfBenchmark.shared.preview(path: path, sessionId: query["session"]) } }
            case "hud":
                PerfHUD.shared.setVisible(query["on"] != "0")
            case "enable":
                PerfMonitor.shared.setEnabled(query["on"] != "0")
            case "reset":
                PerfMonitor.shared.reset()
            case "report":
                PerfMonitor.write(PerfMonitor.shared.report(), name: "report")
            case "toggle":
                if let index = Int(query["index"] ?? "0"), index >= 0 { _ = TranscriptBench.current?.benchToggle(index) }
            case "snapshot":
                // Only a file name, and only inside the perf folder: a link must not write anywhere else.
                let name = (query["name"] ?? "window").replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "", options: .regularExpression)
                PerfMonitor.snapshot(name: name.isEmpty ? "window" : name, settings: query["window"] == "settings")
            default:
                break
            }
        case "new":
            let prompt = sharedPrompt(query)
            guard let name = query["project"] else {
                QuickPrompt.show(prefill: prompt)
                break
            }
            AppModel.shared.whenReady { workbench in
                if let project = workbench.projects.first(where: { $0.name == name || $0.cwd == name || $0.id == name }) {
                    WindowRouter.shared.showMain()
                    workbench.showHome(projectId: project.id)
                    UserDefaults.standard.set(prompt, forKey: "riffet.draft.home")
                } else {
                    QuickPrompt.show(prefill: prompt)
                }
            }
        default:
            WindowRouter.shared.showMain()
        }
    }

    /// Rebuilds the share extension's prompt. Its payload keeps content and structure separate
    /// (`prompt`, `links`, `files`, `truncated`), so the labels shown around them are localized here,
    /// in the app's own language, instead of being frozen into the link by the extension.
    private static func sharedPrompt(_ query: [String: String]) -> String {
        var prompt = query["prompt"] ?? ""
        if query["truncated"] == "1" { prompt += String(localized: "…（已截断）") }
        if let links = query["links"], !links.isEmpty {
            prompt += (prompt.isEmpty ? "" : "\n\n") + links
        }
        if let raw = query["files"], let data = raw.data(using: .utf8),
           let files = try? JSONDecoder().decode([String].self, from: data), !files.isEmpty {
            let list = files.map { "- \($0)" }.joined(separator: "\n")
            prompt += (prompt.isEmpty ? "" : "\n\n") + String(localized: "相关文件：\n") + list
        }
        return prompt
    }
}

/// The Services menu: "发送到 Riffet" for selected text, "在 Riffet 中新建会话" for a folder or file in
/// Finder (also under 快速操作); a file stands for the folder it sits in.
final class ServicesProvider: NSObject {
    @objc func sendToRiffet(_ pasteboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        guard let text = pasteboard.string(forType: .string), !text.isEmpty else { return }
        MainActor.assumeIsolated { QuickPrompt.show(prefill: text) }
    }

    @objc func newSessionInRiffet(_ pasteboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        guard let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
              let first = urls.first else { return }
        let folder = (try? first.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true ? first : first.deletingLastPathComponent()
        MainActor.assumeIsolated {
            WindowRouter.shared.showMain()
            AppModel.shared.whenReady { workbench in
                Task {
                    if let project = try? await workbench.openDirectory(folder.path) { workbench.showHome(projectId: project.id) }
                }
            }
        }
    }
}

/// Sparkle, started only when the build names a feed and a public key; a local build has neither.
@MainActor
final class Updater {
    static let shared = Updater()
    private static let betaKey = "receiveBetaUpdates"
    private var controller: SPUStandardUpdaterController?
    /// SPUStandardUpdaterController holds its delegate weakly.
    private let channels = UpdateChannels()

    var available: Bool { controller != nil }

    var receivesBeta: Bool {
        get { UserDefaults.standard.bool(forKey: Self.betaKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.betaKey) }
    }

    func start() {
        let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String ?? ""
        let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
        guard !feed.isEmpty, !key.isEmpty else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: channels, userDriverDelegate: nil)
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }

    /// A prerelease build (`0.8.0-beta.1`) stays on the beta channel whatever the preference says.
    fileprivate static var wantsBeta: Bool {
        if UserDefaults.standard.bool(forKey: betaKey) { return true }
        return AppBuildRecord.bundled?.build.version.contains("-") == true
    }
}

private final class UpdateChannels: NSObject, SPUUpdaterDelegate {
    func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        Updater.wantsBeta ? ["beta"] : []
    }
}

/// Conversations in system search: title, project, tags and model, opening the conversation when
/// chosen. The session list carries no first message or summary, and an index must not cost a request.
@MainActor
enum SpotlightIndex {
    private static var indexed: [String: String] = [:]
    private static var pending: (sessions: [Session], projects: [Project])?
    private static let domain = "io.github.riffable.sessions"

    /// Forgets everything indexed: the server was left, forgotten or replaced, and its conversations
    /// must not stay searchable.
    static func clear() {
        indexed = [:]
        pending = nil
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain])
    }

    /// Indexes at most every few seconds: the list changes on every frame of a running turn.
    static func schedule(sessions: [Session], projects: [Project]) {
        let idle = pending == nil
        pending = (sessions, projects)
        guard idle else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + (indexed.isEmpty ? 1 : 5)) {
            MainActor.assumeIsolated {
                guard let next = pending else { return }
                pending = nil
                update(sessions: next.sessions, projects: next.projects)
            }
        }
    }

    static func update(sessions: [Session], projects: [Project]) {
        let names = Dictionary(projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        var items: [CSSearchableItem] = []
        var current: [String: String] = [:]
        for session in sessions where session.archivedAt == nil {
            let signature = "\(session.shownTitle)|\(session.updatedAt)|\(names[session.projectId] ?? "")|\(session.tags.joined(separator: ","))"
            current[session.id] = signature
            guard indexed[session.id] != signature else { continue }
            let attributes = CSSearchableItemAttributeSet(contentType: .text)
            attributes.title = session.shownTitle.ifEmpty(String(localized: "Riffet 会话"))
            let project = names[session.projectId]
            attributes.contentDescription = ["Riffet", project, session.model].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            attributes.textContent = ([session.shownTitle] + [project].compactMap { $0 } + session.tags).filter { !$0.isEmpty }.joined(separator: "\n")
            attributes.keywords = session.tags + [project].compactMap { $0 }
            attributes.lastUsedDate = ServerTime.date(session.lastActivityAt ?? session.createdAt)
            items.append(CSSearchableItem(uniqueIdentifier: session.id, domainIdentifier: domain, attributeSet: attributes))
        }
        let removed = Set(indexed.keys).subtracting(current.keys)
        indexed = current
        if !items.isEmpty { CSSearchableIndex.default().indexSearchableItems(items) }
        if !removed.isEmpty { CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: Array(removed)) }
    }
}

// MARK: App Intents

/// What an intent needs from the app. A shortcut can run before the window has connected (it may
/// even be what launched the app), so it waits for the workbench, and fails only after the wait.
@MainActor
enum IntentContext {
    static func workbench(timeout: Duration = .seconds(15)) async throws -> Workbench {
        guard let workbench = await AppModel.shared.readyWorkbench(timeout: timeout) else {
            throw LocalPairing.Failure(message: String(localized: "Riffet 还没有连接服务器，请打开 Riffet 确认本机服务器在运行"))
        }
        return workbench
    }
}

struct ProjectEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "项目")
    static let defaultQuery = ProjectQuery()

    let id: String
    let name: String
    let path: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(path)")
    }
}

struct ProjectQuery: EntityStringQuery {
    @MainActor
    private func all() async -> [ProjectEntity] {
        guard let workbench = try? await IntentContext.workbench(timeout: .seconds(5)) else { return [] }
        return workbench.projects.map { ProjectEntity(id: $0.id, name: $0.name, path: $0.cwd) }
    }

    func entities(for identifiers: [String]) async throws -> [ProjectEntity] {
        await all().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [ProjectEntity] {
        await all().filter { $0.name.localizedCaseInsensitiveContains(string) || $0.path.localizedCaseInsensitiveContains(string) }
    }

    func suggestedEntities() async throws -> [ProjectEntity] {
        await all()
    }
}

struct SessionEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "会话")
    static let defaultQuery = SessionQuery()

    let id: String
    let title: String
    let project: String

    var displayRepresentation: DisplayRepresentation {
        if project.isEmpty { return DisplayRepresentation(title: "\(title)") }
        return DisplayRepresentation(title: "\(title)", subtitle: "\(project)")
    }
}

struct SessionQuery: EntityStringQuery {
    /// Open conversations, the most recently active first.
    @MainActor
    private func recent() async -> [SessionEntity] {
        guard let workbench = try? await IntentContext.workbench(timeout: .seconds(5)) else { return [] }
        func activity(_ session: Session) -> Date { ServerTime.date(session.lastActivityAt ?? session.createdAt) ?? .distantPast }
        let open = workbench.list.sessions.filter { $0.archivedAt == nil }
        return open.sorted { activity($0) > activity($1) }
            .map { SessionEntity(id: $0.id, title: $0.shownTitle.ifEmpty(String(localized: "新会话")), project: workbench.project($0.projectId)?.name ?? "") }
    }

    func entities(for identifiers: [String]) async throws -> [SessionEntity] {
        await recent().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [SessionEntity] {
        await recent().filter { $0.title.localizedCaseInsensitiveContains(string) || $0.project.localizedCaseInsensitiveContains(string) }
    }

    func suggestedEntities() async throws -> [SessionEntity] {
        let sessions = await recent()
        return Array(sessions.prefix(15))
    }
}

struct NewSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "新建 Riffet 会话"
    static let description = IntentDescription("在指定项目中用默认的 Agent 开始一个会话。")
    static let openAppWhenRun = false

    @Parameter(title: "提示词") var prompt: String
    @Parameter(title: "项目", description: "留空使用最近的项目") var project: ProjectEntity?

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let workbench = try await IntentContext.workbench()
        let target = project.flatMap { workbench.project($0.id) } ?? workbench.project(workbench.recentProjectId) ?? workbench.projects.first
        guard let target else { throw LocalPairing.Failure(message: String(localized: "没有可用的项目")) }
        guard let agent = workbench.newSessionAgent else { throw LocalPairing.Failure(message: String(localized: "没有可用的 Agent")) }
        let defaults = workbench.settings?.defaultsFor(agent: agent)
        let session = try await workbench.createSession(
            projectId: target.id, prompt: prompt, attachments: [], agent: agent,
            profileId: defaults?.profileId, model: defaults?.model, mode: defaults?.mode, approval: defaults?.approval
        )
        return .result(dialog: "已在 \(target.name) 中开始「\(session.shownTitle.ifEmpty(prompt))」")
    }
}

struct OpenSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "打开 Riffet 会话"
    static let description = IntentDescription("在 Riffet 中打开一个会话。")
    static let openAppWhenRun = true

    @Parameter(title: "会话") var session: SessionEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        let workbench = try await IntentContext.workbench()
        WindowRouter.shared.showMain()
        workbench.open(sessionId: session.id)
        return .result()
    }
}

struct RunningSessionsIntent: AppIntent {
    static let title: LocalizedStringResource = "列出运行中的 Riffet 会话"
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<[String]> & ProvidesDialog {
        let sessions = try await IntentContext.workbench().activeSessions
        let titles = sessions.map { String(localized: "\($0.shownTitle.ifEmpty(String(localized: "新会话")))（\($0.state == .waiting ? String(localized: "等待确认") : String(localized: "运行中"))）") }
        return .result(value: titles, dialog: titles.isEmpty ? "没有运行中的会话" : "\(titles.count) 个会话：\(titles.joined(separator: String(localized: "、")))")
    }
}

struct RiffetShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: NewSessionIntent(), phrases: ["用 \(.applicationName) 新建会话", "让 \(.applicationName) 开始一个任务"], shortTitle: "新建会话", systemImageName: "square.and.pencil") // i18n-ignore: App Shortcut phrases use a separate catalog
        AppShortcut(intent: RunningSessionsIntent(), phrases: ["\(.applicationName) 有哪些会话在运行"], shortTitle: "运行中的会话", systemImageName: "play.circle") // i18n-ignore: App Shortcut phrases use a separate catalog
        AppShortcut(intent: OpenSessionIntent(), phrases: ["用 \(.applicationName) 打开会话"], shortTitle: "打开会话", systemImageName: "bubble.left.and.text.bubble.right") // i18n-ignore: App Shortcut phrases use a separate catalog
    }
}
