import AppKit
import SwiftUI
import RiffetKit

extension Notification.Name {
    /// Opens the quick open overlay of the `Workbench` in `object` (⌘P).
    static let riffetQuickOpen = Notification.Name("riffet.quick-open")
}

/// ⌘P: a file of the open conversation's project by name, the recent ones first. It looks like the
/// command palette and is separate from it; a pick opens the file in the file panel.
struct QuickOpenOverlay: ViewModifier {
    let workbench: Workbench
    @State private var project: Project?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: .riffetQuickOpen)) { note in
                guard note.targets(workbench), let current = workbench.currentProject else { return }
                project = current
            }
            .overlay {
                ZStack {
                    if let project {
                        Color.black.opacity(0.14)
                            .ignoresSafeArea()
                            .onTapGesture { self.project = nil }
                            .transition(.opacity)
                        QuickOpenDialog(workbench: workbench, project: project, dismiss: { self.project = nil })
                            .clipShape(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous))
                            .elevation(.pop)
                            .padding(Space.xl)
                            .transition(.opacity.combined(with: .offset(y: -8)))
                    }
                }
                .animation(reduceMotion ? nil : Motion.expressive, value: project?.id) // perf-lint: allow only the overlay's own panel and scrim move; the window's layout is untouched
            }
    }
}

private struct QuickOpenDialog: View {
    let workbench: Workbench
    let project: Project
    let dismiss: () -> Void
    @Environment(\.palette) private var palette
    @FocusState private var focused: Bool
    @State private var query = ""
    @State private var found: [FileEntry] = []
    @State private var selected: String?
    @State private var searching = false

    private struct Row: Identifiable {
        let path: String
        let directory: Bool
        var id: String { path }
    }

    private var needle: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The recent files that match come first, then the project's other matches in the server's order.
    private var rows: [Row] {
        let recent = RecentFiles.byRecency(project.id)
        guard !needle.isEmpty else { return recent.map { Row(path: $0, directory: false) } }
        let matching = recent.filter { Self.matches($0, needle) }
        let rest = found.filter { !matching.contains($0.path) }.map { Row(path: $0.path, directory: $0.kind == .directory) }
        return matching.map { Row(path: $0, directory: false) } + rest
    }

    /// The query's characters in order within the path, ignoring case.
    private static func matches(_ path: String, _ needle: String) -> Bool {
        var rest = path.lowercased()[...]
        for character in needle.lowercased() where !character.isWhitespace {
            guard let index = rest.firstIndex(of: character) else { return false }
            rest = rest[rest.index(after: index)...]
        }
        return true
    }

    var body: some View {
        let items = rows
        VStack(spacing: 0) {
            HStack(spacing: Space.md) {
                Image(icon: "magnifyingglass").font(.riffet(size: S(16))).foregroundStyle(palette.fg3).frame(width: 18)
                TextField("按文件名查找", text: $query)
                    .textFieldStyle(.plain)
                    .font(.riffet(size: S(16)))
                    .focused($focused)
                    .onSubmit { if !composing { openSelected(items) } }
                    .onKeyPress(.downArrow) { guard !composing else { return .ignored }; move(1, in: items); return .handled }
                    .onKeyPress(.upArrow) { guard !composing else { return .ignored }; move(-1, in: items); return .handled }
                if searching { Spinner(size: .mini) }
            }
            .padding(.horizontal, Space.lg + Space.xs)
            .frame(height: 56)
            PanelRule()
            list(items)
        }
        .frame(maxWidth: 560, maxHeight: 420)
        .background(palette.bg)
        .onAppear { selected = items.first?.id; focused = true }
        .onExitCommand { if !composing { dismiss() } }
        .onChange(of: items.map(\.id)) { _, ids in if !ids.contains(selected ?? "") { selected = ids.first } }
        .task(id: needle) {
            guard !needle.isEmpty else { found = []; searching = false; return }
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let api = workbench.host.api else { return }
            searching = true
            defer { if !Task.isCancelled { searching = false } }
            if let result = try? await api.find(projectId: project.id, query: needle), !Task.isCancelled { found = result }
        }
    }

    private var composing: Bool {
        (NSApp.keyWindow?.firstResponder as? NSTextView)?.hasMarkedText() == true
    }

    private func list(_ items: [Row]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if needle.isEmpty, !items.isEmpty {
                        Text("最近查看")
                            .font(.riffet(size: S(12), weight: .medium))
                            .foregroundStyle(palette.fg3)
                            .padding(.horizontal, Space.md)
                            .padding(.top, Space.sm)
                            .padding(.bottom, Space.xs)
                    }
                    ForEach(items) { row($0) }
                }
                .padding(Space.sm)
            }
            .overlay {
                if items.isEmpty, !needle.isEmpty, !searching {
                    Text("没有找到匹配的文件").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                }
            }
            .onChange(of: selected) { _, id in if let id { proxy.scrollTo(id) } }
        }
    }

    private func row(_ item: Row) -> some View {
        let name = (item.path as NSString).lastPathComponent
        let directory = (item.path as NSString).deletingLastPathComponent
        return Button { open(item) } label: {
            HStack(spacing: Space.md) {
                Image(icon: item.directory ? "folder" : FileSymbols.symbol(name))
                    .font(.riffet(size: S(14)))
                    .foregroundStyle(palette.fg3)
                    .frame(width: 18)
                Text(name).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                Spacer(minLength: 0)
                Text(directory).font(.riffet(size: S(12))).foregroundStyle(palette.fg4).lineLimit(1).truncationMode(.head)
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm + 2)
            .background(selected == item.id ? palette.bgActive : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { if $0 { selected = item.id } }
        .accessibilityAddTraits(selected == item.id ? .isSelected : [])
    }

    private func move(_ offset: Int, in items: [Row]) {
        guard !items.isEmpty else { return }
        let current = items.firstIndex { $0.id == selected } ?? (offset > 0 ? -1 : 1)
        selected = items[min(max(current + offset, 0), items.count - 1)].id
    }

    private func openSelected(_ items: [Row]) {
        guard let item = items.first(where: { $0.id == selected }) ?? items.first else { return }
        open(item)
    }

    private func open(_ item: Row) {
        dismiss()
        workbench.preview(path: item.path)
    }
}
