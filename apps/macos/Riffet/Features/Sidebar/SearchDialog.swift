import AppKit
import SwiftUI
import RiffetKit

/// The workbench palette: conversations by title or message content, and the workbench's commands
/// (`PaletteCommand`) — under the matching titles, or alone while the query starts with `>` (⇧⌘P).
/// Its query and results stay separate from the navigation sidebar.
struct SearchDialog: View {
    let workbench: Workbench
    let dismiss: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.openSettings) private var openSettings
    @FocusState private var focused: Bool
    @State private var selectedId: String?

    private struct Result: Identifiable {
        let id: String
        let sessionId: String
        let title: String
        let project: String
        let archived: Bool
        let hit: MessageHitRow?
        var command: PaletteCommand? = nil

        init(id: String, sessionId: String, title: String, project: String, archived: Bool, hit: MessageHitRow?) {
            (self.id, self.sessionId, self.title, self.project, self.archived, self.hit) = (id, sessionId, title, project, archived, hit)
        }

        init(_ command: PaletteCommand) {
            (id, sessionId, title, project, archived, hit) = ("command:" + command.id, "", command.title, command.detail, false, nil)
            self.command = command
        }

        var symbol: String { command?.symbol ?? (hit == nil ? "bubble.left" : "text.alignleft") }
    }

    private var needle: String { workbench.sidebar.query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var results: [Result] {
        if workbench.sidebar.searchingCommands {
            let rest = workbench.sidebar.query.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines)
            return PaletteCommand.all(workbench: workbench, openSettings: openSettings).filter { $0.matches(rest) }.map(Result.init)
        }
        let sessions = workbench.list.sessions
        let groups = visibleGroups(projects: workbench.projectList.filter { !$0.isBuiltInQuickChat && !$0.isAssistant }, sessions: sessions, query: "", showArchived: true)
        let names = Dictionary(groups.flatMap { group in group.sessions.map { ($0.id, group.project.name) } }, uniquingKeysWith: { first, _ in first })
        if workbench.sidebar.searchMode == .content && needle.isEmpty { return [] }
        if workbench.sidebar.searchingContent {
            let byId = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            return workbench.sidebar.messageHits.map { hit in
                let session = byId[hit.sessionId]
                return Result(id: hit.id, sessionId: hit.sessionId,
                              title: (session?.title ?? hit.title ?? "").ifEmpty(String(localized: "新会话")),
                              project: names[hit.sessionId] ?? "", archived: session?.archivedAt != nil, hit: hit)
            }
        }
        let query = TitleSearchQuery(needle)
        let matches = sessions.compactMap { session -> (session: Session, score: Int)? in
            guard !needle.isEmpty || session.archivedAt == nil,
                  let score = query.score(session.title) else { return nil }
            return (session, score)
        }.sorted {
            if $0.score != $1.score { return $0.score < $1.score }
            return ($0.session.lastActivityAt ?? $0.session.createdAt) > ($1.session.lastActivityAt ?? $1.session.createdAt)
        }.map(\.session)
        let titles = matches.prefix(needle.isEmpty ? 12 : matches.count).map { session in
            Result(id: session.id, sessionId: session.id, title: session.title.ifEmpty(String(localized: "新会话")),
                   project: names[session.id] ?? "", archived: session.archivedAt != nil, hit: nil)
        }
        guard !needle.isEmpty else { return titles }
        return titles + PaletteCommand.all(workbench: workbench, openSettings: openSettings).filter { $0.matches(needle) }.prefix(8).map(Result.init)
    }

    var body: some View {
        let items = results
        VStack(spacing: 0) {
            input(items)
            PanelRule()
            resultList(items)
            if workbench.sidebar.messageSearchPending || workbench.sidebar.messageSearchError != nil {
                PanelRule()
                footer
            }
        }
        .frame(maxWidth: 720, maxHeight: 600)
        .background(palette.bg)
        .clipShape(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous))
        .background(SearchDismissalAnchor(dismiss: dismiss).allowsHitTesting(false))
        .onAppear {
            selectedId = items.first?.id
            focused = true
            // Opened on commands, the field holds `>`: typing goes after it instead of replacing it.
            guard workbench.sidebar.searchingCommands else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                if let editor = NSApp.keyWindow?.firstResponder as? NSTextView {
                    editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
                }
            }
        }
        .onExitCommand { if !composing { dismiss() } }
        .onChange(of: workbench.sidebar.searchKey) { _, _ in selectedId = results.first?.id }
        .onChange(of: items.map(\.id)) { _, ids in
            if !ids.contains(selectedId ?? "") { selectedId = ids.first }
        }
        .task(id: workbench.sidebar.searchKey) {
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled else { return }
            await workbench.sidebar.search(workbench.sidebar.query)
        }
    }

    /// One line: the query, then where it looks. Esc closes the palette, so it carries no close button.
    private func input(_ items: [Result]) -> some View {
        HStack(spacing: Space.md) {
            // The results' icon column: the query and each title start on the same line.
            Image(icon: "magnifyingglass")
                .font(.riffet(size: S(16)))
                .foregroundStyle(palette.fg3)
                .frame(width: 18)
            TextField(workbench.sidebar.searchMode == .title ? "搜索会话与命令" : "搜索消息内容", text: Bindable(workbench.sidebar).query)
                .textFieldStyle(.plain)
                .font(.riffet(size: S(16)))
                .focused($focused)
                .onSubmit { if !composing { openSelected(items) } }
                .onKeyPress(.downArrow) { guard !composing else { return .ignored }; move(1, in: items); return .handled }
                .onKeyPress(.upArrow) { guard !composing else { return .ignored }; move(-1, in: items); return .handled }
            if !workbench.sidebar.searchingCommands {
                if workbench.sidebar.searchMode == .content {
                    ChoiceMenu(options: scopeOptions) {
                        HStack(spacing: Space.xs) {
                            Text(scopeTitle).lineLimit(1).frame(maxWidth: 180, alignment: .trailing)
                            Image(icon: "chevron.down").font(.riffet(size: S(8), weight: .semibold))
                        }
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.fg3)
                        .frame(height: 28)
                    }
                    .help(scopeTitle)
                    .transition(.opacity)
                }
                SegmentedTrack(selection: Binding(
                    get: { workbench.sidebar.searchMode },
                    set: { workbench.sidebar.searchMode = $0; focused = true }
                ), fontSize: 12) {
                    ForEach(WorkbenchSidebar.SearchMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .accessibilityLabel("搜索范围")
            }
        }
        .padding(.horizontal, Space.lg + Space.xs)
        .frame(height: 56)
        .animation(Motion.standard, value: workbench.sidebar.searchMode)
    }

    private var composing: Bool {
        (NSApp.keyWindow?.firstResponder as? NSTextView)?.hasMarkedText() == true
    }

    private var scopeTitle: String {
        guard let id = workbench.sidebar.searchSessionId else { return String(localized: "全部会话") }
        return workbench.list.sessions.first { $0.id == id }?.title.ifEmpty(String(localized: "新会话")) ?? String(localized: "会话")
    }

    private var scopeOptions: [ChoiceOption] {
        let scope = workbench.sidebar.searchSessionId
        var options = [ChoiceOption(title: String(localized: "全部会话"), selected: scope == nil) {
            workbench.sidebar.searchSessionId = nil
            focused = true
        }]
        if let session = workbench.selected, !workbench.showingHome {
            options.append(ChoiceOption(title: String(localized: "当前会话 · \(session.title.ifEmpty(String(localized: "新会话")))"), selected: scope == session.id) {
                workbench.sidebar.searchSessionId = session.id
                focused = true
            })
        }
        let sessions = workbench.list.sessions.sorted { ($0.lastActivityAt ?? $0.createdAt) > ($1.lastActivityAt ?? $1.createdAt) }
        for session in sessions where session.id != workbench.selected?.id || workbench.showingHome {
            options.append(ChoiceOption(title: session.title.ifEmpty(String(localized: "新会话")), selected: scope == session.id) {
                workbench.sidebar.searchSessionId = session.id
                focused = true
            })
        }
        return options
    }

    private func resultList(_ items: [Result]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if needle.isEmpty && workbench.sidebar.searchMode == .title && !items.isEmpty {
                        Text("最近会话")
                            .font(.riffet(size: S(12), weight: .medium))
                            .foregroundStyle(palette.fg3)
                            .padding(.horizontal, Space.md)
                            .padding(.top, Space.sm)
                            .padding(.bottom, Space.xs)
                    }
                    ForEach(items) { item in
                        resultRow(item)
                            .id(item.id)
                    }
                }
                .padding(Space.sm)
            }
            .overlay {
                if items.isEmpty {
                    VStack(spacing: Space.sm) {
                        if workbench.sidebar.messageSearchPending {
                            Spinner(size: .small)
                        } else if workbench.sidebar.messageSearchError != nil {
                            Image(icon: "wifi.exclamationmark").foregroundStyle(palette.fg3)
                        } else {
                            Image(icon: "magnifyingglass")
                                .font(.riffet(size: S(22), weight: .light))
                                .foregroundStyle(palette.fg4)
                            if !needle.isEmpty || workbench.sidebar.searchMode == .title {
                                Text(needle.isEmpty ? "暂无会话" : "没有匹配的结果")
                                    .font(.riffet(size: S(13)))
                                    .foregroundStyle(palette.fg3)
                            }
                        }
                    }
                }
            }
            .onChange(of: workbench.sidebar.searchKey) { _, _ in
                if let first = items.first { proxy.scrollTo(first.id, anchor: .top) }
            }
            .onChange(of: selectedId) { _, id in
                if let id { proxy.scrollTo(id) }
            }
        }
    }

    private func resultRow(_ item: Result) -> some View {
        Button { open(item) } label: {
            HStack(alignment: .top, spacing: Space.md) {
                Image(icon: item.symbol)
                    .font(.riffet(size: S(14)))
                    .foregroundStyle(palette.fg3)
                    .frame(width: 18, height: 20)
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack(spacing: Space.md) {
                        Text(item.title).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                        if item.archived {
                            Text("已归档").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                        }
                        Spacer(minLength: 0)
                        Text(item.project).font(.riffet(size: S(12))).foregroundStyle(item.command == nil ? palette.fg3 : palette.fg4).lineLimit(1)
                    }
                    if let hit = item.hit {
                        Text(highlighted(hit))
                            .font(.riffet(size: S(12)))
                            .foregroundStyle(palette.fg2)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.md)
            .background(selectedId == item.id ? palette.bgActive : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in if hovering { selectedId = item.id } }
        .accessibilityAddTraits(selectedId == item.id ? .isSelected : [])
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let error = workbench.sidebar.messageSearchError {
                HStack(alignment: .top, spacing: Space.sm) {
                    VStack(alignment: .leading, spacing: Space.xxs) {
                        Text("搜索未完成").foregroundStyle(palette.fg2)
                        Text(error).foregroundStyle(palette.fg3).textSelection(.enabled)
                    }.font(RiffetFont.caption)
                    Spacer()
                    Button("重试") { Task { await workbench.sidebar.search(workbench.sidebar.query) } }.buttonStyle(ChipButtonStyle())
                }.padding(.horizontal, Space.xl).padding(.vertical, Space.sm)
            }
            if workbench.sidebar.messageSearchPending {
                Spinner(size: .mini)
                    .padding(.horizontal, Space.xl)
                    .padding(.vertical, Space.sm)
            }
        }
    }

    private func move(_ offset: Int, in items: [Result]) {
        guard !items.isEmpty else { return }
        let current = items.firstIndex { $0.id == selectedId } ?? (offset > 0 ? -1 : 1)
        selectedId = items[min(max(current + offset, 0), items.count - 1)].id
    }

    private func openSelected(_ items: [Result]) {
        guard let item = items.first(where: { $0.id == selectedId }) ?? items.first else { return }
        open(item)
    }

    private func open(_ item: Result) {
        if let command = item.command {
            dismiss()
            command.run()
            return
        }
        let focus = (item.hit?.sequence).map { TranscriptFocus(sessionId: item.sessionId, sequence: $0) }
        dismiss()
        workbench.open(sessionId: item.sessionId, focus: focus)
    }

    private func highlighted(_ hit: MessageHitRow) -> AttributedString {
        var text = AttributedString(hit.snippet)
        let length = hit.snippet.utf16.count
        for range in hit.highlights {
            let lower = range.lowerBound, upper = range.upperBound
            guard lower >= 0, upper <= length, lower < upper,
                  let start = String.Index(utf16Offset: lower, in: hit.snippet).samePosition(in: hit.snippet),
                  let end = String.Index(utf16Offset: upper, in: hit.snippet).samePosition(in: hit.snippet),
                  let attributedStart = AttributedString.Index(start, within: text),
                  let attributedEnd = AttributedString.Index(end, within: text) else { continue }
            text[attributedStart..<attributedEnd].foregroundColor = palette.fg
            text[attributedStart..<attributedEnd].font = .riffet(size: S(12), weight: .semibold)
        }
        return text
    }
}

/// Consume the outside click before AppKit can send it to the window's toolbar or content.
private struct SearchDismissalAnchor: NSViewRepresentable {
    let dismiss: () -> Void

    func makeNSView(context: Context) -> Anchor {
        let view = Anchor()
        view.dismiss = dismiss
        return view
    }

    func updateNSView(_ view: Anchor, context: Context) { view.dismiss = dismiss }

    static func dismantleNSView(_ view: Anchor, coordinator: ()) { view.stopMonitoring() }

    final class Anchor: NSView {
        var dismiss: (() -> Void)?
        private var monitor: Any?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stopMonitoring()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
                guard let self, let window = self.window, event.window === window,
                      !self.bounds.contains(self.convert(event.locationInWindow, from: nil)) else { return event }
                self.dismiss?()
                return nil
            }
        }

        func stopMonitoring() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}
