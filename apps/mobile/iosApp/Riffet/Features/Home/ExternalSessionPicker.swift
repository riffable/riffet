import SwiftUI
import RiffetKit

/// Conversations that Claude Code and Codex stored on the server's machine (docs/TERMINAL-SESSIONS.md).
/// Choosing one imports it and opens the new conversation. Listing starts no CLI.
struct ExternalSessionPicker: View {
    let workbench: Workbench
    /// The project the list starts in; without one the picker starts on 全部.
    let projectID: String?
    let open: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var scope: ExternalScope
    @State private var filter = ExternalFilter()
    @State private var importing: String?

    init(workbench: Workbench, projectID: String?, open: @escaping (String) -> Void) {
        self.workbench = workbench
        self.projectID = projectID
        self.open = open
        _scope = State(initialValue: projectID == nil ? .all : .project)
    }

    var body: some View {
        NavigationStack {
            Group {
                if scope == .directory {
                    ExternalDirectoryList(workbench: workbench, filter: $filter)
                } else {
                    ExternalSessionList(workbench: workbench, scope: scope, projectID: projectID, cwd: nil, filter: $filter, importing: importing, pick: pick)
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    Picker("", selection: $scope) {
                        if projectID != nil { Text("当前项目").tag(ExternalScope.project) }
                        Text("按目录").tag(ExternalScope.directory)
                        Text("全部").tag(ExternalScope.all)
                    }.pickerStyle(.segmented).padding(.horizontal, RiffetMetrics.pageInset).padding(.vertical, 8)
                    ExternalAgentChips(filter: $filter)
                }
            }
            .navigationTitle(String(localized: "从终端导入", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { cwd in
                ExternalSessionList(workbench: workbench, scope: .directory, projectID: nil, cwd: cwd, filter: $filter, importing: importing, pick: pick)
                    .safeAreaInset(edge: .top, spacing: 0) { ExternalAgentChips(filter: $filter) }
                    .navigationTitle(cwd.split(separator: "/").last.map(String.init) ?? cwd).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .topBarTrailing) { ExternalFilterMenu(filter: $filter) } }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { ExternalFilterMenu(filter: $filter) }
            }
        }
        .riffetToastHost()
    }

    private func pick(_ item: ExternalSession) {
        guard importing == nil else { return }
        importing = item.nativeSessionId
        Task {
            defer { importing = nil }
            do {
                let result = try await workbench.store.importExternalSession(backendId: item.backendId, backendProfileId: item.backendProfileId, nativeSessionId: item.nativeSessionId)
                dismiss(); open(result.session.id)
            } catch is CancellationError {} catch { RiffetToastCenter.shared.error(error.riffetMessage) }
        }
    }
}

enum ExternalScope: Hashable {
    case project, directory, all
    var wire: String {
        switch self {
        case .project: "project"
        case .directory: "directory"
        case .all: "all"
        }
    }
}

struct ExternalFilter: Equatable {
    /// `claude`, `codex`, or nil for both.
    var backend: String?
    var nonInteractive = false
}

/// 全部 and the agents whose sessions can be imported, above the list.
private struct ExternalAgentChips: View {
    @Binding var filter: ExternalFilter
    var body: some View {
        RiffetChipBar(items: [.init(value: nil, title: String(localized: "全部", bundle: .riffet)),
                              .init(value: "claude", title: "Claude"), .init(value: "codex", title: "Codex")],
                      selection: $filter.backend)
    }
}

private struct ExternalFilterMenu: View {
    @Binding var filter: ExternalFilter
    var body: some View {
        Menu {
            Toggle("含非交互", isOn: $filter.nonInteractive)
        } label: {
            Image(systemName: filter.nonInteractive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }.accessibilityLabel("筛选")
    }
}

private struct ExternalSessionList: View {
    let workbench: Workbench
    let scope: ExternalScope
    let projectID: String?
    let cwd: String?
    @Binding var filter: ExternalFilter
    let importing: String?
    let pick: (ExternalSession) -> Void
    @State private var query = ""
    @State private var items: [ExternalSession] = []
    @State private var failures: [ExternalSessionFailure] = []
    @State private var next: String?
    @State private var loading = true
    @State private var loadingMore = false
    @State private var error: String?
    @State private var retry = 0
    @Environment(\.palette) private var palette
    private var key: String { "\(scope.wire)|\(projectID ?? "")|\(cwd ?? "")|\(filter.backend ?? "")|\(filter.nonInteractive)|\(query)|\(retry)" }

    var body: some View {
        List {
            RiffetNotice.section(.error, error, actionTitle: String(localized: "重试", bundle: .riffet), action: { retry += 1 })
            if !failures.isEmpty {
                Section { ForEach(failures, id: \.backendId) { Text(verbatim: "\($0.backendId): \($0.message)").riffetFont(.caption).foregroundStyle(palette.fg3) } }
            }
            ForEach(items, id: \.nativeSessionId) { item in
                ExternalSessionRow(workbench: workbench, item: item, showsDirectory: scope != .project && cwd == nil, busy: importing == item.nativeSessionId) { pick(item) }
                    .disabled(importing != nil || !item.cwdExists)
                    .onAppear { if item.nativeSessionId == items.last?.nativeSessionId { Task { await loadMore() } } }
            }
            if loading || loadingMore { HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden) }
            if !loading && error == nil && items.isEmpty {
                ContentUnavailableView("没有可导入的会话", systemImage: "terminal")
            }
        }
        .riffetSearchable(text: $query, prompt: String(localized: "搜索标题与目录", bundle: .riffet))
        .task(id: key) { await reload() }
        .refreshable { await reload(refresh: true) }
    }

    private func page(cursor: String?, refresh: Bool = false) async throws -> ExternalSessionPage {
        guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
        return try await api.externalSessions(scope: scope.wire, projectId: projectID, cwd: cwd, backendId: filter.backend,
            query: query, cursor: cursor, limit: KotlinInt(int: 50), nonInteractive: filter.nonInteractive, refresh: refresh)
    }
    private func reload(refresh: Bool = false) async {
        loading = true; error = nil
        do {
            if !refresh && !query.isEmpty { try await Task.sleep(for: .milliseconds(300)) }
            let result = try await page(cursor: nil, refresh: refresh)
            try Task.checkCancellation()
            items = result.items; failures = result.failures; next = result.nextCursor
        } catch is CancellationError { return } catch { self.error = error.riffetMessage; items = []; next = nil }
        loading = false
    }
    private func loadMore() async {
        guard let cursor = next, !loading, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let started = key
        do {
            let result = try await page(cursor: cursor)
            // A filter that changed while this page was in flight owns the list now.
            guard started == key else { return }
            let known = Set(items.map(\.nativeSessionId))
            items += result.items.filter { !known.contains($0.nativeSessionId) }
            next = result.nextCursor
        } catch is CancellationError {} catch { self.error = error.riffetMessage }
    }
}

private struct ExternalSessionRow: View {
    let workbench: Workbench
    let item: ExternalSession
    let showsDirectory: Bool
    let busy: Bool
    let action: () -> Void
    @Environment(\.palette) private var palette
    private var status: String? {
        if item.live == "terminal" { return String(localized: "终端中", bundle: .riffet) }
        return nil
    }
    private var detail: String {
        var parts: [String] = []
        if showsDirectory { parts.append(item.cwd.split(separator: "/").last.map(String.init) ?? item.cwd) }
        if let branch = item.gitBranch, !branch.isEmpty { parts.append(branch) }
        if let date = ServerTime.date(item.updatedAt) { parts.append(date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated).locale(AppLocalization.shared.locale))) }
        if !item.cwdExists { parts.append(String(localized: "目录已不存在", bundle: .riffet)) }
        return parts.joined(separator: " · ")
    }
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                AgentAvatar(backend: item.backendId, size: 36)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                    Text(detail).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                }
                Spacer(minLength: 8)
                if busy { ProgressView() }
                else if let status { Text(status).riffetFont(.caption).foregroundStyle(palette.fg3) }
            }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

private struct ExternalDirectoryList: View {
    let workbench: Workbench
    @Binding var filter: ExternalFilter
    @State private var query = ""
    @State private var directories: [ExternalSessionDirectory] = []
    @State private var loading = true
    @State private var error: String?
    @State private var retry = 0
    @Environment(\.palette) private var palette
    private var shown: [ExternalSessionDirectory] {
        query.isEmpty ? directories : directories.filter { $0.cwd.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        List {
            RiffetNotice.section(.error, error, actionTitle: String(localized: "重试", bundle: .riffet), action: { retry += 1 })
            ForEach(shown, id: \.cwd) { directory in
                NavigationLink(value: directory.cwd) { row(directory) }
                    .disabled(!directory.exists)
            }
            if loading { HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden) }
            if !loading && error == nil && shown.isEmpty { ContentUnavailableView("没有可导入的会话", systemImage: "terminal") }
        }
        .riffetSearchable(text: $query, prompt: String(localized: "搜索标题与目录", bundle: .riffet))
        .task(id: "\(filter.backend ?? "")|\(filter.nonInteractive)|\(retry)") {
            loading = true; error = nil
            do {
                guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
                let result = try await api.externalSessionDirectories(backendId: filter.backend, nonInteractive: filter.nonInteractive)
                try Task.checkCancellation()
                directories = result
            } catch is CancellationError { return } catch { self.error = error.riffetMessage; directories = [] }
            loading = false
        }
    }

    private func row(_ directory: ExternalSessionDirectory) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "folder").riffetFont(.barTitle).foregroundStyle(palette.fg2).frame(width: 36)
            VStack(alignment: .leading, spacing: 3) {
                Text(workbench.project(directory.projectId)?.name ?? directory.cwd.split(separator: "/").last.map(String.init) ?? directory.cwd)
                    .riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                Text(directory.cwd).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
            }
            Spacer(minLength: 8)
            Text("\(directory.count)").riffetFont(.caption).foregroundStyle(palette.fg3)
        }.padding(.vertical, 4)
    }
}
