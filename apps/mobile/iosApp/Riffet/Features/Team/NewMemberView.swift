import SwiftUI
import RiffetKit

/// 新建成员 (mobile.md §2.3, §9.12): an edit page in a sheet. Capabilities and the daily run limit take the scope's
/// defaults and are changed on the web.
struct NewMemberView: View {
    let workbench: Workbench
    /// Opens the member that was made.
    let onCreated: (String) -> Void
    @State private var emoji = NewMemberView.emojis[0]
    @State private var name = ""
    @State private var instructions = ""
    @State private var scope = "personal"
    @State private var projectID: String?
    @State private var sessionMode = "continuous"
    /// The reader chose the session mode; until then it follows the scope.
    @State private var modeChosen = false
    @State private var projects = false
    @State private var modelPanel = false
    @State private var catalog: NativeBackendCatalogEntry?
    @State private var loading = false
    @State private var catalogError: String?
    @State private var error: String?
    @Environment(\.palette) private var palette

    private static let avatarSide: CGFloat = 80
    private static let emojis = ["🙂", "🧪", "📦", "📈", "📚", "🛠️", "🧭", "🔍", "✍️", "🎯", "🧠", "🌱"]

    /// The Agent and model picks, held apart from any conversation's draft.
    private var draft: MessageDraft { workbench.drafts.draft("team.new-member") }
    private var offered: [NativeBackendCatalogEntry] { workbench.memberBackends }
    private var backend: NativeBackendId {
        offered.first { $0.backendId.name == draft.backendName }?.backendId ?? offered.first { $0.available }?.backendId ?? offered.first?.backendId ?? .claude
    }
    /// Models are read in a project: the chosen one, else the assistant's own.
    private var contextProject: String? { scope == "project" ? projectID : workbench.assistantProject?.id }
    private var contextKey: String { "\(backend.name)|\(draft.profileID ?? "")|\(contextProject ?? "")|\(workbench.list.backendRevision)" }
    private var canCreate: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (scope != "project" || projectID != nil) }

    var body: some View {
        RiffetEditPage(title: String(localized: "新建成员", bundle: .riffet), saveTitle: String(localized: "创建", bundle: .riffet),
                       dirty: !name.isEmpty, canSave: canCreate, save: create) {
            Section {
                HStack {
                    Spacer()
                    Menu {
                        ForEach(Self.emojis, id: \.self) { value in Button(value) { emoji = value } }
                    } label: {
                        Text(emoji).font(.system(size: Self.avatarSide / 2)).frame(width: Self.avatarSide, height: Self.avatarSide).background(Circle().fill(palette.bgActive)).contentShape(Circle())
                    }.accessibilityLabel(String(localized: "头像", bundle: .riffet))
                    Spacer()
                }
                .listRowBackground(Color.clear)
            }
            Section { RiffetField(prompt: String(localized: "名称", bundle: .riffet), text: $name) }
            Section {
                RiffetField(prompt: String(localized: "职责", bundle: .riffet), text: $instructions, axis: .vertical)
                    .lineLimit(3...10)
            } footer: { Text(String(localized: "写进它的 AGENTS.md", bundle: .riffet)).riffetFont(.caption).foregroundStyle(palette.fg3) }
            Section {
                Picker(String(localized: "范围", bundle: .riffet), selection: $scope) {
                    Text(String(localized: "个人", bundle: .riffet)).tag("personal")
                    Text(String(localized: "项目", bundle: .riffet)).tag("project")
                    Text(String(localized: "全局", bundle: .riffet)).tag("global")
                }.pickerStyle(.menu)
                if scope == "project" {
                    Button { projects = true } label: {
                        SettingsRowLabel(title: String(localized: "项目", bundle: .riffet), value: workbench.project(projectID)?.name).contentShape(Rectangle())
                    }.buttonStyle(RiffetRowPressStyle())
                }
                Picker(String(localized: "会话", bundle: .riffet), selection: Binding(get: { sessionMode }, set: { sessionMode = $0; modeChosen = true })) {
                    Text(String(localized: "连续对话", bundle: .riffet)).tag("continuous")
                    Text(String(localized: "每次新建", bundle: .riffet)).tag("fresh")
                }.pickerStyle(.menu)
                Button { modelPanel = true } label: {
                    SettingsRowLabel(title: "Agent", value: NativeConfigurationSummary.shortModel(catalog: catalog, selection: draft.model)).contentShape(Rectangle())
                }.buttonStyle(RiffetRowPressStyle())
            } footer: { Text(String(localized: "能力和每日运行上限在 Web 上改", bundle: .riffet)).riffetFont(.caption).foregroundStyle(palette.fg3) }
            if let error { RiffetNotice.section(.error, error) }
        }
        .sheet(isPresented: $projects) {
            ProjectSheet(workbench: workbench, selection: projectID) { if let picked = $0 { projectID = picked.id } }
        }
        .riffetPanelSheet(isPresented: $modelPanel) {
            NewTaskModelPanel(workbench: workbench, draft: draft, catalog: catalog, backend: backend, loading: loading, error: catalogError,
                              retry: { Task { await loadCatalog(reload: true) } }, assistant: true,
                              more: { AnyView(NewTaskOptions(workbench: workbench, draft: draft, catalog: catalog, backend: backend, loading: loading, error: catalogError,
                                                             retry: { Task { await loadCatalog(reload: true) } }, toolDevices: nil, extensions: nil)) },
                              close: { modelPanel = false })
        }
        .task(id: contextKey) { await loadCatalog() }
        .onChange(of: contextProject, initial: true) { _, id in if draft.projectID != id { draft.projectID = id } }
        .onChange(of: scope) { _, value in
            if !modeChosen { sessionMode = value == "project" ? "fresh" : "continuous" }
            if value != "project" || !offered.contains(where: { $0.backendId.name == draft.backendName }) { draft.backendName = nil; draft.profileID = nil; draft.model = nil }
        }
        .onDisappear { workbench.drafts.discard("team.new-member") }
    }

    private func loadCatalog(reload: Bool = false) async {
        guard let projectID = contextProject else { catalog = nil; loading = false; return }
        let key = contextKey
        if !reload, let cached = workbench.cachedCatalog(backend, profileID: draft.profileID, projectID: projectID) {
            catalog = cached; loading = false; catalogError = nil
        } else { loading = true; catalogError = nil }
        do {
            let loaded = try await workbench.loadCatalog(backend, profileID: draft.profileID, projectID: projectID, reload: reload)
            guard contextKey == key else { return }
            catalog = loaded; loading = false
        } catch is CancellationError {
            if contextKey == key { loading = false }
        } catch {
            guard contextKey == key else { return }
            catalogError = error.riffetMessage; catalog = nil; loading = false
        }
    }

    private func create() async -> Bool {
        guard let api = workbench.api else { error = String(localized: "未连接服务器", bundle: .riffet); return false }
        error = nil
        let choice = catalog.map { NativeConfigurationSummary.choice(catalog: $0, draft: draft, settings: workbench.settings) }
        let target = AgentMemberTarget(backendId: backend.name.lowercased(), profileId: choice?.profileId ?? draft.profileID, model: (choice?.model).flatMap { $0.isEmpty ? nil : $0 } ?? draft.model, permissionMode: nil)
        let text = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = AgentMemberCreate(name: name.trimmingCharacters(in: .whitespacesAndNewlines), avatar: AgentMemberAvatarInput(kind: "emoji", value: emoji),
                                      instructions: text.isEmpty ? nil : text,
                                      scope: AgentMemberScope(kind: scope, projectIds: scope == "project" ? projectID.map { [$0] } : nil),
                                      sessionMode: sessionMode, target: target)
        do {
            let member = try await api.createTeamMember(input: input)
            workbench.store.applyTeamMember(member: member)
            onCreated(member.id)
            return true
        } catch is CancellationError { return false } catch { self.error = error.riffetMessage; return false }
    }
}
