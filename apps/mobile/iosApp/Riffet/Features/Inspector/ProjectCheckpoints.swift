import SwiftUI
import RiffetKit

struct ProjectCheckpoints: View {
    let model: GitPanelModel
    let refresh: Int
    @State private var checkpoints: [Checkpoint]?
    @State private var title = ""
    @State private var error: String?
    @State private var creating = false
    @State private var createError: String?
    @Environment(\.palette) private var palette

    private var project: Project { model.project }

    init(model: GitPanelModel, refresh: Int) {
        self.model = model
        self.refresh = refresh
    }

    init(workbench: Workbench, project: Project, refresh: Int) {
        self.init(model: GitPanelModel(workbench: workbench, project: project), refresh: refresh)
    }

    var body: some View {
        List {
            RiffetNotice.section(.error, error, actionTitle: gitText("Retry")) { Task { await load() } }
            if let checkpoints {
                let saved = checkpoints.filter { $0.partial?.boolValue != true }
                if saved.isEmpty { ContentUnavailableView(gitText("No checkpoints yet"), systemImage: "clock.arrow.circlepath") }
                ForEach(saved, id: \.id) { checkpoint in
                    NavigationLink {
                        CheckpointDetail(model: model, checkpoint: checkpoint)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(checkpoint.title).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                            Text(verbatim: "\(gitFiles(Int(checkpoint.files))) · \(gitRelative(checkpoint.createdAt))").riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                        }
                    }
                }
            } else if error == nil { ProgressView().frame(maxWidth: .infinity) }
        }
        .task(id: "\(project.id)|\(refresh)") { await load() }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(gitText("New Checkpoint"), systemImage: "plus") { creating = true }
            }
        }
        .sheet(isPresented: $creating) {
            RiffetEditPage(title: gitText("New Checkpoint"), saveTitle: gitText("Save"), dirty: !title.isEmpty, alwaysSavable: true) {
                await create()
            } content: {
                RiffetNotice.section(.error, createError)
                Section { RiffetField(prompt: gitText("Name (optional)"), text: $title) }
            }
        }
    }
    private func load() async {
        do {
            checkpoints = try await model.api().checkpoints(projectId: project.id)
            error = nil
        } catch { self.error = gitMessage(error) }
    }
    private func create() async -> Bool {
        do {
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await model.api().createCheckpoint(projectId: project.id, body: CreateCheckpointRequest(sessionId: model.sessionID, title: name.isEmpty ? nil : name))
            title = ""
            createError = nil
            await load()
            return true
        } catch { createError = gitMessage(error); return false }
    }
}

private struct CheckpointDetail: View {
    let model: GitPanelModel
    let checkpoint: Checkpoint
    @State private var changes: [CheckpointChange]?
    @State private var error: String?
    @State private var confirm = false
    @State private var busy = false
    @State private var restored = false
    @Environment(\.palette) private var palette

    var body: some View {
        RiffetList {
            if let error {
                RiffetNotice.section(.error, error)
            } else if restored {
                RiffetNotice.section(.success, gitText("Restored"))
            }
            Section {
                VStack(alignment: .leading, spacing: 2) {
                    Text(checkpoint.title).riffetFont(.headline).foregroundStyle(palette.fg)
                    Text(gitRelative(checkpoint.createdAt)).riffetFont(.caption).foregroundStyle(palette.fg3)
                }
                RiffetValueRow(label: gitText("Files"), value: gitFiles(Int(checkpoint.files)))
                if !checkpoint.excluded.isEmpty { RiffetValueRow(label: gitText("Excluded"), value: "\(checkpoint.excluded.count)") }
            }
            if let changes {
                if changes.isEmpty {
                    Section { Text(gitText("Same as the working tree")).riffetFont(.body).foregroundStyle(palette.fg3) }
                } else {
                    Section {
                        ForEach(changes, id: \.path) { change in
                            GitFileLabel(letter: change.kind == .added ? "A" : change.kind == .deleted ? "D" : "M", path: change.path)
                        }
                    }
                    Section {
                        RiffetActionRow(verbatim: gitText("Restore"), symbol: "arrow.uturn.backward", destructive: true, enabled: !busy && !restored) { confirm = true }
                    }
                }
            } else if error == nil { Section { ProgressView().frame(maxWidth: .infinity) } }
        }
        .navigationTitle(gitText("Checkpoint"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: checkpoint.id) { await load() }
        .confirmationDialog(gitText("Restore \"\(checkpoint.title)\"?"), isPresented: $confirm, titleVisibility: .visible) {
            Button(gitText("Restore \(gitFiles(changes?.count ?? 0))"), role: .destructive) {
                let reviewed = changes ?? []
                Task { await restore(reviewed) }
            }
        }
    }
    private func load() async {
        do {
            changes = try await model.api().checkpointChanges(projectId: model.project.id, checkpointId: checkpoint.id)
            error = nil
        } catch { self.error = gitMessage(error) }
    }
    private func restore(_ reviewed: [CheckpointChange]) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await model.api().restoreCheckpoint(projectId: model.project.id, checkpointId: checkpoint.id, expectedChanges: reviewed)
            restored = true
            await load()
            await model.reload()
        } catch {
            if error.riffetStatus == 409 {
                // A stale confirmation must never silently submit a new file list.
                changes = nil
                await load()
                self.error = "Restore refused"
            } else { self.error = gitMessage(error) }
        }
    }
}
