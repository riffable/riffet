import SwiftUI
import RiffetKit

/// 会话信息 (the web's `SessionInfo`): one of the conversation toolbar's three entries, beside the
/// panel button and ⋯. It holds what the session is and where it can take you — its directory and
/// branch, the panel's views, the terminal — and the work running in it, so the toolbar carries no
/// counts and ⋯ only what can be done to the session. A dot on the button says something runs.
struct SessionInfoButton: View {
    let workbench: Workbench
    let session: Session
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: {
            Image(icon: "info.circle").font(.riffet(size: S(13)))
                .overlay(alignment: .topTrailing) {
                    if working { RunningDot().offset(x: 3, y: -2) }
                }
        }
        .buttonStyle(IconButtonStyle(size: 28, active: open))
        .help("会话信息")
        .accessibilityLabel("会话信息")
        .stylePopover(isPresented: $open, arrowEdge: .bottom) {
            SessionInfoView(workbench: workbench, session: workbench.selected ?? session) { open = false }
        }
        .onChange(of: session.id) { open = false }
    }

    private var working: Bool {
        workbench.subagentEntries.contains { $0.state == .running } || !workbench.dock.tasks.isEmpty || workbench.jobs.contains { $0.status == .running }
    }
}

/// The dot is ink, not the accent: it marks work in this conversation, which is content.
private struct RunningDot: View {
    @Environment(\.palette) private var palette

    var body: some View {
        Circle().fill(palette.fg2).frame(width: 5, height: 5)
            .overlay(Circle().strokeBorder(palette.page, lineWidth: 1).padding(-1))
    }
}

private struct SessionInfoView: View {
    let workbench: Workbench
    let session: Session
    let close: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.popupAvailableSize) private var available

    private var quickChat: Bool { session.agentID == AgentDirectory.quickChat }
    private var project: Project? { quickChat ? nil : workbench.project(session.projectId) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                facts
                if let project, !workbench.quickChatContext {
                    Divider()
                    places(project)
                }
                SessionWorkActions(workbench: workbench, inline: true, onOpen: close)
            }
        }
        .frame(width: 320)
        .frame(maxHeight: min(560, max(200, available.height)))
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Facts

    private var facts: some View {
        let branch = project.flatMap { GitStatusModel.model(for: $0.id).status?.branch }.flatMap { $0.isEmpty ? nil : $0 }
        return Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Space.md, verticalSpacing: 6) {
            if let project {
                GridRow {
                    label("目录")
                    CopyValue(value: project.cwd, label: String(localized: "目录")) {
                        Text(project.isTaskWorkspace ? String(localized: "未关联项目") : project.name).foregroundStyle(palette.fg)
                            + Text("  " + (workbench.local ? (project.cwd as NSString).abbreviatingWithTildeInPath : project.cwd)).foregroundStyle(palette.fg3)
                    }
                }
            }
            if let branch {
                GridRow {
                    label("分支")
                    CopyValue(value: branch, label: String(localized: "分支")) {
                        Text(branch).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg)
                    }
                }
            }
            if let created = ServerTime.date(session.createdAt) {
                GridRow {
                    label("创建")
                    Text(created.formatted(date: .abbreviated, time: .shortened))
                        .font(.riffet(size: S(12.5)))
                        .foregroundStyle(palette.fg)
                        .monospacedDigit()
                }
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.md)
    }

    private func label(_ text: LocalizedStringKey) -> some View {
        Text(text).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).gridColumnAlignment(.leading)
    }

    // MARK: Places

    /// Where the session can take you: the panel's views and the terminal. Lighter than the facts:
    /// rows that lead on, the one shown now marked.
    private func places(_ project: Project) -> some View {
        let git = GitStatusModel.model(for: project.id).status
        let inspector = workbench.inspector
        return VStack(spacing: 0) {
            ForEach(workbench.inspectorViews) { view in
                PlaceRow(symbol: view.symbol, title: view.title, active: inspector.open && inspector.tab == view.tab) {
                    if view.tab == .changes, let git, !git.entries.isEmpty { changeHint(git) }
                } action: {
                    close()
                    workbench.showInspector(view.tab)
                }
            }
            let opening = workbench.terminalDock.openingShell
            PlaceRow(symbol: "terminal", title: opening ? String(localized: "正在打开终端…") : String(localized: "终端"), active: false) {
                EmptyView()
            } action: {
                close()
                Task { await workbench.terminalDock.openShell(projectId: project.id) }
            }
            .disabled(opening)
        }
        .padding(Space.xs)
    }

    private func changeHint(_ git: GitStatus) -> some View {
        let added = git.added?.int64Value ?? 0
        let removed = git.removed?.int64Value ?? 0
        return Group {
            if added > 0 || removed > 0 {
                HStack(spacing: 4) {
                    Text("+\(added.formatted())").foregroundStyle(palette.success)
                    Text("−\(removed.formatted())").foregroundStyle(palette.danger)
                }
            } else {
                Text("\(git.entries.count) 个文件").foregroundStyle(palette.fg3)
            }
        }
        .font(.riffet(size: S(11.5)))
        .monospacedDigit()
    }
}

/// A value that copies itself on click; the icon shows on hover, then confirms.
private struct CopyValue<Content: View>: View {
    let value: String
    let label: String
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette
    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        Button {
            copyToPasteboard(value)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
        } label: {
            HStack(spacing: 6) {
                content
                    .font(.riffet(size: S(12.5)))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                Image(icon: copied ? "checkmark" : "doc.on.doc")
                    .font(.riffet(size: S(10.5)))
                    .foregroundStyle(palette.fg3)
                    .opacity(copied || hovering ? 1 : 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("复制\(label)")
    }
}

/// One place row: icon, name, a hint, and a chevron saying it leads somewhere.
private struct PlaceRow<Hint: View>: View {
    let symbol: String
    let title: String
    let active: Bool
    @ViewBuilder let hint: Hint
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                Image(icon: symbol).font(.riffet(size: S(13))).foregroundStyle(palette.fg3).frame(width: 18)
                Text(title).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(1)
                Spacer(minLength: Space.sm)
                hint
                Image(icon: "chevron.right").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
            }
            .padding(.horizontal, Space.sm)
            .frame(height: 28)
            .background(active ? palette.bgActive : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverRowStyle(radius: 8))
    }
}

/// A group of 会话信息 under a hairline: a quiet title with its count, then its rows.
struct InfoSection<Content: View>: View {
    let title: String
    let count: Int
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(title)
                    Spacer(minLength: 0)
                    Text("\(count)").monospacedDigit().foregroundStyle(palette.fg4)
                }
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg3)
                .padding(.horizontal, Space.sm)
                .frame(height: 26)
                content
            }
            .padding(Space.xs)
        }
    }
}
