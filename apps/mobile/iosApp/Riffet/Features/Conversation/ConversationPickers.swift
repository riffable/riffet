import SwiftUI
import RiffetKit

/// The `/` or `@` token the reader is typing at the end of the draft: the menu docked above the composer
/// lists what fits it and closes when the token goes.
struct ComposerMenuToken: Equatable {
    enum Kind { case slash, mention }
    let kind: Kind
    /// What follows the sigil.
    let query: String
    /// Where the sigil is in the draft, in characters; the same place is the same token as it is typed on.
    let anchor: Int

    struct Key: Equatable { let kind: Kind; let anchor: Int }
    var key: Key { Key(kind: kind, anchor: anchor) }

    static func detect(in text: String) -> ComposerMenuToken? {
        guard let range = text.range(of: #"(?:^|\s)[/@][^\s]*$"#, options: .regularExpression) else { return nil }
        let token = text[range]
        guard let sigil = token.firstIndex(where: { $0 == "/" || $0 == "@" }) else { return nil }
        let kind: Kind = token[sigil] == "/" ? .slash : .mention
        let query = String(token[token.index(after: sigil)...])
        // A second `@` inside the word is not a mention; a path after a slash is part of the query.
        if kind == .mention, query.contains("@") { return nil }
        return ComposerMenuToken(kind: kind, query: query, anchor: text.distance(from: text.startIndex, to: sigil))
    }

    /// The draft up to the token, which stays behind with the whitespace before it.
    func remaining(from text: String) -> String {
        guard anchor <= text.count else { return text }
        return String(text[..<text.index(text.startIndex, offsetBy: anchor)])
    }
}

/// The docked list for `/` (commands and skills) and `@` (sessions, project files): at most five rows
/// show and it scrolls. Its data is read the way the sheets read it.
struct ComposerMenuDock: View {
    let workbench: Workbench
    let session: Session
    @Bindable var draft: MessageDraft
    let token: ComposerMenuToken
    let allowsFiles: Bool
    let allowsSessions: Bool
    let picked: () -> Void
    @State private var slash: NativeSlashCatalog?
    @State private var files: [FileEntry] = []
    @State private var loading = true
    @State private var error: String?
    @State private var retry = 0
    @Environment(\.palette) private var palette

    private enum Row: Identifiable {
        case command(NativeSlashItem), file(FileEntry), session(Session)
        var id: String {
            switch self {
            case let .command(item): "c:" + item.name
            case let .file(file): "f:" + file.path
            case let .session(session): "s:" + session.id
            }
        }
    }
    private var rows: [Row] {
        switch token.kind {
        case .slash:
            return rankSlashItems(items: slash?.items ?? [], query: token.query, limit: 200).map(Row.command)
        case .mention:
            var result: [Row] = []
            if allowsSessions {
                result += rankedSessionReferences(sessions: workbench.list.sessions, projects: workbench.list.projects, query: token.query,
                                                  currentSessionId: session.id, projectId: session.projectId).prefix(3).map(Row.session)
            }
            if allowsFiles { result += files.filter { $0.kind == .file }.map(Row.file) }
            return result
        }
    }

    var body: some View {
        let rows = rows
        Group {
            if let error {
                HStack(spacing: 8) {
                    Text(error).riffetFont(.caption).foregroundStyle(palette.danger).lineLimit(2)
                    Spacer(minLength: 0)
                    Button("重试") { retry += 1 }.riffetFont(.label).foregroundStyle(palette.accent).frame(minHeight: RiffetMetrics.hitTarget)
                }.padding(.horizontal, RiffetMetrics.groupInset).dockSurface()
            } else if rows.isEmpty {
                if loading {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget).dockSurface()
                }
            } else {
                ViewThatFits(in: .vertical) {
                    list(rows)
                    ScrollView { list(rows) }.frame(maxHeight: RiffetMetrics.hitTarget * 5)
                }.dockSurface()
            }
        }
        .task(id: "\(session.id)|\(token.kind == .slash)|\(retry)") {
            guard token.kind == .slash else { return }
            loading = true; error = nil; slash = nil
            do {
                let loaded = try await workbench.store.slashCatalog(session: session)
                try Task.checkCancellation(); slash = loaded
            } catch is CancellationError { return }
            catch { self.error = error.riffetMessage }
            loading = false
        }
        .task(id: "\(session.projectId)|\(token.kind == .mention)|\(allowsFiles)|\(token.kind == .mention ? token.query : "")|\(retry)") {
            guard token.kind == .mention else { return }
            guard allowsFiles else { loading = false; return }
            loading = true; error = nil // the last results stay while the next query answers
            do {
                try await Task.sleep(for: .milliseconds(200))
                guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
                let result = try await api.find(projectId: session.projectId, query: token.query)
                try Task.checkCancellation()
                files = result
            } catch is CancellationError {} catch { self.error = error.riffetMessage; files = [] }
            if !Task.isCancelled { loading = false }
        }
        .accessibilityIdentifier("composerMenu")
    }

    private func list(_ rows: [Row]) -> some View {
        VStack(spacing: 0) {
            ForEach(rows) { row in
                Button { pick(row) } label: { label(row).padding(.horizontal, RiffetMetrics.groupInset).frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget, alignment: .leading).contentShape(Rectangle()) }
                    .buttonStyle(RiffetDimPressStyle())
            }
        }
    }

    @ViewBuilder private func label(_ row: Row) -> some View {
        switch row {
        case let .command(item):
            VStack(alignment: .leading, spacing: 2) {
                Text("/" + item.name).riffetFont(.mono).foregroundStyle(palette.fg).lineLimit(1)
                if let detail = item.description_ { Text(detail).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
            }
        case let .file(file):
            Label { Text(file.path).riffetFont(.label, weight: .regular).lineLimit(1).truncationMode(.head) } icon: { Image(systemName: "doc.text") }
                .foregroundStyle(palette.fg)
        case let .session(selected):
            VStack(alignment: .leading, spacing: 2) {
                Label { Text(selected.title).riffetFont(.label, weight: .regular).lineLimit(1) } icon: { Image(systemName: "text.bubble") }.foregroundStyle(palette.fg)
                Text([workbench.list.projects.first(where: { $0.id == selected.projectId })?.name, selected.agent].compactMap { $0 }.joined(separator: " · "))
                    .riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
            }
        }
    }

    private func pick(_ row: Row) {
        let before = token.remaining(from: draft.text)
        switch row {
        case let .command(item):
            if before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft.text = "/" + item.name + " " }
            else if item.isSkill { draft.text = before + "/" + item.name + " " }
            else { draft.text = "/" + item.name + " " + before.trimmingCharacters(in: .whitespaces) }
        case let .file(file):
            draft.text = before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : before
            if !draft.references.contains(where: { $0.path == file.path && $0.line == nil }) {
                draft.references.append(PromptContextReference(path: file.path, line: nil, kind: nil, sessionId: nil, fromRunId: nil, title: nil))
            }
        case let .session(selected):
            guard draft.references.filter({ $0.kind == "session" }).count < 5 else {
                draft.error = String(localized: "最多引用 5 个会话", bundle: .riffet); return
            }
            draft.text = before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : before
            if !draft.references.contains(where: { $0.sessionId == selected.id }) { draft.references.append(sessionReference(session: selected)) }
        }
        picked()
    }
}

struct ConversationReferencePicker: View {
    let workbench: Workbench
    let projectID: String
    let picked: (FileEntry) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var files: [FileEntry] = []
    @State private var error: String?
    @State private var loading = false
    @State private var retry = 0
    @Environment(\.palette) private var palette
    var body: some View {
        NavigationStack {
            List {
                RiffetNotice.section(.error, error, actionTitle: String(localized: "重试", bundle: .riffet)) { retry += 1 }
                if loading, files.isEmpty { ProgressView().frame(maxWidth: .infinity) }
                ForEach(files.filter { $0.kind == .file }, id: \.path) { file in Button { picked(file) } label: { Label(file.path, systemImage: "doc.text").foregroundStyle(palette.fg).frame(minHeight: 36) } }
                if !loading && files.isEmpty && error == nil {
                    if query.isEmpty { ContentUnavailableView("搜索项目中的文件", systemImage: "doc.text.magnifyingglass") }
                    else { ContentUnavailableView.search(text: query) }
                }
            }.searchable(text: $query, prompt: String(localized: "文件名或路径", bundle: .riffet)).navigationTitle(String(localized: "引用项目文件", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .task(id: "\(projectID)|\(query)|\(retry)") {
                    loading = true; error = nil // the last results stay while the next query answers
                    do {
                        try await Task.sleep(for: .milliseconds(200))
                        guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
                        let result = try await api.find(projectId: projectID, query: query)
                        try Task.checkCancellation()
                        files = result
                    } catch is CancellationError {} catch { self.error = error.riffetMessage; files = [] }
                    if !Task.isCancelled { loading = false }
                }
        }
    }
}

struct ConversationSessionReferencePicker: View {
    let workbench: Workbench
    let currentSessionID: String?
    let projectID: String?
    let picked: (Session) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @Environment(\.palette) private var palette
    private var candidates: [Session] {
        rankedSessionReferences(sessions: workbench.list.sessions, projects: workbench.list.projects, query: query,
            currentSessionId: currentSessionID, projectId: projectID)
    }
    var body: some View {
        NavigationStack {
            List(candidates, id: \.id) { session in
                Button { picked(session) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.title).foregroundStyle(palette.fg)
                        Text([workbench.list.projects.first(where: { $0.id == session.projectId })?.name, session.agent]
                            .compactMap { $0 }.joined(separator: " · "))
                            .riffetFont(.caption).foregroundStyle(palette.fg3)
                    }
                }
            }
            .searchable(text: $query)
            .navigationTitle(String(localized: "引用会话", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
