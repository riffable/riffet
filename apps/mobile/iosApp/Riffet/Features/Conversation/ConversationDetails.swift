import SwiftUI
import RiffetKit

/// The conversation's details panel (mobile.md §2.7): its destinations, what is running, the facts,
/// the small actions and delete. Opens as a sheet from the conversation's title.
struct ConversationDetails: View {
    let workbench: Workbench
    let session: Session
    let catalog: NativeBackendCatalogEntry?
    let connectionStatus: ConversationStatus?
    let supportsTerminal: Bool
    /// Set for the assistant's main conversation: its setup rows, a fixed title, no code or list actions.
    var assistant: AssistantSetup? = nil
    let find: () -> Void
    let openTerminal: () -> Void
    let rename: () -> Void
    /// Holds an action for the conversation to run when this sheet has been dismissed.
    let afterClose: (@escaping () -> Void) -> Void
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var destination: Destination?
    @State private var stopping: Item?

    private enum Destination: Hashable { case files, changes, all }

    /// A running sub-agent or background task, drawn as one row.
    private struct Item: Identifiable {
        let id: String
        let name: String
        let state: RiffetStatusDot.State
        let running: Bool
        let subagent: SubagentEntry?
        let task: NativeActivity?
        let warning: String?
        let canStop: Bool
    }

    private var current: Session { workbench.selected?.id == session.id ? workbench.selected ?? session : session }
    private var project: Project? { workbench.project(current.projectId) }
    /// Anything in the assistant's directory is not code work.
    private var inAssistant: Bool { assistant != nil || project?.isAssistant == true }
    private var items: [Item] {
        let subagents = workbench.subagentEntries
        let owned = Set(subagents.map(\.toolCallId))
        let tasks = workbench.dock.tasks
        let fromSubagents = subagents.map { entry -> Item in
            let task = tasks.first { $0.toolCallId == entry.toolCallId }
            let view = task.map { activityView(activity: $0, stopping: workbench.isStopping(activity: $0.id), nowMillis: 0) }
            return Item(id: "agent." + entry.toolCallId, name: entry.name,
                        state: entry.state == .running ? .running : entry.state == .failed ? .failed : .idle,
                        running: entry.state == .running, subagent: entry, task: task, warning: view?.stopWarning, canStop: view?.canStop == true)
        }
        let fromTasks = tasks.filter { $0.toolCallId.map { !owned.contains($0) } ?? true }.map { task -> Item in
            let view = activityView(activity: task, stopping: workbench.isStopping(activity: task.id), nowMillis: 0)
            return Item(id: "task." + task.id, name: view.subject ?? view.label,
                        state: view.running ? .running : task.status == .failed ? .failed : .idle,
                        running: view.running, subagent: nil, task: task, warning: view.stopWarning, canStop: view.canStop)
        }
        return (fromSubagents + fromTasks).sorted { $0.running && !$1.running }
    }
    private var stateLine: String {
        [current.state.label, connectionStatus?.badge?.text].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        let current = current
        let items = items
        NavigationStack {
            RiffetList {
                Section { RiffetPaneActionBar(actions: destinations) }
                if let assistant { Section { AssistantSetupRows(workbench: workbench, setup: assistant) } }
                // The one fact about this conversation a reader cannot see elsewhere: a profile change
                // waiting for the agent to restart, else the server's informational notice.
                if workbench.status?.profilePending?.boolValue == true {
                    RiffetNotice.section(.info, String(localized: "新配置将在后端重启后生效", bundle: .riffet))
                } else if workbench.status?.noticeLevel == "info" {
                    RiffetNotice.section(.info, workbench.status?.notice)
                }
                if !items.isEmpty { progress(items) }
                Section { facts(current) }
                Section { RiffetPaneActionBar(actions: smallActions(current)) }
                if workbench.list.canDeleteSessions {
                    Section {
                        // The server's preview of what goes with it is the confirmation, on the conversation.
                        Button(role: .destructive) { let target = current; close { Task { await workbench.requestDeletion(target) } } } label: {
                            SettingsRowLabel(title: String(localized: "删除…", bundle: .riffet)).foregroundStyle(palette.danger).contentShape(Rectangle())
                        }
                        .buttonStyle(RiffetRowPressStyle()).disabled(workbench.deletionLoading != nil)
                    }
                }
            }
            .accessibilityIdentifier("conversationInformationList")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { RiffetBarTitle(title: assistant != nil ? String(localized: "个人助理", bundle: .riffet) : current.title, status: stateLine) }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(String(localized: "关闭", bundle: .riffet))
                }
            }
            .navigationDestination(item: $destination) { target in
                switch target {
                case .files: if let project { ProjectFilesView(workbench: workbench, project: project) }
                case .changes: if let project { ProjectChangesView(workbench: workbench, project: project) }
                case .all: allItems
                }
            }
            .confirmationDialog(stopping.map { String(localized: "停止「\($0.name)」？", bundle: .riffet) } ?? "", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }), titleVisibility: .visible, presenting: stopping) { item in
                Button(String(localized: "停止", bundle: .riffet), role: .destructive) { stop(item) }
            } message: { Text($0.warning ?? "") }
        }
        // Pages opened in here (变更, 文件) raise toasts the conversation's host would show under the sheet.
        .riffetToastHost()
        .presentationDetents(dynamicTypeSize.isAccessibilitySize ? [.large] : [.medium, .large]).presentationDragIndicator(.visible)
    }

    // MARK: Destinations and actions

    private var destinations: [RiffetPaneAction] {
        var result: [RiffetPaneAction] = []
        if current.backendId != .chat, project != nil, !inAssistant {
            result.append(.init(symbol: "point.3.connected.trianglepath.dotted", title: String(localized: "变更", bundle: .riffet)) { destination = .changes })
            result.append(.init(symbol: "folder", title: String(localized: "文件", bundle: .riffet)) { destination = .files })
        }
        if supportsTerminal, !inAssistant { result.append(.init(symbol: "terminal", title: String(localized: "终端", bundle: .riffet)) { close(openTerminal) }) }
        result.append(.init(symbol: "magnifyingglass", title: String(localized: "查找", bundle: .riffet)) { close(find) })
        return result
    }

    private func smallActions(_ current: Session) -> [RiffetPaneAction] {
        let pinned = current.pinnedAt != nil, archived = current.archivedAt != nil
        var actions: [RiffetPaneAction] = []
        if !inAssistant {
            actions.append(.init(symbol: pinned ? "pin.slash" : "pin", title: pinned ? String(localized: "取消置顶", bundle: .riffet) : String(localized: "置顶", bundle: .riffet)) {
                Task { await workbench.update(current, pinned: !pinned) }
            })
            actions.append(.init(symbol: "pencil", title: String(localized: "重命名", bundle: .riffet)) { close(rename) })
        }
        actions.append(.init(symbol: archived ? "arrow.uturn.backward" : "archivebox", title: archived ? String(localized: "恢复", bundle: .riffet) : String(localized: "归档", bundle: .riffet)) {
            Task { await workbench.update(current, archived: !archived) }
        })
        return actions
    }

    /// Closes the panel, then runs what the conversation's menu would run, once the sheet is gone: an alert
    /// or dialog asked for while it is still leaving would not appear.
    private func close(_ action: @escaping () -> Void) {
        afterClose(action)
        dismiss()
    }

    // MARK: Running

    @ViewBuilder private func progress(_ items: [Item]) -> some View {
        let running = items.filter(\.running).count
        Section {
            ForEach(items.prefix(3)) { row($0) }
            if items.count > 3 {
                Button { destination = .all } label: {
                    HStack(spacing: 8) {
                        Text(String(localized: "全部 \(items.count) 个", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg4)
                    }.contentShape(Rectangle())
                }.buttonStyle(RiffetRowPressStyle())
            }
        } header: {
            RiffetSectionTitle(String(localized: "正在进行", bundle: .riffet), figure: running > 0 ? String(localized: "运行中 \(Int32(running)) / 共 \(Int32(items.count))", bundle: .riffet) : nil)
        }
        .accessibilityIdentifier("conversationSubagents")
    }

    @ViewBuilder private func row(_ item: Item) -> some View {
        let label = HStack(spacing: 10) {
            RiffetStatusDot(state: item.state)
            Text(item.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
            Spacer(minLength: 0)
        }
        Group {
            if let entry = item.subagent {
                NavigationLink {
                    ConversationSubagentPage(workbench: workbench, projectID: current.projectId, toolCallID: entry.toolCallId, title: entry.name, parentItems: nil)
                        .environment(\.conversationReturnToMain, { dismiss() })
                } label: { label }
            } else { label }
        }
        .contextMenu { if item.canStop { Button(String(localized: "停止", bundle: .riffet), systemImage: "stop.circle", role: .destructive) { stopping = item } } }
        .swipeActions(edge: .trailing) { if item.canStop { Button(String(localized: "停止", bundle: .riffet)) { stopping = item }.tint(palette.danger) } }
    }

    private var allItems: some View {
        RiffetList { Section { ForEach(items) { row($0) } } }
            .navigationTitle(String(localized: "正在进行", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }

    private func stop(_ item: Item) {
        guard let task = item.task else { return }
        Task { await workbench.stop(activity: task.id) }
    }

    // MARK: Facts

    @ViewBuilder private func facts(_ current: Session) -> some View {
        let backend = current.backendId ?? .cursor
        RiffetValueRow(label: "Agent", value: catalog?.label ?? workbench.backends.first { $0.backendId == backend }?.label ?? backend.name.capitalized)
            .accessibilityIdentifier("sessionInformationAgent")
        if let profile = NativeConfigurationSummary.profile(catalog: catalog, profileID: current.backendProfileId) {
            RiffetValueRow(label: String(localized: "服务商", bundle: .riffet), value: profile)
        }
        RiffetValueRow(label: String(localized: "模型", bundle: .riffet), value: NativeConfigurationSummary.model(catalog: catalog, selection: current.model))
        RiffetValueRow(label: String(localized: "运行模式", bundle: .riffet), value: catalog?.capabilities.modes.first { $0.id == current.mode }?.label ?? current.mode)
        if let approval = NativeConfigurationSummary.approval(status: workbench.status, backend: backend, sessionApproval: current.approval) {
            RiffetValueRow(label: String(localized: "操作确认", bundle: .riffet), value: catalog?.capabilities.permissions.first { $0.id == approval }?.label ?? approval)
        }
        if let project, !inAssistant {
            RiffetValueRow(label: String(localized: "项目", bundle: .riffet), value: project.name)
            RiffetValueRow(label: String(localized: "目录", bundle: .riffet), value: project.cwd, mono: true).accessibilityIdentifier("sessionInformationDirectory")
            if let branch = project.worktree?.branch { RiffetValueRow(label: String(localized: "分支", bundle: .riffet), value: branch, mono: true) }
        }
        if !current.tags.isEmpty, !inAssistant { RiffetValueRow(label: String(localized: "标签", bundle: .riffet), value: current.tags.map { "#" + $0 }.joined(separator: " ")) }
        RiffetValueRow(label: String(localized: "创建时间", bundle: .riffet), value: date(current.createdAt))
        RiffetValueRow(label: String(localized: "最近活动", bundle: .riffet), value: date(current.lastActivityAt ?? current.updatedAt))
        RiffetValueRow(label: String(localized: "会话 ID", bundle: .riffet), value: current.id, mono: true)
        if let nativeID = current.nativeSessionId ?? current.cursorSessionId {
            RiffetValueRow(label: String(localized: "Agent 会话 ID", bundle: .riffet), value: nativeID, mono: true)
        }
        RiffetValueRow(label: String(localized: "服务器", bundle: .riffet), value: workbench.baseURL.absoluteString, mono: true)
        NavigationLink { SessionOptionsView(workbench: workbench, session: current) } label: {
            SettingsRowLabel(title: String(localized: "会话选项", bundle: .riffet))
        }
    }

    private func date(_ value: String) -> String {
        ServerTime.date(value)?.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale)) ?? value
    }
}
