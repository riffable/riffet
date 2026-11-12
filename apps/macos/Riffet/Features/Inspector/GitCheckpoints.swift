import SwiftUI
import RiffetKit

/// Checkpoint list for the changes panel. Opening one pushes `GitCheckpointDetail`.
struct GitCheckpointsList: View {
    let workbench: Workbench
    let project: Project
    let sessionId: String?
    let refreshToken: Int
    let onOpen: (Checkpoint) -> Void
    @Environment(\.palette) private var palette
    @State private var checkpoints: [Checkpoint]?
    @State private var title = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                GitField(placeholder: "Name (optional)", text: $title) { Task { await create() } }
                Button(GitCopy.save) { Task { await create() } }
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .disabled(busy)
            }
            .padding(Space.md)
            if let error { GitInlineError(message: error) }
            content
        }
        .task(id: project.id) {
            title = ""
            checkpoints = nil
            error = nil
            await load()
        }
        .onChange(of: refreshToken) { _, _ in Task { await load() } }
    }

    @ViewBuilder
    private var content: some View {
        if checkpoints == nil, error == nil {
            Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let checkpoints, !checkpoints.isEmpty {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(checkpoints, id: \.id) { checkpoint in
                        Button { onOpen(checkpoint) } label: { GitCheckpointRow(checkpoint: checkpoint) }
                            .buttonStyle(HoverRowStyle())
                    }
                }
                .padding(Space.xs + 2)
            }
        } else if error == nil {
            ContentUnavailableView(GitCopy.noCheckpoints, icon: "clock.arrow.circlepath")
        } else {
            Spacer(minLength: 0)
        }
    }

    private func load() async {
        guard let api = workbench.host.api else { return }
        do {
            let next = try await api.checkpoints(projectId: project.id)
            if checkpoints != next { checkpoints = next }
            if error != nil { error = nil }
        } catch {
            self.error = "Couldn't read checkpoints: \(gitMessage(error))"
            if checkpoints == nil { checkpoints = [] }
        }
    }

    private func create() async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        error = nil
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let created = try await api.createCheckpoint(projectId: project.id, body: CreateCheckpointRequest(sessionId: sessionId, title: name.isEmpty ? nil : name))
            title = ""
            await load()
            if error == nil, checkpoints?.contains(where: { $0.id == created.id }) != true {
                self.error = "The checkpoint was created but is not in the list. Refresh to check."
            }
        } catch {
            self.error = "Couldn't create the checkpoint: \(gitMessage(error))"
        }
        busy = false
    }
}

struct GitCheckpointRow: View {
    let checkpoint: Checkpoint
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: checkpoint.title)
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Text(checkpointSubtitle(checkpoint))
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg4)
                    .lineLimit(1)
            }
            Spacer(minLength: Space.sm)
            Image(icon: "chevron.right").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Pushed page: the files a restore would write, then a confirmation that sends those exact rows back.
struct GitCheckpointDetail: View {
    let workbench: Workbench
    let project: Project
    let checkpoint: Checkpoint
    let onBack: () -> Void
    let onRestored: () async -> Void
    @Environment(\.palette) private var palette
    @State private var changes: [CheckpointChange]?
    @State private var error: String?
    @State private var busy = false
    @State private var confirm = false

    var body: some View {
        VStack(spacing: 0) {
            DetailHeader(title: checkpoint.title, subtitle: checkpointSubtitle(checkpoint), back: { if !busy { onBack() } }) {
                Button(GitCopy.restore) { confirm = true }
                    .buttonStyle(SolidButtonStyle(kind: .danger))
                    .disabled(changes == nil || busy)
            }
            PanelRule()
            if let error { GitInlineError(message: error) }
            if let changes {
                if changes.isEmpty {
                    ContentUnavailableView(GitCopy.noDifferences(from: "the working tree"), icon: "checkmark.circle")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(changes, id: \.path) { GitCheckpointChangeRow(change: $0) }
                        }
                        .padding(Space.xs + 2)
                    }
                }
            } else if error == nil {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Spacer(minLength: 0)
            }
        }
        .confirmationDialog(plain("Restore \"\(checkpoint.title)\"?"), isPresented: $confirm, titleVisibility: .visible) {
            Button(GitCopy.restore, role: .destructive) {
                let reviewed = changes ?? []
                Task { await restore(reviewed) }
            }
            Button(GitCopy.cancel, role: .cancel) {}
        } message: {
            Text(verbatim: confirmMessage)
        }
        .task(id: checkpoint.id) { await load() }
    }

    private var confirmMessage: String {
        guard let changes else { return "Reading the changes." }
        if changes.isEmpty {
            return "No file differs. The server still checks this empty list and refuses if the working tree has changed."
        }
        let lines = changes.prefix(16).map { "\(gitChangeLabel($0.kind))  \($0.path)\n    \(shortHash($0.beforeHash)) → \(shortHash($0.afterHash))" }
        var text = lines.joined(separator: "\n")
        if changes.count > 16 { text += "\n… \(GitCopy.moreFiles(changes.count - 16))." }
        text += "\n\nThe server checks these files again. If one changed in the meantime, the restore is refused."
        return text
    }

    private func load() async {
        guard let api = workbench.host.api else { return }
        do {
            changes = try await api.checkpointChanges(projectId: project.id, checkpointId: checkpoint.id)
            error = nil
        } catch {
            self.error = "Couldn't read the checkpoint: \(gitMessage(error))"
        }
    }

    /// Sends the list the reader just confirmed. A 409 means that list is stale: reload it and ask again.
    private func restore(_ expected: [CheckpointChange]) async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        error = nil
        do {
            try await api.restoreCheckpoint(projectId: project.id, checkpointId: checkpoint.id, expectedChanges: expected)
            await onRestored()
        } catch {
            await handleRestoreFailure(error)
        }
        busy = false
    }

    private func handleRestoreFailure(_ error: Error) async {
        let http = riffetHTTP(error)
        if http?.code == "CHECKPOINT_EXCLUDED_CHANGES" {
            self.error = "This checkpoint holds files that can't be restored safely. \(gitMessage(error))"
            return
        }
        guard http?.status == 409 || http?.code == "CHECKPOINT_CONFLICT" else {
            self.error = "Restore refused: \(gitMessage(error))"
            return
        }
        guard let api = workbench.host.api else {
            self.error = "The working tree changed and the restore was refused. Not connected, so the changes can't be read again."
            return
        }
        do {
            changes = try await api.checkpointChanges(projectId: project.id, checkpointId: checkpoint.id)
            self.error = "The working tree changed since the preview. The list below is read again; restore once you have checked it."
        } catch {
            changes = nil
            self.error = "The working tree changed and the restore was refused. Couldn't read the changes again: \(gitMessage(error))"
        }
    }
}

struct GitCheckpointChangeRow: View {
    let change: CheckpointChange
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Text(verbatim: gitChangeLabel(change.kind))
                .font(.riffet(size: S(11), weight: .semibold))
                .foregroundStyle(gitChangeTint(change.kind, palette))
                .frame(width: 56, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: change.path)
                    .font(.riffet(size: S(12), design: .monospaced))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(change.path)
                Text("\(shortHash(change.beforeHash)) → \(shortHash(change.afterHash))")
                    .font(.riffet(size: S(11), design: .monospaced))
                    .foregroundStyle(palette.fg4)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

func checkpointSubtitle(_ checkpoint: Checkpoint) -> String {
    var parts: [String] = []
    if let when = formatDateTime(value: checkpoint.createdAt) { parts.append(when) }
    parts.append(GitCopy.files(Int(checkpoint.files)))
    if !checkpoint.excluded.isEmpty { parts.append("\(checkpoint.excluded.count) excluded") }
    return parts.joined(separator: " · ")
}
