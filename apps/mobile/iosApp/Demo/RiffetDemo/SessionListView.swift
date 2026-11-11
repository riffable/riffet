import SwiftUI

private enum SessionFilter: String, CaseIterable, Identifiable {
    case all = "全部会话", running = "进行中", attention = "需要处理", archived = "已归档"
    var id: Self { self }
}

struct SessionListView: View {
    let onNewTask: (String?) -> Void
    @Environment(DemoStore.self) private var store
    @State private var search = ""
    @State private var projectID: String?
    @State private var filter = SessionFilter.all
    @State private var showingProjects = false

    private var sessions: [DemoSession] {
        store.sessions.filter { session in
            session.archived == (filter == .archived) &&
            (projectID == nil || session.projectID == projectID) &&
            (filter != .running || session.status == .running) &&
            (filter != .attention || session.needsAttention) &&
            (search.isEmpty || "\(session.title) \(session.summary) \(store.project(session.projectID).name) \(session.agent)"
                .localizedCaseInsensitiveContains(search))
        }
    }

    private var attention: [DemoSession] {
        filter == .archived ? [] : sessions.filter(\.needsAttention)
    }

    private var recent: [DemoSession] {
        let values = filter == .archived ? sessions : sessions.filter { !$0.needsAttention }
        return values.filter(\.pinned) + values.filter { !$0.pinned }
    }

    var body: some View {
        List {
            Section {
                HStack(alignment: .center) {
                    Button { showingProjects = true } label: {
                        HStack(spacing: 5) {
                            Text(projectID.map { store.project($0).name } ?? "所有项目")
                                .font(.subheadline.weight(.medium))
                            Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                        }
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.blue)
                    .accessibilityIdentifier("projectScope")
                    Spacer(minLength: 12)
                    Label("Mac Studio · 演示", systemImage: "desktopcomputer")
                        .font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
            }
            if !attention.isEmpty {
                Section {
                    ForEach(attention) { session in sessionRow(session, focusApproval: true) }
                } header: {
                    HStack(spacing: 6) {
                        Text("需要你处理")
                        Text("\(attention.count)").foregroundStyle(.orange)
                    }
                    .font(.subheadline.weight(.semibold))
                    .textCase(nil)
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("attentionSection")
                }
            }
            if !recent.isEmpty {
                Section(filter == .archived ? "已归档" : "最近") {
                    ForEach(recent) { session in sessionRow(session, focusApproval: false) }
                }
                .textCase(nil)
            }
            if sessions.isEmpty {
                ContentUnavailableView {
                    Label(search.isEmpty ? "这里还没有会话" : "没有找到会话", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text(search.isEmpty ? "选择其他范围，或开始一项新任务。" : "试试任务名称、项目或最近的进展。")
                }
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(.compact)
        .navigationTitle("会话")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "搜索会话")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: DemoRoute.settings) { Image(systemName: "gearshape") }
                    .accessibilityLabel("设置")
                    .accessibilityIdentifier("settings")
            }
            ToolbarItem(placement: .bottomBar) {
                Menu {
                    Picker("显示会话", selection: $filter) {
                        ForEach(SessionFilter.allCases) { item in Text(item.rawValue).tag(item) }
                    }
                } label: {
                    Label(filter == .all ? "筛选" : filter.rawValue,
                          systemImage: filter == .all ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityIdentifier("sessionFilter")
            }
            ToolbarItem(placement: .bottomBar) { Spacer() }
            ToolbarItem(placement: .bottomBar) {
                Button { onNewTask(projectID) } label: {
                    Label("新任务", systemImage: "square.and.pencil").fontWeight(.medium)
                }
                .accessibilityIdentifier("newTask")
            }
        }
        .sheet(isPresented: $showingProjects) { ProjectScopeView(selection: $projectID) }
    }

    private func sessionRow(_ session: DemoSession, focusApproval: Bool) -> some View {
        NavigationLink(value: DemoRoute.session(session.id, focusApproval: focusApproval)) {
            SessionRow(session: session, projectName: projectID == nil ? store.project(session.projectID).name : nil,
                       hasDraft: !store.draft(for: session.id).isEmpty)
        }
        .accessibilityIdentifier("session.\(session.id.uuidString)")
        .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 16))
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if !session.archived {
                Button(session.pinned ? "取消置顶" : "置顶", systemImage: session.pinned ? "pin.slash" : "pin") {
                    store.togglePin(session.id)
                }.tint(.blue)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(session.archived ? "恢复" : "归档", systemImage: session.archived ? "tray.and.arrow.up" : "archivebox") {
                if session.archived { store.restore(session.id) } else { store.archive(session.id) }
            }.tint(.gray)
        }
        .contextMenu {
            if !session.archived {
                Button(session.pinned ? "取消置顶" : "置顶", systemImage: session.pinned ? "pin.slash" : "pin") {
                    store.togglePin(session.id)
                }
            }
            Button(session.archived ? "恢复会话" : "归档会话", systemImage: "archivebox") {
                if session.archived { store.restore(session.id) } else { store.archive(session.id) }
            }
        }
    }
}

private struct SessionRow: View {
    let session: DemoSession
    let projectName: String?
    let hasDraft: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(session.title)
                    .font(.body.weight(session.needsAttention ? .semibold : .medium))
                    .foregroundStyle(.primary).lineLimit(2)
                Spacer(minLength: 0)
                Text(session.updated).font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
            }
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                if session.needsAttention {
                    Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(.orange)
                        .accessibilityHidden(true)
                } else if session.pinned {
                    Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                Text(summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            if hasDraft {
                Label("有未发送的草稿", systemImage: "pencil")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var summary: String { projectName.map { "\($0) · \(session.summary)" } ?? session.summary }
}

private struct ProjectScopeView: View {
    @Environment(DemoStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String?
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if query.isEmpty { choice("所有项目", id: nil, symbol: "square.stack") }
                ForEach(store.projects.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { project in
                    choice(project.name, id: project.id, symbol: project.symbol)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("项目范围").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "搜索项目")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    private func choice(_ title: String, id: String?, symbol: String) -> some View {
        Button {
            selection = id
            dismiss()
        } label: {
            HStack {
                Label(title, systemImage: symbol).foregroundStyle(.primary)
                Spacer()
                if selection == id { Image(systemName: "checkmark").foregroundStyle(.blue) }
            }.frame(minHeight: 44)
        }
        .accessibilityIdentifier("project.\(id ?? "all")")
    }
}
