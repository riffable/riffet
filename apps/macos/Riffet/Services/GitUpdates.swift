import AppKit
import Foundation
import Observation
import Darwin

/// The identity of this executable is frozen at build time; a later checkout cannot change it.
struct AppBuildRecord: Decodable, Sendable {
    struct Identity: Decodable, Sendable {
        let version: String
        let buildNumber: Int
        let tag: String?
        let commit: String?
        let dirty: Bool
    }
    let build: Identity
    let sourceRoot: String
    let buildConfiguration: String?

    static let bundled: AppBuildRecord? = {
        guard let url = Bundle.main.url(forResource: "RiffetBuildInfo", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }()
}

/// Git is queried directly on this Mac, independently of the connected server and Sparkle feed.
@MainActor @Observable
final class GitUpdates {
    let record = AppBuildRecord.bundled
    private(set) var checking = false
    private(set) var message = ""
    private(set) var latestTag: String?
    private(set) var sourceRoot: String?
    private(set) var sourceValidated = false

    /// A public build records an empty source root: it has no checkout to update from.
    private var bundledSourceRoot: String? {
        guard let root = record?.sourceRoot, !root.isEmpty else { return nil }
        return root
    }
    private var preferenceKey: String { "riffet.update.sourceRoot.\(bundledSourceRoot ?? "unknown")" }

    init() {
        sourceRoot = UserDefaults.standard.string(forKey: "riffet.update.sourceRoot.\(bundledSourceRoot ?? "unknown")")
            ?? bundledSourceRoot
    }

    var currentLabel: String {
        guard let build = record?.build else { return String(localized: "未记录发布版本") }
        let commit = build.commit.map { String($0.prefix(12)) } ?? String(localized: "未记录 commit")
        return String(localized: "\(GitReleaseCheck.releaseTag(build) ?? String(localized: "开发构建")) · \(commit)\(build.dirty ? String(localized: " · 源码有修改") : "")")
    }

    var updateCommand: String? {
        guard sourceValidated, let sourceRoot else { return nil }
        let path = "'" + sourceRoot.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let configuration = record?.buildConfiguration
        let option = configuration == "Debug" || configuration == "Release" ? " --configuration \(configuration!)" : ""
        return "cd \(path) && node scripts/riffet.mjs update --app\(option)"
    }

    func check() async {
        guard !checking else { return }
        guard let sourceRoot else {
            message = String(localized: "未记录源 clone，请选择 Riffet 仓库。")
            return
        }
        checking = true
        latestTag = nil
        sourceValidated = false
        message = String(localized: "正在查询 origin 的发布 tag…")
        defer { checking = false }
        let identity = record?.build
        do {
            let result = try await Task.detached(priority: .utility) {
                try GitReleaseCheck.check(sourceRoot: sourceRoot, current: identity)
            }.value
            self.sourceRoot = result.sourceRoot
            sourceValidated = true
            latestTag = result.latest
            message = result.message
        } catch {
            message = error.localizedDescription
        }
    }

    func chooseSource() async {
        guard !checking else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "选择 Riffet clone")
        guard await panel.begin() == .OK, let url = panel.url else { return }
        checking = true
        defer { checking = false }
        do {
            let path = try await Task.detached(priority: .utility) {
                try GitReleaseCheck.validateSource(url.path)
            }.value
            sourceRoot = path
            sourceValidated = true
            latestTag = nil
            UserDefaults.standard.set(path, forKey: preferenceKey)
            message = String(localized: "源 clone 已关联。")
        } catch {
            message = error.localizedDescription
        }
    }
}

// No shell, no inherited credential prompts, bounded output and a deadline. Existing ServerHost.run
// combines pipes and waits for termination before draining, so it cannot bound ls-remote safely.
enum GitReleaseCheck {
    struct Result: Sendable {
        /// What the check concluded, separate from the wording shown to the reader.
        enum Status: Sendable {
            case updateAvailable, upToDate, ahead, noRelease, developmentBuild, tagConflict
        }
        let sourceRoot: String
        let latest: String?
        let message: String
        let status: Status
    }
    struct Failure: LocalizedError {
        let detail: String
        var errorDescription: String? { detail }
    }

    struct Version: Comparable {
        let parts: [Substring]
        init?(_ tag: String) {
            guard tag.first == "v" else { return nil }
            let parts = tag.dropFirst().split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 3, parts.allSatisfy({ part in
                !part.isEmpty && (part == "0" || part.first != "0") && part.utf8.allSatisfy { (48...57).contains($0) }
            }) else { return nil }
            self.parts = parts
        }
        static func < (lhs: Self, rhs: Self) -> Bool {
            for (a, b) in zip(lhs.parts, rhs.parts) where a != b {
                return a.count == b.count ? a.lexicographicallyPrecedes(b) : a.count < b.count
            }
            return false
        }
    }

    static func validateSource(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
        guard let data = try? Data(contentsOf: root.appendingPathComponent("package.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["name"] as? String == "riffet",
              FileManager.default.fileExists(atPath: root.appendingPathComponent("scripts/riffet.mjs").path) else {
            throw Failure(detail: String(localized: "源 clone 路径失效或不是 Riffet 仓库，请重新选择。"))
        }
        let top = try git(root.path, ["rev-parse", "--show-toplevel"]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard URL(fileURLWithPath: top).resolvingSymlinksInPath().standardizedFileURL == root else {
            throw Failure(detail: String(localized: "请选择 Riffet Git 仓库的根目录。"))
        }
        return root.path
    }

    static func check(sourceRoot: String, current: AppBuildRecord.Identity?) throws -> Result {
        let root = try validateSource(sourceRoot)
        _ = try git(root, ["config", "--get", "remote.origin.url"])
        let output = try git(root, ["ls-remote", "--tags", "origin", "refs/tags/v*"])
        let remote = try references(output)
        let local = try references(git(root, ["show-ref", "--tags", "-d"], allowMissing: true))
        let latest = remote.keys.max { Version($0)! < Version($1)! }
        // All immutable published tags matter, including an annotated tag whose message changed.
        for (tag, release) in remote {
            if let existing = local[tag], existing.objectID != release.objectID || existing.commit != release.commit {
                return Result(sourceRoot: root, latest: latest, message: String(localized: "发布 tag \(tag) 与本地记录冲突，已停止更新判断。请在终端核查，勿覆盖发布 tag。"), status: .tagConflict)
            }
            if releaseTag(current) == tag, let commit = current?.commit, commit != release.commit {
                return Result(sourceRoot: root, latest: latest, message: String(localized: "当前发布 tag \(tag) 已指向不同 commit，已停止更新判断。请在终端核查。"), status: .tagConflict)
            }
        }
        guard let latest else { return Result(sourceRoot: root, latest: nil, message: String(localized: "origin 尚无稳定发布 tag（vX.Y.Z）。"), status: .noRelease) }
        guard let current, let tag = releaseTag(current), let version = Version(tag),
              let commit = current.commit else {
            return Result(sourceRoot: root, latest: latest, message: String(localized: "当前为开发构建或未记录发布 tag；最新发布为 \(latest)。请在终端处理源码后重新构建。"), status: .developmentBuild)
        }
        let detail: String
        let status: Result.Status
        if version < Version(latest)! {
            detail = String(localized: "可更新到 \(latest)。更新前停止此 clone 的服务器并退出 App，然后在终端执行更新命令。")
            status = .updateAvailable
        }
        else if version > Version(latest)! {
            detail = String(localized: "当前版本高于 origin 的最新发布 \(latest)，无需降级。")
            status = .ahead
        }
        else {
            detail = String(localized: "当前 App 已是最新发布版本 \(latest)。")
            status = .upToDate
        }
        let head = try git(root, ["rev-parse", "--verify", "HEAD^{commit}"])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceNote = head == commit ? "" : String(localized: " 本地源码 commit 为 \(head.prefix(12))，与当前 App 不同；重新构建、安装后才会生效。")
        return Result(sourceRoot: root, latest: latest, message: detail + sourceNote, status: status)
    }

    private static func objectID(_ value: String) -> Bool {
        [40, 64].contains(value.count) && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func references(_ output: String) throws -> [String: (objectID: String, commit: String)] {
        var objects: [String: String] = [:]
        var peeled: [String: String] = [:]
        for line in output.split(separator: "\n") {
            let fields = line.split(whereSeparator: { $0 == "\t" || $0 == " " })
            guard fields.count == 2, objectID(String(fields[0])), fields[1].hasPrefix("refs/tags/") else {
                throw Failure(detail: String(localized: "Git 返回了无效的 tag 记录，请在终端检查。"))
            }
            var tag = String(fields[1].dropFirst("refs/tags/".count))
            let isPeeled = tag.hasSuffix("^{}")
            if isPeeled { tag.removeLast(3) }
            guard Version(tag) != nil else { continue }
            let id = String(fields[0])
            if let existing = isPeeled ? peeled[tag] : objects[tag], existing != id {
                throw Failure(detail: String(localized: "Git 返回了相互冲突的发布 tag 记录，已停止更新判断。"))
            }
            if isPeeled { peeled[tag] = id } else { objects[tag] = id }
        }
        guard peeled.keys.allSatisfy({ objects[$0] != nil }) else {
            throw Failure(detail: String(localized: "Git 返回的 annotated tag 缺少 tag 对象，已停止更新判断。"))
        }
        return Dictionary(uniqueKeysWithValues: objects.map { (tag, id) in
            (tag, (objectID: id, commit: peeled[tag] ?? id))
        })
    }

    static func releaseTag(_ identity: AppBuildRecord.Identity?) -> String? {
        guard let identity, !identity.dirty, let tag = identity.tag, Version(tag) != nil,
              tag == "v" + identity.version, let commit = identity.commit,
              objectID(commit) else { return nil }
        return tag
    }

    static func git(_ root: String, _ arguments: [String], allowMissing: Bool = false) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", root] + arguments
        var environment = ProcessInfo.processInfo.environment
        // Always use the selected clone, even when the App inherited an agent/terminal Git context.
        for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"] {
            environment.removeValue(forKey: key)
        }
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        environment["GIT_TERMINAL_PROMPT"] = "0"
        environment["GCM_INTERACTIVE"] = "Never"
        environment["GIT_ASKPASS"] = "/usr/bin/false"
        environment["SSH_ASKPASS"] = "/usr/bin/false"
        environment["SSH_ASKPASS_REQUIRE"] = "never"
        if environment["GIT_SSH_COMMAND"] == nil && environment["GIT_SSH"] == nil {
            environment["GIT_SSH_COMMAND"] = "/usr/bin/ssh -oBatchMode=yes -oConnectTimeout=10"
        }
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice // Remote URLs can contain credentials.
        let pipe = Pipe()
        process.standardOutput = pipe
        do { try process.run() } catch { throw Failure(detail: String(localized: "无法启动 Git，请确认已安装命令行工具。")) }
        let handle = pipe.fileHandleForReading
        let fd = handle.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        defer { try? handle.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        let deadline = Date().addingTimeInterval(25)
        var failure: String?
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                read(fd, bytes.baseAddress, bytes.count)
            }
            if count > 0 {
                result.append(contentsOf: buffer.prefix(count))
                if result.count > 2 * 1024 * 1024 { failure = String(localized: "Git 返回的 tag 列表过大，请在终端检查。"); break }
            } else if count == 0 { break }
            else if errno != EAGAIN && errno != EINTR { failure = String(localized: "无法读取 Git 检查结果。"); break }
            if Date() >= deadline { failure = String(localized: "检查超时，请在终端确认 origin 网络及 Git 认证。"); break }
            if count < 0 { usleep(10_000) }
        }
        // A child may close stdout without exiting; still honor the deadline.
        while failure == nil && process.isRunning {
            if Date() >= deadline { failure = String(localized: "检查超时，请在终端确认 origin 网络及 Git 认证。"); break }
            usleep(10_000)
        }
        if let failure {
            if process.isRunning { process.terminate(); usleep(50_000) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw Failure(detail: failure)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 || (allowMissing && process.terminationStatus == 1 && result.isEmpty) else {
            throw Failure(detail: String(localized: "无法检查更新（Git 退出码 \(process.terminationStatus)）。请在终端确认 origin 配置、网络和 Git 认证。"))
        }
        return String(decoding: result, as: UTF8.self)
    }
}
