import SwiftUI
import RiffetKit

// The Git panel is English in every language, so none of its text goes through the string catalog.
func gitText(_ text: String) -> String { text }

func gitFiles(_ count: Int) -> String { count == 1 ? "1 file" : "\(count) files" }

/// The server's refusals the panel words itself; anything else keeps the server's own message.
func gitMessage(_ error: Error) -> String {
    if let failure = error as? InspectorFailure, case .disconnected = failure { return "Not connected" }
    switch error.riffetCode {
    case "GIT_SWITCH_BLOCKED": return "Uncommitted changes would be overwritten. Commit or discard them first."
    case "GIT_PULL_DIVERGED": return "Local and remote both have new commits. Merge or rebase first."
    default: return error.riffetMessage
    }
}

func gitLetter(_ code: String) -> String {
    switch code {
    case "?": "U"
    case " ", "": "M"
    default: code
    }
}

func gitLetterColor(_ letter: String) -> Color {
    switch letter {
    case "A", "U": .green
    case "D": .red
    case "R": .blue
    default: .orange
    }
}

func gitRelative(_ value: String) -> String {
    guard let date = ServerTime.date(value) else { return "" }
    return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated).locale(Locale(identifier: "en")))
}

struct GitNotice {
    let id = UUID()
    let text: String
    var backup: Checkpoint?
}

struct PendingDiscard {
    let paths: [String]
    let scope: String
}

/// What the Git panel shows about one project, shared by its tabs and the pages pushed from them.
@MainActor @Observable
final class GitPanelModel {
    let workbench: Workbench
    let project: Project
    private(set) var status: GitStatus?
    private(set) var branch: BranchInfo?
    private(set) var statusError: String?
    var error: String?
    var notice: GitNotice?
    var pending: PendingDiscard?
    private(set) var busy = false
    /// Bumped by every write and refresh, so pages showing what it changed read it again.
    private(set) var revision = 0

    init(workbench: Workbench, project: Project) {
        self.workbench = workbench
        self.project = project
    }

    /// The conversation this panel was opened from, when it belongs to this project.
    var sessionID: String? { workbench.selected?.projectId == project.id ? workbench.selected?.id : nil }

    func api() throws -> RiffetApi {
        guard let api = workbench.api else { throw InspectorFailure.disconnected }
        return api
    }

    func reload() async {
        revision += 1
        do {
            status = try await api().gitStatus(projectId: project.id, fresh: true)
            statusError = nil
            await reloadBranch()
        } catch { if status == nil { statusError = error.riffetMessage } else { self.error = gitMessage(error) } }
    }

    func reloadBranch() async {
        branch = try? await api().gitBranch(projectId: project.id)
    }

    /// Follows the server's status stream while the panel is on screen; the manual refresh covers the rest.
    func watch() async {
        await reload()
        guard let api = try? api() else { return }
        do {
            for try await next in api.gitStatusStream(projectId: project.id) {
                let moved = next.branch != status?.branch
                status = next
                statusError = nil
                if moved || branch == nil { await reloadBranch() }
            }
        } catch {}
    }

    /// Runs one write; the panel takes one at a time.
    @discardableResult
    func run(_ work: (RiffetApi) async throws -> Void) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            try await work(try api())
            error = nil
            return true
        } catch {
            self.error = gitMessage(error)
            return false
        }
    }

    func stage(_ paths: [String], on: Bool) async {
        await run { api in
            if on { try await api.stage(projectId: project.id, paths: paths) }
            else { try await api.unstage(projectId: project.id, paths: paths) }
        }
        await reload()
    }

    func commit(_ message: String) async -> Bool {
        let done = await run { try await $0.commit(projectId: project.id, message: message) }
        if done { notice = GitNotice(text: "Committed"); await reload() }
        return done
    }

    func pull() async {
        let done = await run { api in
            let result = try await api.gitPull(projectId: project.id)
            status = result.status
            branch = result.branch
        }
        if done { notice = nil }
    }

    /// `scope` names the screen that asked, so only that screen asks to confirm a discard that cannot be backed up.
    func discard(_ paths: [String], scope: String, permanent: Bool = false) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await api().gitDiscard(projectId: project.id, paths: paths, permanent: permanent)
            discarded(result)
        } catch {
            if error.riffetCode == "DISCARD_UNRECOVERABLE" && !permanent { pending = PendingDiscard(paths: paths, scope: scope) }
            else { self.error = gitMessage(error) }
        }
    }

    func discarded(_ result: GitDiscardResult) {
        revision += 1
        status = result.status
        error = nil
        notice = GitNotice(text: "Discarded", backup: result.backup)
    }

    /// Stages, unstages or discards one run of lines. False when the file changed under the diff.
    func lines(path: String, action: String, change: GitLineChange, version: String) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            let result = try await api().gitLines(projectId: project.id, path: path, action: action, changes: [change], version: version, base: nil)
            revision += 1
            if action == "discard" { discarded(result) } else { status = result.status; error = nil }
            return true
        } catch {
            if error.riffetCode == "GIT_DIFF_STALE" { notice = GitNotice(text: "File changed, reloaded") }
            else { self.error = gitMessage(error) }
            return false
        }
    }

    func undo(_ backup: Checkpoint) async {
        let done = await run { api in
            try await api.restoreCheckpoint(projectId: project.id, checkpointId: backup.id, expectedChanges: try await api.checkpointChanges(projectId: project.id, checkpointId: backup.id))
        }
        if done { notice = GitNotice(text: "Restored"); await reload() }
    }
}

/// The notice bar and the confirmation that a discard cannot be undone, for the screen named `scope`.
private struct GitPanelChrome: ViewModifier {
    let model: GitPanelModel
    let scope: String
    let showNotice: Bool

    private var title: String {
        let name = ((model.pending?.paths.first ?? "") as NSString).lastPathComponent
        return "Discard \"\(name)\"?"
    }

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom) {
                if showNotice, let notice = model.notice {
                    HStack {
                        Text(notice.text)
                        Spacer()
                        if let backup = notice.backup { Button(gitText("Undo")) { Task { await model.undo(backup) } } }
                    }
                    .font(.callout).padding().frame(maxWidth: .infinity).background(.bar)
                    .task(id: notice.id) {
                        try? await Task.sleep(for: .seconds(6))
                        if !Task.isCancelled, model.notice?.id == notice.id { model.notice = nil }
                    }
                }
            }
            .confirmationDialog(
                title,
                isPresented: Binding(get: { model.pending?.scope == scope }, set: { if !$0, model.pending?.scope == scope { model.pending = nil } }),
                titleVisibility: .visible
            ) {
                Button(gitText("Discard"), role: .destructive) {
                    guard let pending = model.pending else { return }
                    model.pending = nil
                    Task { await model.discard(pending.paths, scope: scope, permanent: true) }
                }
            } message: {
                Text(gitText("This file can't be backed up first, so this can't be undone."))
            }
    }
}

extension View {
    func gitPanelChrome(_ model: GitPanelModel, scope: String, notice: Bool = true) -> some View { modifier(GitPanelChrome(model: model, scope: scope, showNotice: notice)) }
}
