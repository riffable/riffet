import SwiftUI
import RiffetKit

struct GitWorktreesList: View {
    let workbench: Workbench
    let project: Project
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.inspectorPanelVisible) private var visible
    /// Something changed while the list was kept out of sight: it is read again once shown.
    @State private var stale = false
    @State private var worktrees: [WorktreeInfo]?
    @State private var search = ""
    @State private var creating = false
    @State private var managedExpanded = true
    @State private var otherExpanded: Bool?
    @State private var revealedPath: String?
    @State private var pendingRevealPath: String?
    @State private var branch = ""
    @State private var base = ""
    @State private var error: String?
    @State private var busy = false
    @State private var loading = false
    @State private var pendingRemove: WorktreeInfo?
    @State private var activeProjectId: String?
    @State private var projectRevision = 0
    @State private var loadRevision = 0

    private var projectSignature: [String] {
        workbench.projects.map { "\($0.id)\u{1}\($0.cwd)\u{1}\($0.updatedAt)\u{1}\($0.worktree?.originProjectId ?? "")\u{1}\($0.worktree?.branch ?? "")" }.sorted()
    }

    private var current: WorktreeInfo? { worktrees?.first(where: isCurrent) }
    private var managed: [WorktreeInfo] { (worktrees ?? []).filter { !isCurrent($0) && isManaged($0) } }
    private var others: [WorktreeInfo] { (worktrees ?? []).filter { !isCurrent($0) && !isManaged($0) } }
    private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                GitField(placeholder: "Search", text: $search)
                Button { creating.toggle() } label: {
                    Image(icon: creating ? "xmark" : "plus").font(.riffet(size: S(12)))
                }
                .buttonStyle(IconButtonStyle())
                .help(creating ? plain("Close") : plain("New Worktree"))
                .disabled(project.isTaskWorkspace)
                .disabled(busy)
                Button { Task { await load() } } label: {
                    Image(icon: "arrow.clockwise").font(.riffet(size: S(12)))
                }
                .buttonStyle(IconButtonStyle())
                .help(GitCopy.refresh)
                .accessibilityLabel(GitCopy.refresh)
                .disabled(loading || busy)
            }
            .padding(Space.md)
            if creating { createForm }
            if let error { GitInlineError(message: error) }
            content
        }
        .confirmationDialog(plain("Remove worktree?"), isPresented: removePresented, titleVisibility: .visible) {
            Button(GitCopy.remove, role: .destructive) {
                guard let target = pendingRemove else { return }
                pendingRemove = nil
                Task { await remove(target) }
            }
            Button(GitCopy.cancel, role: .cancel) { pendingRemove = nil }
        } message: {
            Text(verbatim: pendingRemove?.path ?? "")
        }
        .task(id: project.id) {
            activeProjectId = project.id
            projectRevision += 1
            loadRevision += 1
            branch = ""
            base = ""
            search = ""
            creating = false
            managedExpanded = true
            otherExpanded = nil
            revealedPath = nil
            pendingRevealPath = nil
            pendingRemove = nil
            busy = false
            worktrees = nil
            error = nil
            await load()
        }
        .onChange(of: projectSignature) { _, _ in reloadWhenVisible() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { reloadWhenVisible() }
        }
        .onChange(of: visible) { _, shown in
            if shown, stale { reloadWhenVisible() }
        }
    }

    private func reloadWhenVisible() {
        guard visible else { stale = true; return }
        stale = false
        Task { await load() }
    }

    private var createForm: some View {
        VStack(spacing: Space.sm) {
            GitField(placeholder: "New branch name", text: $branch) { Task { await create() } }
            HStack(spacing: Space.sm) {
                GitField(placeholder: "Based on (optional)", text: $base) { Task { await create() } }
                Button(plain("Create")) { Task { await create() } }
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .disabled(branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.bottom, Space.md)
        .disabled(busy)
    }

    private var removePresented: Binding<Bool> {
        Binding(get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } })
    }

    @ViewBuilder
    private var content: some View {
        if worktrees == nil, error == nil {
            Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let worktrees, !worktrees.isEmpty {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if let current, matches(current) { row(current) }
                        group("Riffet", items: managed, expanded: $managedExpanded)
                        group("Other", items: others, expanded: Binding(
                            get: { otherExpanded ?? managed.isEmpty },
                            set: { otherExpanded = $0 }
                        ))
                        if !query.isEmpty, !worktrees.contains(where: matches) {
                            ContentUnavailableView(plain("No matching worktrees"), icon: "magnifyingglass")
                        }
                    }
                    .padding(Space.xs + 2)
                }
                .onChange(of: revealedPath) { _, path in
                    if let path { withAnimation { proxy.scrollTo(path, anchor: .center) } }
                }
            }
        } else if error == nil {
            ContentUnavailableView(plain("No worktrees"), icon: "arrow.triangle.branch")
        } else {
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func group(_ title: String, items: [WorktreeInfo], expanded: Binding<Bool>) -> some View {
        let visible = items.filter(matches)
        if !visible.isEmpty {
            Button { expanded.wrappedValue.toggle() } label: {
                HStack(spacing: Space.sm) {
                    Image(icon: expanded.wrappedValue || !query.isEmpty ? "chevron.down" : "chevron.right")
                        .font(.riffet(size: S(10), weight: .semibold))
                        .frame(width: 12)
                    Text(verbatim: title).font(.riffet(size: S(12), weight: .medium))
                    Text("\(visible.count)").font(.riffet(size: S(11), design: .monospaced))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(palette.fg3)
                .padding(.horizontal, Space.sm)
                .padding(.vertical, Space.sm)
                .contentShape(Rectangle())
            }
            .buttonStyle(HoverRowStyle())
            if expanded.wrappedValue || !query.isEmpty {
                ForEach(visible, id: \.path) { row($0) }
            }
        }
    }

    private func row(_ worktree: WorktreeInfo) -> some View {
        GitWorktreeRow(
            worktree: worktree,
            displayPath: isCurrent(worktree) ? tildePath(path: worktree.path) : displayPath(worktree.path),
            current: isCurrent(worktree),
            busy: busy,
            start: { Task { await openSession(worktree) } },
            remove: { pendingRemove = worktree }
        )
        .id(worktree.path)
    }

    private func isCurrent(_ worktree: WorktreeInfo) -> Bool {
        worktree.current?.boolValue ?? (trimTrailingSlash(worktree.path) == trimTrailingSlash(project.cwd))
    }

    private func isManaged(_ worktree: WorktreeInfo) -> Bool {
        worktree.managed?.boolValue == true
    }

    private func matches(_ worktree: WorktreeInfo) -> Bool {
        query.isEmpty || worktree.path.localizedCaseInsensitiveContains(query)
            || worktreeBranchLabel(worktree.branch).localizedCaseInsensitiveContains(query)
    }

    private func displayPath(_ path: String) -> String {
        let components = path.split(separator: "/")
        let paths = (worktrees ?? []).map { $0.path.split(separator: "/") }
        let shared = components.indices.prefix { index in paths.allSatisfy { $0.count > index && $0[index] == components[index] } }.count
        let suffix = components.dropFirst(min(shared, max(0, components.count - 2)))
        if suffix.count < components.count { return "…/" + suffix.suffix(2).joined(separator: "/") }
        return tildePath(path: path)
    }

    private func load() async {
        let projectId = project.id
        guard activeProjectId == projectId, let api = workbench.host.api else { return }
        loadRevision += 1
        let revision = loadRevision
        loading = true
        do {
            let result = try await api.worktrees(projectId: projectId)
            guard activeProjectId == projectId, loadRevision == revision, !Task.isCancelled else { return }
            if worktrees != result { worktrees = result }
            if error != nil { error = nil }
            if let path = pendingRevealPath, let item = result.first(where: { trimTrailingSlash($0.path) == trimTrailingSlash(path) }) {
                if isManaged(item) { managedExpanded = true }
                else { otherExpanded = true }
                revealedPath = item.path
                pendingRevealPath = nil
            }
        } catch {
            guard activeProjectId == projectId, loadRevision == revision, !Task.isCancelled else { return }
            self.error = "Couldn't read worktrees: \(gitMessage(error))"
            if worktrees == nil { worktrees = [] }
        }
        loading = false
    }

    private func create() async {
        let name = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        let projectId = project.id
        let operationRevision = projectRevision
        guard activeProjectId == projectId, !project.isTaskWorkspace, let api = workbench.host.api, !name.isEmpty, !busy else { return }
        busy = true
        error = nil
        let from = base.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let created = try await api.createWorktree(projectId: projectId, body: CreateWorktreeRequest(branch: name, path: nil, base: from.isEmpty ? nil : from))
            guard activeProjectId == projectId, projectRevision == operationRevision else { return }
            branch = ""
            base = ""
            search = ""
            creating = false
            managedExpanded = true
            revealedPath = nil
            pendingRevealPath = created.path
            await load()
            guard activeProjectId == projectId, projectRevision == operationRevision else { return }
            if error == nil, !loading, worktrees?.contains(where: { trimTrailingSlash($0.path) == trimTrailingSlash(created.path) }) != true {
                self.error = "The worktree was created but is not in the list. Refresh to check."
            }
        } catch {
            guard activeProjectId == projectId, projectRevision == operationRevision else { return }
            self.error = "Couldn't create the worktree: \(gitMessage(error))"
        }
        busy = false
    }

    private func remove(_ worktree: WorktreeInfo) async {
        let projectId = project.id
        let operationRevision = projectRevision
        guard activeProjectId == projectId, let api = workbench.host.api, !busy else { return }
        busy = true
        error = nil
        do {
            try await api.removeWorktree(projectId: projectId, path: worktree.path)
            guard activeProjectId == projectId, projectRevision == operationRevision else { return }
            await load()
            guard activeProjectId == projectId, projectRevision == operationRevision else { return }
            if error == nil, !loading, worktrees?.contains(where: { trimTrailingSlash($0.path) == trimTrailingSlash(worktree.path) }) == true {
                self.error = "The worktree was removed but is still in the list. Refresh to check."
            }
        } catch {
            guard activeProjectId == projectId, projectRevision == operationRevision else { return }
            self.error = "Couldn't remove the worktree: \(gitMessage(error))"
        }
        busy = false
    }

    private func openSession(_ worktree: WorktreeInfo) async {
        let projectId = project.id
        let operationRevision = projectRevision
        guard activeProjectId == projectId, !busy, !isCurrent(worktree) else { return }
        busy = true
        error = nil
        do {
            let opened = try await workbench.openDirectory(worktree.path)
            guard activeProjectId == projectId, projectRevision == operationRevision else { return }
            workbench.showHome(projectId: opened.id)
        } catch {
            guard activeProjectId == projectId, projectRevision == operationRevision else { return }
            self.error = gitMessage(error)
        }
        busy = false
    }
}

struct GitWorktreeRow: View {
    let worktree: WorktreeInfo
    let displayPath: String
    let current: Bool
    let busy: Bool
    let start: () -> Void
    let remove: () -> Void
    @Environment(\.palette) private var palette

    private var bare: Bool { worktree.bare?.boolValue == true }
    private var detached: Bool { worktreeBranchLabel(worktree.branch) == GitCopy.detached }

    var body: some View {
        Button(action: start) {
            HStack(spacing: Space.sm) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .top, spacing: Space.sm) {
                        Text(verbatim: worktreeBranchLabel(worktree.branch))
                            .font(.riffet(size: S(12), weight: .medium, design: .monospaced))
                            .foregroundStyle(palette.fg)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .help("\(worktreeBranchLabel(worktree.branch))\n\(worktree.head)")
                        if current { GitMetaBadge(text: GitCopy.current, tint: palette.accent).fixedSize() }
                        if detached {
                            Text(String(worktree.head.prefix(8)))
                                .font(.riffet(size: S(11), design: .monospaced))
                                .foregroundStyle(palette.fg4)
                        }
                    }
                    Text(displayPath)
                        .font(.riffet(size: S(11), design: .monospaced))
                        .foregroundStyle(palette.fg4)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(worktree.path)
                }
                if !bare, !current {
                    Image(icon: "arrow.right")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.fg4)
                }
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverRowStyle())
        .disabled(busy || bare)
        .contextMenu {
            if !bare, !current { Button(plain("Start Conversation Here"), action: start).disabled(busy) }
            Button(GitCopy.copyPath) { copyToPasteboard(worktree.path) }
            if !bare, !current { Divider(); Button(GitCopy.remove, role: .destructive, action: remove).disabled(busy) }
        }
    }
}
