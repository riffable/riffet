import SwiftUI
import RiffetKit

/// A member's page, pushed from the 团队 list (mobile.md §9.12): a continuous member opens on its main conversation,
/// else on the new-session composer that starts it; a fresh member opens on its conversations with the composer below.
struct TeamMemberPage: View {
    let workbench: Workbench
    let memberID: String
    @State private var setup: AssistantSetup
    /// The main conversation just made, shown before the member's own `mainSessionId` arrives.
    @State private var started: String?
    @State private var panel = false
    @Environment(\.palette) private var palette
    @Environment(\.teamNavigator) private var navigator
    @Environment(\.dismiss) private var dismiss

    init(workbench: Workbench, memberID: String) {
        self.workbench = workbench
        self.memberID = memberID
        let setup = AssistantSetup()
        setup.memberID = memberID
        setup.projectID = workbench.member(memberID)?.projectId
        _setup = State(initialValue: setup)
    }

    var body: some View {
        Group {
            if let member = workbench.member(memberID) {
                page(member)
                    .task(id: memberID) { setup.projectID = member.projectId; await setup.refresh(workbench.api) }
            } else {
                palette.bg.ignoresSafeArea().overlay { if !workbench.list.loaded { ProgressView() } }
            }
        }
        .onChange(of: workbench.member(memberID) == nil) { _, gone in if gone, workbench.list.loaded { dismiss() } }
    }

    /// The panel hangs off the page, not one kind of it: 成员信息 opens it on a fresh member's page and on a continuous
    /// member's page before its main conversation exists.
    private func page(_ member: AgentMember) -> some View {
        Group { if member.continuous { continuous(member) } else { fresh(member) } }
            .sheet(isPresented: $panel) {
                MemberPanel(workbench: workbench, member: member, setup: setup, open: { navigator.open($0) }, onDeleted: { navigator.popToRoot() })
            }
    }

    private func mainID(_ member: AgentMember) -> String? {
        if let id = memberMain(member: member, projects: workbench.list.projects, sessions: workbench.list.sessions)?.id { return id }
        guard let id = started else { return nil }
        return workbench.listedSession(id)?.archivedAt == nil ? id : nil
    }

    @ViewBuilder private func continuous(_ member: AgentMember) -> some View {
        if let id = mainID(member) {
            // A member of a project works in code like any conversation there; the others have the assistant's restrictions.
            ConversationView(workbench: workbench, sessionID: id, assistant: member.scope.kind == "project" ? nil : setup, member: member).id(id)
        } else {
            NewTaskView(workbench: workbench, onStart: { started = $0.id }, onOpenSession: { navigator.open($0) }, assistant: setup, member: member)
                .toolbar { memberToolbar(member) }
        }
    }

    @ViewBuilder private func fresh(_ member: AgentMember) -> some View {
        NewTaskView(workbench: workbench, onStart: { navigator.open($0.id) }, onOpenSession: { navigator.open($0) }, assistant: setup, member: member,
                    pageContent: AnyView(MemberSessionsContent(workbench: workbench, member: member, open: { navigator.open($0) })))
            .toolbar { memberToolbar(member) }
    }

    @ToolbarContentBuilder private func memberToolbar(_ member: AgentMember) -> some ToolbarContent {
        ToolbarItem(placement: .principal) { MemberBarTitle(workbench: workbench, member: member) }
        ToolbarItem(placement: .topBarTrailing) {
            Button { panel = true } label: { Image(systemName: "person.crop.circle") }.accessibilityLabel(String(localized: "成员信息", bundle: .riffet))
        }
    }
}

/// A fresh member's page body: its head and its conversations by day.
struct MemberSessionsContent: View {
    let workbench: Workbench
    let member: AgentMember
    let open: (String) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let groups = MemberDayGroups.make(memberSessions(member: member, sessions: workbench.list.sessions))
        List {
            VStack(spacing: 10) {
                MemberAvatarView(workbench: workbench, member: member, size: 64)
                if let text = member.description_, !text.isEmpty {
                    Text(text).riffetFont(.label).foregroundStyle(palette.fg2).multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity).padding(.top, RiffetMetrics.groupGap).padding(.bottom, RiffetMetrics.footnoteGap)
            .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
            ForEach(groups, id: \.title) { group in
                RiffetSectionHeader(title: group.title).listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
                ForEach(group.sessions, id: \.id) { session in
                    MemberSessionRow(workbench: workbench, member: member, session: session, current: false, compact: false) { open(session.id) }
                        .listRowInsets(EdgeInsets(top: 0, leading: RiffetMetrics.pageInset, bottom: 0, trailing: RiffetMetrics.pageInset))
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(palette.bg)
        .scrollDismissesKeyboard(.interactively)
    }
}
