import SwiftUI
import RiffetKit

/// A place in a project file that code navigation points at; `line` and `column` are 1-based.
struct CodeLocation: Decodable, Hashable {
    let path: String
    let line: Int
    let column: Int
    let text: String
}

/// The server's search-based code navigation (`workspace/code-nav.ts`), which RiffetKit does not
/// wrap: the same authorized request the file downloads use.
@MainActor
enum CodeNavigation {
    enum Scope: String { case module, project }

    struct References: Decodable {
        let locations: [CodeLocation]
        let complete: Bool
    }

    private struct Definitions: Decodable { let locations: [CodeLocation] }

    static func definitions(projectId: String, path: String, symbol: CodeSymbol) async throws -> [CodeLocation] {
        let result: Definitions = try await get(projectId, "definition", [
            "path": path, "line": String(symbol.line), "column": String(symbol.column), "word": symbol.word,
        ])
        return result.locations
    }

    static func references(projectId: String, path: String, word: String, scope: Scope) async throws -> References {
        try await get(projectId, "references", ["path": path, "word": word, "scope": scope.rawValue])
    }

    private static func get<T: Decodable>(_ projectId: String, _ action: String, _ query: [String: String]) async throws -> T {
        guard let base = AppModel.shared.host.api?.baseUrl,
              var components = URLComponents(string: "\(base)/api/projects/\(projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId)/code/\(action)") else {
            throw URLError(.badURL)
        }
        components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = components.url else { throw URLError(.badURL) }
        let (data, response) = try await URLSession.shared.data(for: ProjectDownloads.authorized(url))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// What the references page lists: a symbol's usages, or the several places it may be declared.
struct CodeUsages {
    var word: String
    var origin: (path: String, line: Int)
    var locations: [CodeLocation] = []
    var searching = true
    var failed = false
}

/// The files viewed last in a project, newest last, as the web keeps them: per project, surviving a
/// restart, the least recently shown giving way past the limit.
@MainActor
@Observable
final class RecentFiles {
    struct Entry: Codable, Equatable { var path: String; var at: Double }

    private static let limit = 12
    private(set) var projectId: String
    private(set) var files: [Entry]

    init(projectId: String) {
        self.projectId = projectId
        files = Self.read(projectId)
    }

    private static func key(_ projectId: String) -> String { "riffet.files.recent.v1.\(projectId)" }

    static func read(_ projectId: String) -> [Entry] {
        guard let data = UserDefaults.standard.data(forKey: key(projectId)),
              let files = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return Array(files.prefix(limit))
    }

    /// Newest first, for lists.
    static func byRecency(_ projectId: String) -> [String] {
        read(projectId).sorted { $0.at > $1.at }.map(\.path)
    }

    var byRecency: [Entry] { files.sorted { $0.at > $1.at } }

    func touch(_ path: String) {
        files = Self.read(projectId)
        let now = Date.now.timeIntervalSince1970
        if let index = files.firstIndex(where: { $0.path == path }) {
            files[index].at = now
        } else {
            files.append(Entry(path: path, at: now))
            if files.count > Self.limit, let oldest = files.enumerated().min(by: { $0.element.at < $1.element.at }) {
                files.remove(at: oldest.offset)
            }
        }
        save()
    }

    func remove(_ path: String) {
        files = Self.read(projectId).filter { $0.path != path }
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(files) { UserDefaults.standard.set(data, forKey: Self.key(projectId)) }
    }
}

/// The recent files as a strip of tabs above the open file.
struct RecentFilesStrip: View {
    let files: [String]
    let active: String?
    let open: (String) -> Void
    let close: (String) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let names = Dictionary(files.map { (($0 as NSString).lastPathComponent, 1) }, uniquingKeysWith: +)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.xxs) {
                ForEach(files, id: \.self) { file in
                    let name = (file as NSString).lastPathComponent
                    let folder = ((file as NSString).deletingLastPathComponent as NSString).lastPathComponent
                    RecentFileTab(
                        title: (names[name] ?? 0) > 1 && !folder.isEmpty ? "\(name) · \(folder)" : name,
                        symbol: FileSymbols.symbol(name), selected: file == active,
                        open: { open(file) }, close: { close(file) }
                    )
                    .help(file)
                }
            }
            .padding(.horizontal, Space.sm)
        }
        .frame(height: 30)
        .overlay(alignment: .bottom) { PanelRule() }
    }
}

private struct RecentFileTab: View {
    let title: String
    let symbol: String
    let selected: Bool
    let open: () -> Void
    let close: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Space.xs) {
            Button(action: open) {
                HStack(spacing: Space.xs + 2) {
                    Image(icon: symbol).font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                    Text(title).font(.riffet(size: S(12))).lineLimit(1)
                }
            }
            .buttonStyle(.plain)
            Button(action: close) { Image(icon: "xmark").font(.riffet(size: S(9), weight: .semibold)) }
                .buttonStyle(.plain)
                .foregroundStyle(palette.fg4)
                .opacity(selected || hovering ? 1 : 0)
                .accessibilityLabel("关闭")
        }
        .foregroundStyle(selected ? palette.fg : palette.fg3)
        .padding(.horizontal, Space.sm)
        .frame(height: 24)
        .background(selected ? palette.bgActive : hovering ? palette.bgHover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .onHover { hovering = $0 }
    }
}

/// A symbol's usages grouped by file, or the choice among its declarations; a row opens the file there.
struct CodeUsagesPage: View {
    let usages: CodeUsages
    let open: (CodeLocation) -> Void
    let back: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let groups = Dictionary(grouping: usages.locations, by: \.path)
        let order = usages.locations.reduce(into: [String]()) { if !$0.contains($1.path) { $0.append($1.path) } }
        VStack(spacing: 0) {
            DetailHeader(title: usages.word, subtitle: usages.locations.isEmpty ? nil : "\(usages.locations.count)", back: back) {
                if usages.searching { Spinner(size: .mini) }
            }
            PanelRule()
            if usages.locations.isEmpty, !usages.searching {
                Text(usages.failed ? "查找用法失败" : "没有找到用法")
                    .font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                    .frame(maxWidth: .infinity).padding(.top, Space.xl)
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(order, id: \.self) { file in
                            Text(file)
                                .font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(palette.fg3)
                                .lineLimit(1).truncationMode(.head)
                                .padding(.horizontal, Space.sm).padding(.top, Space.sm).padding(.bottom, Space.xxs)
                            ForEach(groups[file] ?? [], id: \.self) { location in
                                UsageRow(location: location, word: usages.word) { open(location) }
                            }
                        }
                    }
                    .padding(Space.xs + 2)
                }
            }
        }
    }
}

private struct UsageRow: View {
    let location: CodeLocation
    let word: String
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                Text("\(location.line)")
                    .font(.riffet(size: S(11), design: .monospaced).monospacedDigit()).foregroundStyle(palette.fg4)
                    .frame(width: 36, alignment: .trailing)
                Text(highlighted)
                    .font(.riffet(size: S(12), design: .monospaced)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(HoverRowStyle())
    }

    /// The line, trimmed, with the occurrence at its column set apart.
    private var highlighted: AttributedString {
        let text = location.text as NSString
        let at = location.column - 1
        let found = at >= 0 && at + word.utf16.count <= text.length && text.substring(with: NSRange(location: at, length: word.utf16.count)) == word
        guard found else {
            var plain = AttributedString(location.text.trimmingCharacters(in: .whitespaces))
            plain.foregroundColor = palette.fg2
            return plain
        }
        let leading = text.substring(to: at)
        var before = AttributedString(leading.replacingOccurrences(of: "^\\s+", with: "", options: .regularExpression))
        var match = AttributedString(word)
        var after = AttributedString(text.substring(from: at + word.utf16.count))
        before.foregroundColor = palette.fg2
        match.foregroundColor = palette.fg
        match.backgroundColor = palette.accentSoft
        after.foregroundColor = palette.fg2
        return before + match + after
    }
}
