import SwiftUI
import RiffetKit

/// Quick-chat history below the shared new-session composer.
struct QuickChatHistory: View {
    @Bindable var workbench: Workbench
    @Environment(\.palette) private var palette
    /// The page's own archived filter; the sidebar's applies to its own lists only.
    @State private var showArchived = false
    @State private var renaming: Session?
    @State private var renameText = ""

    private var project: Project? { workbench.quickChatProject }
    /// Every quick chat, archived included, so the page can offer them when the filter is on.
    private var quickChatSessions: [Session] {
        guard let project else { return [] }
        return workbench.list.sessions.filter { $0.projectId == project.id && $0.agentID == AgentDirectory.quickChat }
    }
    private var hasArchived: Bool { quickChatSessions.contains { $0.archivedAt != nil } }
    /// The same time bands and labels as the sidebar's time layout. `timeBuckets` leaves the
    /// built-in quick-chat project out of its visible set, so the grouping is done here from the
    /// shared label helper and session order.
    private var buckets: [TimeBucket] {
        guard !quickChatSessions.isEmpty else { return [] }
        let dayStart = Int64(Calendar.current.startOfDay(for: .now).timeIntervalSince1970 * 1000)
        let sorted = quickChatSessions
            .filter { showArchived || $0.archivedAt == nil }
            .sorted { compareSessions(a: $0, b: $1) < 0 }
        var labels: [String] = []
        var bands: [[Session]] = []
        for session in sorted {
            let label = timeBucketLabel(session: session, dayStartMillis: dayStart)
            if labels.last == label {
                bands[bands.count - 1].append(session)
            } else {
                labels.append(label)
                bands.append([session])
            }
        }
        return labels.indices.map { TimeBucket(label: labels[$0], sessions: bands[$0]) }
    }
    var body: some View {
        chatList
            .onAppear { if let project { MarksStore.shared.watchProject(project.id) } }
            .onDisappear { if let project { MarksStore.shared.unwatchProject(project.id) } }
            .alert("重命名会话", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("标题", text: $renameText)
                Button("取消", role: .cancel) { renaming = nil }
                Button("保存") {
                    if let session = renaming {
                        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !title.isEmpty { Task { await workbench.update(session, title: title) } }
                    }
                    renaming = nil
                }
            }
    }

    /// The quick chats below the new-chat area, grouped by the sidebar's time bands. Nothing at all
    /// while there is none; the archived filter only appears when it can do something.
    @ViewBuilder
    private var chatList: some View {
        if !quickChatSessions.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                if showArchived || hasArchived {
                    HStack {
                        Spacer()
                        Button { showArchived.toggle() } label: {
                            ChipLabel(text: String(localized: "显示已归档"), symbol: "archivebox", chevron: false)
                        }
                        .buttonStyle(ChipButtonStyle(active: showArchived))
                    }
                }
                ForEach(buckets, id: \.label) { bucket in
                    Text(bucket.label)
                        .font(.riffet(size: S(11.5), weight: .semibold))
                        .foregroundStyle(palette.fg3)
                        .padding(.top, Space.md)
                    ForEach(bucket.sessions, id: \.id) { session in
                        chatRow(session)
                    }
                }
            }
            .padding(.top, Space.xl)
        }
    }

    private func chatRow(_ session: Session) -> some View {
        let now = Int64(workbench.minute.timeIntervalSince1970 * 1000)
        return SessionRow(
            session: session,
            info: sessionHoverInfo(session: session, project: nil, models: workbench.catalogs.cached(for: session)?.models ?? [], now: now),
            activity: relativeLabel(value: activityAt(session: session), now: now),
            marked: MarksStore.shared.isMarked(session.id, in: session.projectId),
            quickChat: true,
            menu: SessionRowMenu(
                togglePin: { Task { await workbench.update(session, pinned: session.pinnedAt == nil) } },
                rename: { renameText = session.title; renaming = session },
                editTags: nil,
                reveal: nil,
                toggleArchive: { Task { await workbench.update(session, archived: session.archivedAt == nil) } },
                openInWindow: {},
                delete: workbench.list.canDeleteSessions ? { Task { await workbench.requestDeletion(session) } } : nil,
                deleteEnabled: workbench.deletionLoading == nil
            ),
            hover: { hovering in workbench.hover(sessionId: session.id, entered: hovering) }
        )
        .equatable()
        .contentShape(Rectangle())
        .onTapGesture { workbench.open(session) }
    }

}
