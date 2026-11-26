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
        // The full-width ＠ too: a Chinese keyboard types it in place of @.
        guard let range = text.range(of: #"(?:^|\s)[/@＠][^\s]*$"#, options: .regularExpression) else { return nil }
        let token = text[range]
        guard let sigil = token.firstIndex(where: { $0 == "/" || $0 == "@" || $0 == "＠" }) else { return nil }
        let kind: Kind = token[sigil] == "/" ? .slash : .mention
        let query = String(token[token.index(after: sigil)...])
        // A second `@` inside the word is not a mention; a path after a slash is part of the query.
        if kind == .mention, query.contains("@") || query.contains("＠") { return nil }
        return ComposerMenuToken(kind: kind, query: query, anchor: text.distance(from: text.startIndex, to: sigil))
    }

    /// The draft up to the token, which stays behind with the whitespace before it.
    func remaining(from text: String) -> String {
        guard anchor <= text.count else { return text }
        return String(text[..<text.index(text.startIndex, offsetBy: anchor)])
    }
}

/// Where a docked menu reads its rows: a conversation's, or a new task's agent and project.
struct ComposerMenuSource {
    /// Changes when the commands would differ (another conversation, agent or provider).
    let key: String
    let projectID: String
    /// The conversation the draft belongs to, left out of the sessions it can cite.
    var sessionID: String?
    let commands: @MainActor () async throws -> [NativeSlashItem]

    @MainActor static func session(_ session: Session, workbench: Workbench) -> ComposerMenuSource {
        ComposerMenuSource(key: session.id, projectID: session.projectId, sessionID: session.id) {
            try await workbench.store.slashCatalog(session: session).items
        }
    }
}

/// The docked list for `/` (commands and skills) and `@` (sessions, project files): at most five rows
/// show and it scrolls. Its data is read the way the sheets read it.
struct ComposerMenuDock: View {
    let workbench: Workbench
    let source: ComposerMenuSource
    @Bindable var draft: MessageDraft
    let token: ComposerMenuToken
    let allowsFiles: Bool
    let allowsSessions: Bool
    let picked: () -> Void
    /// The members and Agents `@` can name; nil where the server has no team members.
    var mentions: MentionOptions? = nil
    @State private var slash: [NativeSlashItem]?
    @State private var files: [FileEntry] = []
    @State private var loading = true
    @State private var error: String?
    @State private var retry = 0
    @Environment(\.palette) private var palette

    private enum Row: Identifiable {
        case command(NativeSlashItem), file(FileEntry), session(Session)
        case header(String), member(AgentMember), agent(NativeBackendCatalogEntry)
        var id: String {
            switch self {
            case let .header(title): "h:" + title
            case let .member(member): "m:" + member.id
            case let .agent(entry): "a:" + entry.backendId.name
            case let .command(item): "c:" + item.name
            case let .file(file): "f:" + file.path
            case let .session(session): "s:" + session.id
            }
        }
    }
    private var rows: [Row] {
        switch token.kind {
        case .slash:
            return rankSlashItems(items: slash ?? [], query: token.query, limit: 200).map(Row.command)
        case .mention:
            var result: [Row] = []
            if let mentions {
                let query = token.query.lowercased()
                let members = mentions.members.filter { query.isEmpty || $0.name.lowercased().contains(query) }
                let agents = mentions.agents.filter { query.isEmpty || $0.label.lowercased().contains(query) }
                if !members.isEmpty { result.append(.header(String(localized: "成员", bundle: .riffet))); result += members.map(Row.member) }
                if !agents.isEmpty { result.append(.header("Agent")); result += agents.map(Row.agent) }
            }
            if allowsSessions {
                result += rankedSessionReferences(sessions: workbench.list.sessions, projects: workbench.list.projects, query: token.query,
                                                  currentSessionId: source.sessionID, projectId: source.projectID).prefix(3).map(Row.session)
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
        .task(id: "\(source.key)|\(token.kind == .slash)|\(retry)") {
            guard token.kind == .slash else { return }
            loading = true; error = nil; slash = nil
            do {
                let loaded = try await source.commands()
                try Task.checkCancellation(); slash = loaded
            } catch is CancellationError { return }
            catch { self.error = error.riffetMessage }
            loading = false
        }
        .task(id: "\(source.projectID)|\(token.kind == .mention)|\(allowsFiles)|\(token.kind == .mention ? token.query : "")|\(retry)") {
            guard token.kind == .mention else { return }
            // A bare @ lists sessions only; files are searched once there is something to search for.
            guard allowsFiles, !token.query.isEmpty else { files = []; error = nil; loading = false; return }
            loading = true; error = nil // the last results stay while the next query answers
            do {
                try await Task.sleep(for: .milliseconds(200))
                guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
                let result = try await api.find(projectId: source.projectID, query: token.query)
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
                if case let .header(title) = row {
                    Text(title).riffetFont(.caption).foregroundStyle(palette.fg3).padding(.horizontal, RiffetMetrics.groupInset)
                        .frame(maxWidth: .infinity, minHeight: 28, alignment: .bottomLeading)
                } else {
                Button { pick(row) } label: { label(row).padding(.horizontal, RiffetMetrics.groupInset).frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget, alignment: .leading).contentShape(Rectangle()) }
                    .buttonStyle(RiffetDimPressStyle())
                }
            }
        }
    }

    @ViewBuilder private func label(_ row: Row) -> some View {
        switch row {
        case .header: EmptyView()
        case let .member(member):
            HStack(spacing: 10) {
                MemberAvatarView(workbench: workbench, member: member, size: 26)
                Text(member.name).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg).lineLimit(1)
                if let project = workbench.boundProjectName(member) { Text(project).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
            }
        case let .agent(entry):
            HStack(spacing: 10) {
                AgentMarkView(backend: entry.backendId.name.lowercased(), size: 18, color: agentMarkColor(entry.backendId.name.lowercased(), palette)).frame(width: 26, height: 26)
                Text(entry.label).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg).lineLimit(1)
            }
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
                Label { Text(selected.shownTitle).riffetFont(.label, weight: .regular).lineLimit(1) } icon: { Image(systemName: "text.bubble") }.foregroundStyle(palette.fg)
                Text([workbench.list.projects.first(where: { $0.id == selected.projectId })?.name, selected.agent].compactMap { $0 }.joined(separator: " · "))
                    .riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
            }
        }
    }

    private func pick(_ row: Row) {
        let before = token.remaining(from: draft.text)
        switch row {
        case .header: return
        case let .member(member):
            guard let mentions else { return }
            insertMention(mentions.mention(member), before: before)
        case let .agent(entry):
            guard let mentions else { return }
            insertMention(mentions.mention(entry), before: before)
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

    /// `@name ` takes the token's place, and the mention is kept to be sent with the message.
    private func insertMention(_ mention: AgentMention, before: String) {
        guard let label = mention.label else { return }
        draft.text = before + "@" + label + " "
        draft.mentions.removeAll { $0.label == label }
        draft.mentions.append(mention)
        picked()
    }
}

