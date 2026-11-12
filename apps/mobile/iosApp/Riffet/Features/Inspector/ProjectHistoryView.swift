import SwiftUI
import RiffetKit

private let rowHeight: CGFloat = 44
private let pageSize = 150

struct ProjectHistoryView: View {
    let model: GitPanelModel
    let refresh: Int
    @State private var generation = 0
    @State private var refs: GitRefs?
    @State private var all = false
    @State private var commits: [GitCommit] = []
    @State private var rows: [GitGraphRow] = []
    @State private var more = false
    @State private var loading = false
    @State private var loaded = false
    @State private var error: String?
    @State private var prompt: Prompt?
    @State private var name = ""

    private enum Prompt: Identifiable {
        case newBranch, remote
        var id: Self { self }
    }

    private var lanes: Int { rows.map { Int($0.width) }.max() ?? 1 }
    private var head: String { refs?.head ?? "HEAD" }

    var body: some View {
        List {
            Section {
                HStack {
                    branchMenu
                    Spacer()
                    Button(gitText("Fetch"), systemImage: "arrow.triangle.2.circlepath") { Task { await fetch() } }
                        .labelStyle(.iconOnly).disabled(loading)
                }
                Picker(gitText("History"), selection: $all) {
                    Text(verbatim: "Current").tag(false)
                    Text(verbatim: "All").tag(true)
                }.pickerStyle(.segmented)
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if loaded && commits.isEmpty && error == nil {
                ContentUnavailableView(gitText("No commits yet"), systemImage: "clock.arrow.circlepath")
            }
            ForEach(Array(commits.enumerated()), id: \.element.hash_) { index, commit in
                NavigationLink {
                    CommitDetailPage(model: model, hash: commit.hash_) { await reload() }
                } label: {
                    HStack(spacing: 8) {
                        if index < rows.count { GitGraphCell(row: rows[index], lanes: lanes, height: rowHeight) }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(commit.subject).lineLimit(1)
                            HStack(spacing: 4) {
                                ForEach(Array(commit.refs.prefix(3).enumerated()), id: \.offset) { _, ref in refChip(ref) }
                                Text(verbatim: "\(commit.author) · \(gitRelative(commit.date))").lineLimit(1)
                            }.font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                .frame(height: rowHeight)
                .onAppear { if more, !loading, index >= commits.count - 20 { Task { await loadMore() } } }
            }
            if loading && loaded { ProgressView().frame(maxWidth: .infinity) }
        }
        .listStyle(.plain)
        .overlay { if !loaded && error == nil { ProgressView() } }
        .task(id: "\(model.project.id)|\(all)|\(refresh)|\(model.revision)") { await reload() }
        .refreshable { await reload() }
        .alert(prompt == .remote ? gitText("Check Out Remote Branch…") : gitText("New Branch…"), isPresented: Binding(get: { prompt != nil }, set: { if !$0 { prompt = nil } })) {
            TextField(gitText("Branch name"), text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button(prompt == .remote ? gitText("Check Out") : gitText("Create and Switch")) {
                let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
                let kind = prompt
                name = ""
                guard !value.isEmpty else { return }
                Task { await kind == .remote ? switchTo(remote: value) : switchTo(branch: value, create: true) }
            }
            Button(gitText("Cancel"), role: .cancel) { name = "" }
        }
    }

    private var branchMenu: some View {
        Menu {
            if let refs {
                Section {
                    ForEach(refs.branches, id: \.name) { branch in
                        Button { Task { await switchTo(branch: branch.name, create: false) } } label: {
                            if branch.current?.boolValue == true { Label(branch.name, systemImage: "checkmark") } else { Text(branch.name) }
                        }.disabled(branch.elsewhere?.boolValue == true)
                    }
                }
                if !refs.remotes.isEmpty {
                    Section {
                        ForEach(refs.remotes, id: \.name) { remote in
                            Button(remote.name) { Task { await switchTo(remote: remote.name) } }
                        }
                    }
                }
            }
            Section {
                if (refs?.remoteCount ?? 0) > 30 { Button(gitText("Check Out Remote Branch…")) { prompt = .remote } }
                Button(gitText("New Branch…")) { prompt = .newBranch }
            }
        } label: {
            Label(head, systemImage: "arrow.triangle.branch").font(.body.monospaced()).lineLimit(1)
        }
    }

    private func refChip(_ ref: GitRefLabel) -> some View {
        let strong = ref.current?.boolValue == true || ref.kind == .head
        return Text(ref.name).font(.caption2.monospaced()).lineLimit(1)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .foregroundStyle(strong ? Color.white : Color.secondary)
            .background(strong ? Color.accentColor : Color.secondary.opacity(0.15), in: Capsule())
    }

    private func reload() async {
        generation += 1
        let mine = generation
        loading = true
        defer { if mine == generation { loading = false } }
        do {
            let api = try model.api()
            async let nextRefs = api.gitRefs(projectId: model.project.id, query: nil)
            let page = try await api.gitLog(projectId: model.project.id, all: all, skip: 0)
            let fresh = try? await nextRefs
            guard mine == generation else { return }
            refs = fresh
            commits = page.commits
            rows = layoutGitGraph(commits: commits)
            more = page.more
            error = nil
            loaded = true
        } catch {
            guard mine == generation else { return }
            self.error = gitMessage(error)
            loaded = true
        }
    }

    private func loadMore() async {
        guard !loading else { return }
        let mine = generation
        loading = true
        defer { if mine == generation { loading = false } }
        do {
            let page = try await model.api().gitLog(projectId: model.project.id, all: all, skip: Int32(commits.count))
            guard mine == generation else { return }
            let known = Set(commits.map(\.hash_))
            commits += page.commits.filter { !known.contains($0.hash_) }
            rows = layoutGitGraph(commits: commits)
            more = page.more
        } catch { self.error = gitMessage(error) }
    }

    private func fetch() async {
        let done = await model.run { api in refs = try await api.gitFetch(projectId: model.project.id) }
        if done { await reload(); await model.reloadBranch() } else { error = model.error }
    }

    private func switchTo(branch: String, create: Bool) async {
        let done = await model.run { api in _ = try await api.gitSwitch(projectId: model.project.id, branch: branch, create: create, base: nil, remote: nil) }
        await switched(done)
    }

    private func switchTo(remote: String) async {
        let done = await model.run { api in _ = try await api.gitSwitch(projectId: model.project.id, branch: nil, create: false, base: nil, remote: remote) }
        await switched(done)
    }

    private func switched(_ done: Bool) async {
        if done { await model.reload() } else { error = model.error }
    }
}

private struct CommitDetailPage: View {
    let model: GitPanelModel
    let hash: String
    let switched: () async -> Void
    @State private var detail: GitCommitDetail?
    @State private var error: String?
    @State private var branching = false
    @State private var name = ""

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let detail {
                Section {
                    Text(detail.subject).font(.headline)
                    if !detail.body.isEmpty { Text(detail.body).textSelection(.enabled) }
                    Text(verbatim: "\(detail.author) · \(ServerTime.date(detail.date)?.formatted(.dateTime.locale(Locale(identifier: "en"))) ?? detail.date)")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Text(String(detail.hash_.prefix(8))).font(.body.monospaced())
                        Spacer()
                        Button(gitText("Copy Hash"), systemImage: "doc.on.doc") { UIPasteboard.general.string = detail.hash_ }.labelStyle(.iconOnly)
                    }
                    Button(gitText("New Branch from Here"), systemImage: "arrow.triangle.branch") { branching = true }
                }
                Section {
                    ForEach(detail.files, id: \.path) { file in
                        NavigationLink {
                            ProjectDiffPage(model: model, path: file.path, source: .commit(detail.hash_))
                        } label: {
                            GitFileLabel(letter: gitLetter(file.status), path: file.path, added: file.added, removed: file.removed)
                        }
                        .contextMenu { Button(gitText("Copy Path")) { UIPasteboard.general.string = file.path } }
                    }
                    if let total = detail.filesTotal?.intValue, total > detail.files.count {
                        Text(verbatim: "Showing the first \(detail.files.count) of \(total) files").foregroundStyle(.secondary)
                    }
                }
            } else if error == nil { ProgressView().frame(maxWidth: .infinity) }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: hash) { await load() }
        .alert(gitText("New Branch from Here"), isPresented: $branching) {
            TextField(gitText("Branch name"), text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button(gitText("Create and Switch")) {
                let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
                name = ""
                guard !value.isEmpty else { return }
                Task { await create(value) }
            }
            Button(gitText("Cancel"), role: .cancel) { name = "" }
        }
    }

    private func load() async {
        do {
            detail = try await model.api().gitCommit(projectId: model.project.id, hash: hash)
            error = nil
        } catch { self.error = gitMessage(error) }
    }

    private func create(_ branch: String) async {
        let done = await model.run { api in _ = try await api.gitSwitch(projectId: model.project.id, branch: branch, create: true, base: hash, remote: nil) }
        if done { await model.reload(); await switched() } else { error = model.error }
    }
}

/// A changed file: its status letter, path and line counts.
struct GitFileLabel: View {
    let letter: String
    let path: String
    var added: KotlinLong?
    var removed: KotlinLong?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(letter).font(.caption.monospaced().bold()).foregroundStyle(gitLetterColor(letter)).frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(path).font(.body.monospaced()).lineLimit(3)
                if added != nil || removed != nil {
                    HStack {
                        if let added { Text("+\(added.int64Value)").foregroundStyle(.green) }
                        if let removed { Text("−\(removed.int64Value)").foregroundStyle(.red) }
                    }.font(.caption.monospaced())
                }
            }
        }
    }
}
