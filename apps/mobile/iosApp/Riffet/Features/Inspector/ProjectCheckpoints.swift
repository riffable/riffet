import SwiftUI
import RiffetKit

struct ProjectCheckpoints: View {
    let model: GitPanelModel
    let refresh: Int
    @State private var checkpoints: [Checkpoint]?
    @State private var title = ""
    @State private var error: String?
    @State private var busy = false

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
            Section {
                TextField(gitText("Checkpoint name (optional)"), text: $title)
                Button(gitText("Save")) { Task { await create() } }.disabled(busy)
            }
            if let error { Text(error).foregroundStyle(.red) }
            if let checkpoints {
                let saved = checkpoints.filter { $0.partial?.boolValue != true }
                if saved.isEmpty { ContentUnavailableView(gitText("No checkpoints yet"), systemImage: "clock.arrow.circlepath") }
                ForEach(saved, id: \.id) { checkpoint in
                    NavigationLink {
                        CheckpointDetail(model: model, checkpoint: checkpoint)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(checkpoint.title)
                            Text(verbatim: "\(gitFiles(Int(checkpoint.files))) · \(gitRelative(checkpoint.createdAt))").font(.caption).foregroundStyle(.secondary)
                            if !checkpoint.excluded.isEmpty { Text(verbatim: "\(checkpoint.excluded.count) excluded").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            } else if error == nil { ProgressView() }
        }
        .task(id: "\(project.id)|\(refresh)") { await load() }
        .refreshable { await load() }
    }
    private func load() async {
        do {
            checkpoints = try await model.api().checkpoints(projectId: project.id)
            error = nil
        } catch { self.error = gitMessage(error) }
    }
    private func create() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await model.api().createCheckpoint(projectId: project.id, body: CreateCheckpointRequest(sessionId: model.sessionID, title: name.isEmpty ? nil : name))
            title = ""
            await load()
        } catch { self.error = gitMessage(error) }
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

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if restored { Label(gitText("Restored"), systemImage: "checkmark.circle").foregroundStyle(.secondary) }
            if let changes {
                Section {
                    Button(gitText("Restore"), role: .destructive) { confirm = true }.disabled(busy || restored || changes.isEmpty)
                }
                if changes.isEmpty { ContentUnavailableView(gitText("Same as the working tree"), systemImage: "checkmark.circle") }
                ForEach(changes, id: \.path) { change in
                    GitFileLabel(letter: change.kind == .added ? "A" : change.kind == .deleted ? "D" : "M", path: change.path)
                        .textSelection(.enabled)
                }
            } else if error == nil { ProgressView() }
        }
        .navigationTitle(checkpoint.title)
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
