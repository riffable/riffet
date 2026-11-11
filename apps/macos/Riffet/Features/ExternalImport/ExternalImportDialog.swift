import AppKit
import SwiftUI
import RiffetKit

/// The terminal-session picker (docs/TERMINAL-SESSIONS.md): the palette's shape, listing the provider
/// conversations on the server's machine. Choosing one opens the Riffet conversation that continues it.
struct ExternalImportDialog: View {
    let workbench: Workbench
    let listHeight: CGFloat
    let dismiss: () -> Void
    @Environment(\.palette) private var palette
    @State private var model: ExternalImportModel
    @State private var selectedId: String?
    @FocusState private var focused: Bool

    init(workbench: Workbench, projectId: String?, listHeight: CGFloat, dismiss: @escaping () -> Void) {
        self.workbench = workbench
        self.listHeight = listHeight
        self.dismiss = dismiss
        _model = State(initialValue: ExternalImportModel(projectId: projectId))
    }

    var body: some View {
        let items = model.entries
        VStack(spacing: 0) {
            input(items)
            PanelRule()
            resultList(items)
            if model.importError != nil {
                PanelRule()
                Text(model.importError ?? "")
                    .font(RiffetFont.caption)
                    .foregroundStyle(palette.danger)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Space.xl)
                    .padding(.vertical, Space.sm)
            }
        }
        .frame(maxWidth: 880)
        .background(palette.bg)
        .clipShape(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous))
        .onAppear { focused = true }
        .onExitCommand { if !composing { dismiss() } }
        .onChange(of: items.map(\.id)) { _, ids in
            if !ids.contains(selectedId ?? "") { selectedId = ids.first }
        }
        .onChange(of: model.query) { _, _ in model.importError = nil }
        .task(id: model.key) {
            if !model.query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await model.reload(api: workbench.host.api)
        }
    }

    private var composing: Bool {
        (NSApp.keyWindow?.firstResponder as? NSTextView)?.hasMarkedText() == true
    }

    /// One line: the way back, the query, then where it looks and how it filters.
    private func input(_ items: [ExternalImportEntry]) -> some View {
        HStack(spacing: Space.md) {
            if model.directory != nil {
                Button { model.leaveDirectory() } label: { Image(icon: "chevron.left") }
                    .buttonStyle(IconButtonStyle(size: 24))
                    .accessibilityLabel("返回")
            } else {
                Image(icon: "magnifyingglass")
                    .font(.riffet(size: S(16)))
                    .foregroundStyle(palette.fg3)
                    .frame(width: 18)
            }
            TextField(model.directory.map { ($0 as NSString).lastPathComponent } ?? String(localized: "搜索终端会话"), text: $model.query)
                .textFieldStyle(.plain)
                .font(.riffet(size: S(16)))
                .focused($focused)
                .onSubmit { if !composing { openSelected(items) } }
                .onKeyPress(.downArrow) { guard !composing else { return .ignored }; move(1, in: items); return .handled }
                .onKeyPress(.upArrow) { guard !composing else { return .ignored }; move(-1, in: items); return .handled }
                .onKeyPress(.delete) {
                    guard !composing, model.directory != nil, model.query.isEmpty else { return .ignored }
                    model.leaveDirectory()
                    return .handled
                }
            ChoiceMenu(options: filterOptions) {
                Image(icon: "line.3.horizontal.decrease")
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(model.agent != nil || model.nonInteractive ? palette.fg : palette.fg3)
                    .frame(width: 28, height: 28)
            }
            .accessibilityLabel("筛选")
            SegmentedTrack(selection: Binding(
                get: { model.scope },
                set: { model.scope = $0; model.directory = nil; focused = true }
            ), fontSize: 12) {
                if model.projectId != nil { Text("当前项目").tag(ExternalImportScope.project) }
                Text("目录").tag(ExternalImportScope.directory)
                Text("全部").tag(ExternalImportScope.all)
            }
            .accessibilityLabel("范围")
        }
        .padding(.horizontal, Space.lg + Space.xs)
        .frame(height: 56)
    }

    private var filterOptions: [ChoiceOption] {
        var options = [ChoiceOption(title: String(localized: "全部"), selected: model.agent == nil) { model.agent = nil }]
        for id in ["claude", "codex"] {
            options.append(ChoiceOption(title: backendLabel(id), selected: model.agent == id) { model.agent = id })
        }
        options.append(ChoiceOption(title: String(localized: "含非交互"), selected: model.nonInteractive) { model.nonInteractive.toggle() })
        return options
    }

    private func resultList(_ items: [ExternalImportEntry]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.failures, id: \.backendId) { failure in
                        Text(verbatim: backendLabel(failure.backendId) + " · " + failure.message)
                            .font(RiffetFont.caption)
                            .foregroundStyle(palette.fg4)
                            .lineLimit(2)
                            .padding(.horizontal, Space.md)
                            .padding(.vertical, Space.xs)
                    }
                    ForEach(items) { item in
                        row(item).id(item.id)
                    }
                    if model.nextCursor != nil {
                        Color.clear.frame(height: 1)
                            .onAppear { Task { await model.loadMore(api: workbench.host.api) } }
                    }
                    if model.loadingMore {
                        Spinner(size: .mini).frame(maxWidth: .infinity).padding(Space.sm)
                    }
                }
                .padding(Space.sm)
            }
            .overlay {
                if items.isEmpty {
                    VStack(spacing: Space.sm) {
                        if model.loading {
                            Spinner(size: .small)
                        } else if let error = model.error {
                            Image(icon: "wifi.exclamationmark").foregroundStyle(palette.fg3)
                            Text(error).font(RiffetFont.caption).foregroundStyle(palette.fg3).textSelection(.enabled)
                        } else {
                            Image(icon: "magnifyingglass")
                                .font(.riffet(size: S(22), weight: .light))
                                .foregroundStyle(palette.fg4)
                            Text("没有匹配的结果").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                        }
                    }
                    .padding(Space.xl)
                }
            }
            .onChange(of: model.key) { _, _ in
                if let first = items.first { proxy.scrollTo(first.id, anchor: .top) }
            }
            .onChange(of: selectedId) { _, id in
                if let id { proxy.scrollTo(id) }
            }
        }
        .frame(height: listHeight)
    }

    private func row(_ entry: ExternalImportEntry) -> some View {
        Button { choose(entry) } label: {
            HStack(spacing: Space.md) {
                switch entry {
                case .directory:
                    Image(icon: "folder")
                        .font(.riffet(size: S(14)))
                        .foregroundStyle(palette.fg3)
                        .frame(width: 18)
                case .session(let item):
                    AgentIcon(id: item.backendId, size: 14, color: agentMarkColor(item.backendId, palette) ?? palette.fg3)
                        .frame(width: 18)
                }
                content(entry)
            }
            .padding(.horizontal, Space.md)
            .frame(height: 34)
            .background(selectedId == entry.id ? palette.bgActive : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .contentShape(Rectangle())
            .opacity(entry.disabled ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(entry.disabled || model.importing != nil)
        .onHover { hovering in if hovering, !entry.disabled { selectedId = entry.id } }
        .accessibilityAddTraits(selectedId == entry.id ? .isSelected : [])
    }

    /// One line per entry, so a screen holds a long stretch of history.
    @ViewBuilder
    private func content(_ entry: ExternalImportEntry) -> some View {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        switch entry {
        case .directory(let directory):
            Text((directory.cwd as NSString).lastPathComponent.ifEmpty(directory.cwd))
                .font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                .layoutPriority(1)
            Text(abbreviated(directory.cwd))
                .font(.riffet(size: S(12))).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(verbatim: String(directory.count)).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
            Text(relativeLabel(value: directory.updatedAt, now: now) ?? "")
                .font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                .frame(width: 56, alignment: .trailing)
        case .session(let item):
            let showsDirectory = model.scope != .project && model.directory == nil
            Text(item.title.ifEmpty(String(localized: "新会话")))
                .font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                .layoutPriority(1)
            HStack(spacing: Space.sm) {
                if showsDirectory { Text(abbreviated(item.cwd)).lineLimit(1).truncationMode(.head) }
                if let branch = item.gitBranch {
                    Text(branch).font(.riffet(size: S(11), design: .monospaced)).lineLimit(1).foregroundStyle(palette.fg4)
                }
            }
            .font(.riffet(size: S(12)))
            .foregroundStyle(palette.fg3)
            .frame(maxWidth: .infinity, alignment: .leading)
            if model.importing == entry.id {
                Spinner(size: .mini)
            } else if item.live == "terminal" {
                Text("终端中").font(.riffet(size: S(11))).foregroundStyle(palette.warning)
            }
            Text(relativeLabel(value: item.updatedAt, now: now) ?? "")
                .font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                .frame(width: 56, alignment: .trailing)
        }
    }

    private func abbreviated(_ path: String) -> String { (path as NSString).abbreviatingWithTildeInPath }

    private func move(_ offset: Int, in items: [ExternalImportEntry]) {
        let enabled = items.filter { !$0.disabled }
        guard !enabled.isEmpty else { return }
        let current = enabled.firstIndex { $0.id == selectedId } ?? (offset > 0 ? -1 : 1)
        selectedId = enabled[min(max(current + offset, 0), enabled.count - 1)].id
    }

    private func openSelected(_ items: [ExternalImportEntry]) {
        guard let entry = items.first(where: { $0.id == selectedId }) ?? items.first(where: { !$0.disabled }) else { return }
        choose(entry)
    }

    private func choose(_ entry: ExternalImportEntry) {
        guard !entry.disabled else { return }
        switch entry {
        case .directory(let directory):
            model.enter(directory)
        case .session(let item):
            Task { if await model.open(item, workbench: workbench) { dismiss() } }
        }
    }
}
