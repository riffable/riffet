import SwiftUI
import RiffetKit

/// The 团队 tab's root (mobile.md §9.12): one row per member in the web sidebar's order, which does not follow activity.
struct TeamRootView: View {
    let workbench: Workbench
    let onOpen: (String) -> Void
    @State private var creating = false
    @State private var deleting: AgentMember?
    @Environment(\.palette) private var palette

    var body: some View {
        let members = sortTeamMembers(members: workbench.teamMembers ?? [])
        List {
            ForEach(members, id: \.id) { member in
                TeamMemberRow(workbench: workbench, member: member, onOpen: onOpen, onDelete: { deleting = $0 })
            }
        }
        .listStyle(.plain)
        .listRowSpacing(0)
        .scrollContentBackground(.hidden)
        .background(palette.bg)
        .riffetSoftEdges()
        .overlay(alignment: .top) { RiffetBarScrim() }
        .refreshable { await workbench.refreshAndWait() }
        .navigationTitle(String(localized: "团队", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { creating = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel(String(localized: "新建成员", bundle: .riffet))
            }
        }
        .sheet(isPresented: $creating) { NewMemberView(workbench: workbench, onCreated: onOpen) }
        .confirmationDialog(deleting.map { String(localized: "删除成员「\($0.name)」？", bundle: .riffet) } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { member in
            Button(String(localized: "删除", bundle: .riffet), role: .destructive) { Task { _ = await workbench.delete(member) } }
        } message: { _ in Text(String(localized: "保留历史会话记录，不再出现在团队列表中。", bundle: .riffet)) }
        .background(TabBarVisibility(hidden: false))
    }
}

/// One member of the list. `List` builds this value for every member on each pass and runs its body only for the
/// rows on screen, so what a row shows is worked out in `TeamMemberRowLabel`.
private struct TeamMemberRow: View {
    let workbench: Workbench
    let member: AgentMember
    let onOpen: (String) -> Void
    let onDelete: (AgentMember) -> Void

    var body: some View {
        Button { onOpen(member.id) } label: { TeamMemberRowLabel(workbench: workbench, member: member) }
            .buttonStyle(RiffetRowPressStyle(radius: 10))
            .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .accessibilityIdentifier("member.\(member.id)")
            .swipeActions(edge: .leading, allowsFullSwipe: false) { TeamMemberActions(workbench: workbench, member: member, onDelete: onDelete, edge: .leading) }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) { TeamMemberActions(workbench: workbench, member: member, onDelete: onDelete, edge: .trailing) }
            .contextMenu { TeamMemberActions(workbench: workbench, member: member, onDelete: onDelete, edge: nil) }
    }
}

/// 置顶 on the leading swipe; 归档 and 删除 (not for the default member) on the trailing one; all in the long-press menu.
private struct TeamMemberActions: View {
    let workbench: Workbench
    let member: AgentMember
    let onDelete: (AgentMember) -> Void
    let edge: HorizontalEdge?
    @Environment(\.palette) private var palette

    var body: some View {
        let pinned = member.pinned?.boolValue == true
        if edge != .trailing {
            Button(pinned ? String(localized: "取消置顶", bundle: .riffet) : String(localized: "置顶", bundle: .riffet), systemImage: pinned ? "pin.slash" : "pin") {
                Task { await workbench.setPinned(member, !pinned) }
            }.tint(palette.accent)
        }
        // The default member is neither archived nor deleted (the server refuses both).
        if edge != .leading, !member.isDefault {
            Button(String(localized: "归档", bundle: .riffet), systemImage: "archivebox") { Task { await workbench.archive(member) } }.tint(palette.fg3)
            Button(String(localized: "删除", bundle: .riffet), systemImage: "trash", role: .destructive) { onDelete(member) }.tint(palette.danger)
        }
    }
}

private struct TeamMemberRowLabel: View {
    let workbench: Workbench
    let member: AgentMember
    @Environment(\.palette) private var palette

    var body: some View {
        let state = memberRowState(member: member, projects: workbench.list.projects, sessions: workbench.list.sessions)
        let session = state.session
        let unread = state.mark == .unread
        let time = session.map { sessionRowTime(SidebarModelKt.activityAt(session: $0)) } ?? ""
        let line = secondLine(state)
        HStack(spacing: 12) {
            MemberAvatarView(workbench: workbench, member: member)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(member.name).riffetFont(unread ? .headline : .body).foregroundStyle(palette.fg).lineLimit(1).layoutPriority(1)
                    if let project = workbench.boundProjectName(member) { Text(project).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
                    if member.pinned?.boolValue == true { Image(systemName: "pin.fill").riffetFont(.caption).foregroundStyle(palette.fg4).accessibilityHidden(true) }
                    Spacer(minLength: 0)
                    Text(time).riffetFont(.caption).foregroundStyle(palette.fg3).monospacedDigit()
                }
                // Without anything to say the name stands alone, centred on the avatar.
                if !line.isEmpty || state.mark != .none {
                    HStack(spacing: 8) {
                        Text(line).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                        Spacer(minLength: 0)
                        MemberMark(mark: state.mark)
                    }
                    .frame(minHeight: 20)
                }
            }
        }
        // design-rules: allow the task list row's insets
        .padding(.horizontal, 8).padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: RiffetMetrics.rowMinHeight, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([member.name, line, time].filter { !$0.isEmpty }.joined(separator: "，"))
    }

    /// The conversation's title; a continuous member resting on its main conversation tells what it is for instead.
    private func secondLine(_ state: MemberRowState) -> String {
        guard let session = state.session else { return member.description_ ?? "" }
        if state.mark == .none, member.continuous,
           memberMain(member: member, projects: workbench.list.projects, sessions: workbench.list.sessions)?.id == session.id {
            return member.description_ ?? ""
        }
        return session.shownTitle.isEmpty ? String(localized: "未命名会话", bundle: .riffet) : session.shownTitle
    }
}
