import AppKit
import Foundation
import ServiceManagement
import RiffetKit

/// Who keeps the local server running (docs/MACOS.md, "服务托管"). One state directory has exactly
/// one of these; two KeepAlive agents on the same `server.lock` would relaunch each other forever.
enum ServerManager: String, Sendable {
    /// The LaunchAgent inside Riffet.app, registered with SMAppService.
    case app
    /// `riffet install-service`: `~/Library/LaunchAgents/local.riffet.plist`.
    case loginService
    /// A daemon started by `riffet start` in a terminal.
    case cli

    var label: String {
        switch self {
        case .app: "Riffet.app"
        case .loginService: String(localized: "登录服务 local.riffet")
        case .cli: "riffet start"
        }
    }
}

struct DaemonRecord: Decodable, Equatable, Sendable {
    let pid: Int32
    let port: Int
    let host: String
    let instanceId: String?
    let startedAt: String?
    let args: [String]?
}

struct ServerHealth: Decodable, Sendable {
    let ok: Bool
    let version: String?
    let instanceId: String?
    let managedBy: String?
}

struct RunningServer: Equatable, Sendable {
    let baseURL: URL
    let record: DaemonRecord
    let version: String?
    let manager: ServerManager
}

/// One maintenance command the settings screen runs against the local installation (a restart of a
/// daemon started in a terminal, or the server build a restart would pick up). The command's own
/// output is kept verbatim: it is what says whether it worked and what to fix when it did not.
///
/// Observable per field: the output grows chunk by chunk while it runs, and only the sheet showing it
/// reads it, so the settings form behind the sheet is not rebuilt for every chunk.
@Observable
final class ServerMaintenance: Identifiable {
    let id = UUID()
    let title: String
    var output: String
    var running: Bool
    var status: Int32?

    init(title: String, output: String = "", running: Bool = true, status: Int32? = nil) {
        self.title = title
        self.output = output
        self.running = running
        self.status = status
    }
}

enum ServerState: Equatable {
    case checking
    case running(RunningServer)
    case stopped
    case starting
    case failed(String)

    var running: RunningServer? {
        if case let .running(server) = self { server } else { nil }
    }
}

@MainActor
@Observable
final class ServerHost {
    static let agentLabel = (Bundle.main.object(forInfoDictionaryKey: "RiffetServerAgentLabel") as? String) ?? "io.github.riffable.mac.server"

    private(set) var state: ServerState = .checking
    private(set) var appAgentStatus: SMAppService.Status = .notRegistered
    /// A failed start stays in [state] until the server is seen running or another start begins:
    /// the check that follows a failed start would otherwise overwrite it with `.stopped`.
    private var stickyFailure = false

    let stateDirectory: URL = {
        if let custom = ProcessInfo.processInfo.environment["RIFFET_STATE_DIR"], !custom.isEmpty {
            return URL(fileURLWithPath: custom)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/share/riffet")
    }()

    private var appAgent: SMAppService { .agent(plistName: "\(Self.agentLabel).plist") }

    var loginServicePlist: URL { Self.loginServicePlistURL }

    private nonisolated static var loginServicePlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/LaunchAgents/local.riffet.plist")
    }

    /// Whether `local.riffet` is installed, as of the last [refresh]. Views read it on every redraw, so
    /// the file system is checked there (off the main thread) rather than here.
    private(set) var hasLoginService = FileManager.default.fileExists(atPath: ServerHost.loginServicePlistURL.path)

    var logFile: URL { stateDirectory.appending(path: "server.log") }

    /// Whether this build carries a server it can run (Release bundles one; Debug points at the checkout).
    /// The bundle does not change while the App runs.
    let canHostServer = FileManager.default.isExecutableFile(
        atPath: Bundle.main.bundleURL.appending(path: "Contents/Resources/server/riffet-server").path
    )

    /// daemon.json as of the last [refresh]; nil until one has run.
    private var probedRecord: DaemonRecord??

    func refresh() async {
        // `SMAppService.status` is a synchronous XPC call and daemon.json a disk read: neither may
        // hold the main thread, which calls this on activation and every half minute.
        let probe = await Self.probe(stateDirectory: stateDirectory, agentPlist: "\(Self.agentLabel).plist")
        if appAgentStatus != probe.status { appAgentStatus = probe.status }
        if hasLoginService != probe.hasLoginService { hasLoginService = probe.hasLoginService }
        probedRecord = .some(probe.record)
        guard let record = probe.record else {
            keepOrStop()
            return
        }
        let base = URL(string: "http://127.0.0.1:\(record.port)")!
        do {
            let health = try await fetchHealth(base)
            if let expected = record.instanceId, let actual = health.instanceId, expected != actual {
                setState(.failed(String(localized: "daemon.json 与正在运行的服务器不一致，请重启服务器")))
                return
            }
            stickyFailure = false
            setState(.running(RunningServer(baseURL: base, record: record, version: health.version, manager: manager(health))))
        } catch {
            keepOrStop()
        }
    }

    private struct Probe {
        let status: SMAppService.Status
        let hasLoginService: Bool
        let record: DaemonRecord?
    }

    private nonisolated static func probe(stateDirectory: URL, agentPlist: String) async -> Probe {
        await Task.detached(priority: .userInitiated) {
            Probe(
                status: SMAppService.agent(plistName: agentPlist).status,
                hasLoginService: FileManager.default.fileExists(atPath: loginServicePlistURL.path),
                record: readDaemonRecord(in: stateDirectory)
            )
        }.value
    }

    /// An unchanged state is not written: every window observing it would redraw for nothing.
    private func setState(_ next: ServerState) {
        if state != next { state = next }
    }

    private func keepOrStop() {
        if case .starting = state { return }
        if stickyFailure, case .failed = state { return }
        setState(.stopped)
    }

    /// Records why a start did not work, for the screens that offer to retry it.
    func markFailed(_ message: String) {
        stickyFailure = true
        state = .failed(message)
    }

    /// Forgets a recorded start failure, before checking again from scratch.
    func clearFailure() {
        guard stickyFailure else { return }
        stickyFailure = false
        if case .failed = state { state = .stopped }
    }

    /// Polls until the server answers or [timeout] passes.
    @discardableResult
    func waitUntilRunning(timeout: Duration = .seconds(20), since started: Date = .now) async -> RunningServer? {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            await refreshDuringStart()
            if let server = state.running { return server }
            try? await Task.sleep(for: .milliseconds(400))
        }
        if case .starting = state { markFailed(await startFailureReason(since: started, timeout: timeout)) }
        return nil
    }

    private func refreshDuringStart() async {
        let directory = stateDirectory
        guard let record = await Task.detached(priority: .userInitiated, operation: { Self.readDaemonRecord(in: directory) }).value else { return }
        let base = URL(string: "http://127.0.0.1:\(record.port)")!
        if let health = try? await fetchHealth(base) {
            stickyFailure = false
            setState(.running(RunningServer(baseURL: base, record: record, version: health.version, manager: manager(health))))
        }
    }

    // MARK: Management

    /// Registers the App's LaunchAgent. Refuses while `local.riffet` exists: see [ServerManager].
    func startAppManaged() async throws {
        hasLoginService = FileManager.default.fileExists(atPath: loginServicePlist.path)
        if hasLoginService { throw HostError.loginServiceInstalled }
        guard canHostServer else { throw HostError.noBundledServer }
        beginStart()
        let started = Date.now
        logOffset = logSize()
        writeAppServerConfig()
        do {
            try appAgent.register()
        } catch {
            appAgentStatus = appAgent.status
            if appAgentStatus == .requiresApproval {
                failNeedingApproval()
                return
            }
            markFailed(String(localized: "登录项注册失败：\(error.localizedDescription)"))
            throw error
        }
        appAgentStatus = appAgent.status
        // `register()` can succeed while the item is not allowed yet; nothing starts then.
        if appAgentStatus == .requiresApproval {
            failNeedingApproval()
            return
        }
        await waitUntilRunning(since: started)
    }

    private func failNeedingApproval() {
        markFailed(String(localized: "需要在「系统设置 → 通用 → 登录项」中允许 Riffet 后台运行，允许后点「重试」"))
        SMAppService.openSystemSettingsLoginItems()
    }

    /// Removes `local.riffet`, then hands the server to the App.
    func migrateLoginServiceToApp() async throws {
        let domain = "gui/\(getuid())"
        _ = try? await Self.run("/bin/launchctl", ["bootout", domain, loginServicePlist.path])
        try? FileManager.default.removeItem(at: loginServicePlist)
        hasLoginService = FileManager.default.fileExists(atPath: loginServicePlist.path)
        try await startAppManaged()
    }

    func stopAppManaged() async throws {
        stickyFailure = false
        try await appAgent.unregister()
        appAgentStatus = appAgent.status
        try? await Task.sleep(for: .milliseconds(600))
        await refresh()
    }

    func restart() async throws {
        guard let server = state.running else { return }
        let domain = "gui/\(getuid())"
        let started = Date.now
        logOffset = logSize()
        switch server.manager {
        case .app:
            beginStart()
            try await kickstart(["-k", "\(domain)/\(Self.agentLabel)"])
        case .loginService:
            beginStart()
            try await kickstart(["-k", "\(domain)/local.riffet"])
        case .cli:
            throw HostError.cliManaged
        }
        try? await Task.sleep(for: .seconds(1))
        await waitUntilRunning(since: started)
    }

    /// Starts `local.riffet` when it is installed but not running.
    func kickstartLoginService() async throws {
        beginStart()
        let started = Date.now
        logOffset = logSize()
        try await kickstart(["gui/\(getuid())/local.riffet"])
        await waitUntilRunning(since: started)
    }

    /// A refused `launchctl kickstart` is a failed start too, not a state stuck at "starting".
    private func kickstart(_ arguments: [String]) async throws {
        do {
            _ = try await Self.run("/bin/launchctl", ["kickstart"] + arguments)
        } catch {
            markFailed(error.localizedDescription)
            throw error
        }
    }

    private func beginStart() {
        stickyFailure = false
        state = .starting
    }

    /// Stops a `riffet start` daemon the way `riffet stop` does: SIGTERM to the recorded pid.
    func stopCliDaemon() async {
        guard let server = state.running, server.manager == .cli else { return }
        kill(server.record.pid, SIGTERM)
        try? await Task.sleep(for: .seconds(1))
        await refresh()
    }

    // MARK: Maintenance the settings screen runs itself

    /// The command's own output, shown while it runs and after it ends.
    private(set) var maintenance: ServerMaintenance?
    private var maintenanceProcess: Process?
    /// True from the click until the process starts: the shell environment is read off the main
    /// thread first, and dismissing or clicking again in that window must not start a second run.
    private var maintenanceStarting = false

    func dismissMaintenance() {
        guard maintenanceProcess == nil, !maintenanceStarting else { return }
        maintenance = nil
    }

    /// Restarts a daemon this App does not own, the way its own message says to: `riffet restart`
    /// replays the running daemon's arguments, so host, port and auth survive.
    func restartCliDaemon() {
        runMaintenance(title: String(localized: "重启本机服务器"), script: "riffet restart --state-dir \(Self.shellQuoted(stateDirectory.path))")
    }

    /// Rebuilds the server the daemon runs (`dist/`). The running daemon keeps the code it started
    /// with, so a restart is what makes a successful build take effect.
    func buildServer() {
        guard let root = AppBuildRecord.bundled?.sourceRoot, !root.isEmpty else {
            maintenance = ServerMaintenance(title: String(localized: "构建服务器"), output: String(localized: "这个构建没有记录源码目录，无法在 App 内构建。\n"), running: false, status: 1)
            return
        }
        runMaintenance(title: String(localized: "构建服务器"), script: "cd \(Self.shellQuoted(root)) && pnpm build")
    }

    /// Runs through the user's own shell environment. The App inherits launchd's
    /// (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`), so neither a login shell nor the App itself finds
    /// node, pnpm or `riffet` when a version manager installed them: those `PATH` entries live in
    /// `~/.zshrc`, which only an interactive shell reads. The environment is read once per command,
    /// off the main thread, so a fix to the shell config takes effect on the next click.
    private func runMaintenance(title: String, script: String) {
        guard maintenanceProcess == nil, !maintenanceStarting else { return }
        maintenance = ServerMaintenance(title: title)
        maintenanceStarting = true
        Task { [weak self] in
            let environment = await Task.detached(priority: .userInitiated) { UserShell.environment() }.value
            guard let self else { return }
            self.maintenanceStarting = false
            self.startMaintenance(script: script, environment: environment)
        }
    }

    private func startMaintenance(script: String, environment: [String: String]?) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", script]
        // `build.sh` opens the App with its frozen build record in `RIFFET_BUILD_INFO_FILE`. A build started
        // here must record the checkout as it is now, not verify against that pin from the App's launch.
        var environment = environment ?? ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "RIFFET_BUILD_INFO_FILE")
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        maintenanceProcess = process
        do {
            try process.run()
            // One reader queues every output chunk before completion on the same FIFO queue.
            // A termination callback could otherwise mark the command done before its last read.
            // Chunks are handed to the sheet at most ten times a second: a build prints thousands
            // of lines, and each hand-off re-lays out the whole log.
            let output = MaintenanceOutput()
            let flush = { [weak self] in
                let text = output.take()
                guard !text.isEmpty else { return }
                self?.maintenance?.output += text
            }
            DispatchQueue.global(qos: .utility).async {
                var pending: [UInt8] = []
                while true {
                    let data = pipe.fileHandleForReading.availableData
                    pending.append(contentsOf: data)
                    var end = pending.count
                    // Pipe reads may split a UTF-8 scalar. Keep its incomplete suffix until the
                    // next read; at EOF decode everything so even a truncated final byte is shown.
                    if !data.isEmpty, let start = pending.lastIndex(where: { $0 & 0xC0 != 0x80 }) {
                        let lead = pending[start]
                        let length = lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4
                        if (0xC2...0xF4).contains(lead), pending.count - start < length {
                            end = start
                        }
                    }
                    let text = String(decoding: pending[..<end], as: UTF8.self)
                    pending.removeFirst(end)
                    if !text.isEmpty, output.append(text) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { flush() }
                    }
                    if data.isEmpty { break }
                }
                process.waitUntilExit()
                try? pipe.fileHandleForReading.close()
                DispatchQueue.main.async {
                    flush()
                    self.finishMaintenance(status: process.terminationStatus)
                }
            }
        } catch {
            maintenanceProcess = nil
            maintenance?.running = false
            maintenance?.status = 1
            maintenance?.output += String(localized: "无法启动命令：\(error.localizedDescription)\n")
        }
    }

    private func finishMaintenance(status: Int32) {
        maintenanceProcess = nil
        guard let current = maintenance else { return }
        current.running = false
        current.status = status
        // A restart replaces the daemon the App is talking to; a build changes what a restart would
        // start. Either way the recorded state is re-read.
        Task { await refresh() }
    }

    private static func shellQuoted(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    func openLog() {
        // Nothing has been logged yet when the launcher never ran: show the folder instead.
        NSWorkspace.shared.open(FileManager.default.fileExists(atPath: logFile.path) ? logFile : stateDirectory)
    }

    func doctorReport() async -> String {
        guard let server = state.running else { return String(localized: "服务器未运行") }
        var request = URLRequest(url: server.baseURL.appending(path: "api/doctor"))
        guard let token = AppSecrets.shared.read(account: tokenAccount(baseUrl: server.baseURL.absoluteString)), !token.isEmpty else {
            return String(localized: "本机服务器尚未配对，请先连接本机服务器后再读取诊断。")
        }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 8
        guard let (data, response) = try? await URLSession.shared.data(for: request) else { return String(localized: "无法读取诊断信息") }
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            return String(localized: "无法读取诊断信息（HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)），请检查本机服务器连接。")
        }
        if let object = try? JSONSerialization.jsonObject(with: data),
           let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) {
            return String(decoding: pretty, as: UTF8.self)
        }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: Failure diagnosis

    /// Why a start that never answered did not work, read from what is at hand: the login item's
    /// approval, the tail of `server.log` written since the attempt and launchd's last exit code.
    private func startFailureReason(since started: Date, timeout: Duration) async -> String {
        appAgentStatus = appAgent.status
        if appAgentStatus == .requiresApproval {
            return String(localized: "需要在「系统设置 → 通用 → 登录项」中允许 Riffet 后台运行，允许后点「重试」")
        }
        let lines = freshLogLines(since: started)
        if let line = lines.last(where: Self.isFailureLine) {
            let lower = line.lowercased()
            if lower.contains("eaddrinuse") || lower.contains("address already in use") {
                return String(localized: "端口被其他程序占用，服务器无法监听。关闭占用端口的程序，或在终端执行 riffet stop 后重试")
            }
            if lower.contains("already in use by a live server") || lower.contains("already has a running") {
                return String(localized: "数据目录已被另一个 Riffet 服务器占用，先在终端执行 riffet stop 再重试")
            }
            return String(localized: "服务器启动失败：\(line.prefix(180))")
        }
        var reason = String(localized: "服务器没有在 \(Int(timeout.components.seconds)) 秒内启动")
        reason += lines.isEmpty ? String(localized: "，server.log 没有新内容：launchd 可能没能拉起内置的 node") : String(localized: "，查看 server.log 了解原因")
        if let code = await launchdExitCode(), code != 0 { reason += String(localized: "（launchd 记录的退出码 \(code)）") }
        return reason
    }

    private static func isFailureLine(_ line: String) -> Bool {
        let lower = line.lowercased()
        return ["error", "eaddrinuse", "already in use", "cannot", "failed", "enoent", "killed"].contains { lower.contains($0) }
    }

    /// Where `server.log` ended when the current start began; only what follows is this start's.
    private var logOffset: UInt64 = 0

    private func logSize() -> UInt64 {
        ((try? FileManager.default.attributesOfItem(atPath: logFile.path))?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    /// The last lines `server.log` gained since [started] (a rotated, shorter log is read whole).
    private func freshLogLines(since started: Date) -> [String] {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: logFile.path),
              let modified = attributes[.modificationDate] as? Date, modified >= started.addingTimeInterval(-1),
              let handle = try? FileHandle(forReadingFrom: logFile) else { return [] }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let from = size >= logOffset ? logOffset : 0
        try? handle.seek(toOffset: max(from, size > 8192 ? size - 8192 : 0))
        let text = String(decoding: (try? handle.readToEnd()) ?? Data(), as: UTF8.self)
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return Array(lines.suffix(40))
    }

    private func launchdExitCode() async -> Int? {
        guard let output = try? await Self.run("/bin/launchctl", ["print", "gui/\(getuid())/\(Self.agentLabel)"]),
              let range = output.range(of: #"last exit code = \d+"#, options: .regularExpression) else { return nil }
        return Int(output[range].filter(\.isNumber))
    }

    // MARK: Helpers

    /// What the launcher in the bundle reads: the same host, port and auth as the daemon it replaces.
    private func writeAppServerConfig() {
        var host = "127.0.0.1", port = "4337", auth = "0"
        if let args = readDaemonRecord()?.args {
            if let index = args.firstIndex(of: "--host"), index + 1 < args.count { host = args[index + 1] }
            if let index = args.firstIndex(of: "--port"), index + 1 < args.count { port = args[index + 1] }
            if args.contains("--auth") || !["127.0.0.1", "localhost", "::1"].contains(host) { auth = "1" }
        }
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        let workspace = documents.map { $0.appending(path: "Riffet").path }
        let config = "RIFFET_HOST=\(host)\nRIFFET_PORT=\(port)\nRIFFET_AUTH=\(auth)\n"
            + (workspace.map { "export RIFFET_TASK_WORKSPACE_ROOT=\(Self.shellQuoted($0))\n" } ?? "")
        try? FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? config.write(to: stateDirectory.appending(path: "app-server.env"), atomically: true, encoding: .utf8)
    }

    /// The address daemon.json records, before its health is checked: a cold start shows the
    /// cached conversations of a server paired before while the check runs.
    /// Once a [refresh] has read the file, its answer is used: settings read this on every redraw.
    var recordedBaseURL: URL? {
        (probedRecord ?? readDaemonRecord()).flatMap { URL(string: "http://127.0.0.1:\($0.port)") }
    }

    private func readDaemonRecord() -> DaemonRecord? { Self.readDaemonRecord(in: stateDirectory) }

    private nonisolated static func readDaemonRecord(in stateDirectory: URL) -> DaemonRecord? {
        guard let data = try? Data(contentsOf: stateDirectory.appending(path: "daemon.json")) else { return nil }
        return try? JSONDecoder().decode(DaemonRecord.self, from: data)
    }

    private func fetchHealth(_ base: URL) async throws -> ServerHealth {
        var request = URLRequest(url: base.appending(path: "health"))
        request.timeoutInterval = 2
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(ServerHealth.self, from: data)
    }

    private func manager(_ health: ServerHealth) -> ServerManager {
        if let reported = health.managedBy {
            switch reported {
            case "app": return .app
            case "launchd": return .loginService
            case "cli": return .cli
            default: break
            }
        }
        if appAgentStatus == .enabled { return .app }
        return hasLoginService ? .loginService : .cli
    }

    nonisolated static func run(_ executable: String, _ arguments: [String]) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.terminationHandler = { finished in
                let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                if finished.terminationStatus == 0 {
                    continuation.resume(returning: output)
                } else {
                    continuation.resume(throwing: HostError.command(output.trimmingCharacters(in: .whitespacesAndNewlines)))
                }
            }
            do { try process.run() } catch { continuation.resume(throwing: error) }
        }
    }

    enum HostError: LocalizedError {
        case loginServiceInstalled
        case noBundledServer
        case cliManaged
        case command(String)

        var errorDescription: String? {
            switch self {
            case .loginServiceInstalled: String(localized: "已经安装了登录服务 local.riffet；先改由 Riffet.app 托管，避免两个服务争用同一个数据目录")
            case .noBundledServer: String(localized: "这个构建没有内置服务器")
            case .cliManaged: String(localized: "这个服务器由终端里的 riffet start 启动，请在终端执行 riffet restart")
            case let .command(output): output.isEmpty ? String(localized: "命令执行失败") : output
            }
        }
    }
}

/// Output read off the main thread and not yet shown. [append] says whether a hand-off to the main
/// thread has to be scheduled; one already pending will carry the new text too.
private final class MaintenanceOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = ""
    private var scheduled = false

    func append(_ text: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        pending += text
        if scheduled { return false }
        scheduled = true
        return true
    }

    func take() -> String {
        lock.lock()
        defer { lock.unlock() }
        let text = pending
        pending = ""
        scheduled = false
        return text
    }
}

/// The environment the user's own terminal gives a command. A GUI App inherits launchd's minimal
/// environment, so tools installed by a version manager (node, pnpm, the `riffet` CLI) are only on
/// `PATH` after the interactive shell config has been read.
private enum UserShell {
    /// Reads the environment of an interactive login shell: `-i` is what makes zsh read `~/.zshrc`,
    /// where those `PATH` entries live. `/usr/bin/env -0` keeps values containing newlines intact,
    /// and the marker separates the shell's own startup output (oh-my-zsh and plugins print) from it.
    /// A broken config must not hold a maintenance command forever, hence the deadline.
    static func environment(timeout: TimeInterval = 10) -> [String: String]? {
        let marker = "riffet-shell-environment-\(UUID().uuidString)"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-ilc", "print -rn -- \(marker); /usr/bin/env -0"]
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        do { try process.run() } catch { return nil }
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: deadline)
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        deadline.cancel()
        guard process.terminationStatus == 0,
              let range = output.range(of: Data(marker.utf8), options: .backwards) else { return nil }
        var environment: [String: String] = [:]
        for entry in output[range.upperBound...].split(separator: 0, omittingEmptySubsequences: true) {
            guard let separator = entry.firstIndex(of: UInt8(ascii: "=")) else { continue }
            let key = String(decoding: entry[..<separator], as: UTF8.self)
            guard !key.isEmpty else { continue }
            environment[key] = String(decoding: entry[entry.index(after: separator)...], as: UTF8.self)
        }
        return environment.isEmpty ? nil : environment
    }
}
