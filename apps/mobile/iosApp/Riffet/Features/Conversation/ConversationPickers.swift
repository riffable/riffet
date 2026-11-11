import SwiftUI
import RiffetKit

struct ConversationSlashPicker: View {
    let workbench: Workbench
    let session: Session
    let picked: (NativeSlashItem) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var catalog: NativeSlashCatalog?
    @State private var query = ""
    @State private var error: String?
    @State private var retry = 0
    @State private var loading = true
    private var candidates: [NativeSlashItem] { rankSlashItems(items: catalog?.items ?? [], query: query, limit: 200) }
    var body: some View {
        NavigationStack {
            List {
                if let reason = catalog?.reason { Text(reason).font(.footnote).foregroundStyle(.secondary) }
                if let error { Section { Text(error).foregroundStyle(.red); Button("重试") { retry += 1 } } }
                if loading { ProgressView("正在加载命令与技能…") }
                ForEach([false, true], id: \.self) { skills in
                    let items = candidates.filter { $0.isSkill == skills }
                    if !items.isEmpty {
                        Section(skills ? "技能" : "命令") { ForEach(items, id: \.name) { item in
                            Button { picked(item) } label: { VStack(alignment: .leading, spacing: 4) { Text("/" + item.name).font(.body.monospaced()); if let detail = item.description_ { Text(detail).font(.caption).foregroundStyle(.secondary) }; if let hint = item.hint { Text(hint).font(.caption).foregroundStyle(.secondary) } }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading) }.foregroundStyle(.primary)
                        } }
                    }
                }
                if !loading && error == nil && catalog != nil && candidates.isEmpty {
                    ContentUnavailableView(query.isEmpty ? "暂无命令或技能" : "没有匹配的命令", systemImage: "slash.circle", description: Text(query.isEmpty ? "此 Agent 未提供命令目录。" : "尝试搜索其他名称。"))
                }
            }.searchable(text: $query, prompt: String(localized: "搜索命令或技能", bundle: .riffet)).navigationTitle(String(localized: "命令与技能", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .task(id: "\(session.id)|\(retry)") {
                    loading = true; error = nil; catalog = nil
                    do {
                        let loaded = try await workbench.store.slashCatalog(session: session)
                        try Task.checkCancellation(); catalog = loaded
                    } catch is CancellationError { return }
                    catch { self.error = error.riffetMessage }
                    loading = false
                }
        }
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
    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red); Button("重试") { retry += 1 } }
                if loading, files.isEmpty { ProgressView("正在搜索文件…") }
                ForEach(files.filter { $0.kind == .file }, id: \.path) { file in Button { picked(file) } label: { Label(file.path, systemImage: "doc.text").foregroundStyle(.primary).frame(minHeight: 36) } }
                if !loading && files.isEmpty && error == nil { ContentUnavailableView(query.isEmpty ? "搜索项目中的文件" : "没有匹配的文件", systemImage: "doc.text.magnifyingglass") }
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
    private var candidates: [Session] {
        rankedSessionReferences(sessions: workbench.list.sessions, projects: workbench.list.projects, query: query,
            currentSessionId: currentSessionID, projectId: projectID)
    }
    var body: some View {
        NavigationStack {
            List(candidates, id: \.id) { session in
                Button { picked(session) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.title).foregroundStyle(.primary)
                        Text([workbench.list.projects.first(where: { $0.id == session.projectId })?.name, session.agent]
                            .compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                }
            }
            .searchable(text: $query)
            .navigationTitle(String(localized: "引用会话", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
