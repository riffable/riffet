import SwiftUI
import RiffetKit

/// 会话信息 (the web's `SessionInfo`): one of the conversation toolbar's three entries, beside the
/// panel button and ⋯. It holds what the session is and where it can take you — its directory and
/// branch, the panel's views, the terminal — and the work running in it, so the toolbar carries no
/// counts and ⋯ only what can be done to the session. A dot on the button says something runs.
struct SessionInfoButton: View {
    let workbench: Workbench
    let session: Session
    var size: CGFloat = 28
    @State private var open = false
    /// The assistant's 记忆 and 规则 sheets outlive the popover that opens them.
    @State private var assistantSetup = AssistantSetup()

    var body: some View {
        Button { open.toggle() } label: {
            Image(icon: "info.circle").font(.riffet(size: S(13)))
                .overlay(alignment: .topTrailing) {
                    if working { RunningDot().offset(x: 3, y: -2) }
                }
        }
        .buttonStyle(IconButtonStyle(size: size, active: open))
        .help("会话信息")
        .accessibilityLabel("会话信息")
        .stylePopover(isPresented: $open, arrowEdge: .bottom) {
            SessionInfoView(workbench: workbench, session: workbench.selected ?? session, setup: assistantSetup) { open = false }
        }
        .assistantSetupSheets(assistantSetup, workbench: workbench)
        .onChange(of: session.id) { open = false }
        .onChange(of: workbench.sessionInfoRequests) { open = true }
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
            .overlay(Circle().strokeBorder(palette.bg, lineWidth: 1).padding(-1))
    }
}

private struct SessionInfoView: View {
    let workbench: Workbench
    let session: Session
    let setup: AssistantSetup
    let close: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.popupAvailableSize) private var available
    @Environment(\.openSettings) private var openSettings

    private var quickChat: Bool { session.agentID == AgentDirectory.quickChat }
    private var project: Project? { quickChat ? nil : workbench.project(session.projectId) }
    private var assistant: Bool { workbench.isAssistantSession(session) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                facts
                if let project, !workbench.quickChatContext, !assistant {
                    Divider()
                    places(project)
                }
                if workbench.isAssistantMain(session) {
                    Divider()
                    assistantRows
                }
                SessionMarksSection(workbench: workbench, session: session, close: close)
                SessionWorkActions(workbench: workbench, onOpen: close)
            }
        }
        .frame(width: 320)
        .frame(maxHeight: min(560, max(200, available.height)))
        .fixedSize(horizontal: false, vertical: true)
        .task(id: session.id) { if workbench.isAssistantMain(session) { await setup.load(workbench) } }
    }

    /// What the assistant is made of, in place of a project's panel views and terminal.
    private var assistantRows: some View {
        VStack(spacing: 0) {
            PlaceRow(symbol: "brain", title: String(localized: "记忆"), active: false) {
                Text(setup.memoryNote).font(RiffetFont.text(RiffetTextSize.x2xs)).foregroundStyle(palette.fg3)
            } action: { close(); setup.showsMemory = true }
            PlaceRow(symbol: "checkmark.shield", title: String(localized: "规则"), active: false) {
                Text(setup.instructionsNote).font(RiffetFont.text(RiffetTextSize.x2xs)).foregroundStyle(palette.fg3)
            } action: { close(); Task { await setup.openRules(workbench) } }
            PlaceRow(symbol: "sparkles", title: String(localized: "能力"), active: false) {
                EmptyView()
            } action: { close(); setup.openAbilities(workbench) }
            PlaceRow(symbol: "gearshape", title: String(localized: "设置"), active: false) {
                EmptyView()
            } action: { close(); SidebarFooterSupport.openSettings(openSettings, on: .assistant) }
        }
        .padding(Space.xs)
    }

    // MARK: Facts

    private var facts: some View {
        let branch = project.flatMap { assistant ? nil : GitStatusModel.model(for: $0.id).status?.branch }.flatMap { $0.isEmpty ? nil : $0 }
        let catalog = workbench.catalogs.cached(for: session)
        let model = (session.model ?? "").isEmpty ? nil : modelSelectionSummary(catalog: catalog?.models ?? [], selection: session.model)
        let approval = quickChat ? nil : (workbench.status?.approval ?? session.approval).flatMap { $0.isEmpty ? nil : $0 }
        return Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Space.md, verticalSpacing: 6) {
            if let model {
                GridRow {
                    label("模型")
                    Text(model).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg)
                }
            }
            if let approval {
                GridRow {
                    label("权限")
                    Text(catalog?.capabilities.permissions.first { $0.id == approval }?.label ?? approval)
                        .font(.riffet(size: S(12.5))).foregroundStyle(palette.fg)
                }
            }
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
    let meta: String?
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette

    init(title: String, meta: String?, @ViewBuilder content: () -> Content) {
        self.title = title
        self.meta = meta
        self.content = content()
    }

    init(title: String, count: Int, @ViewBuilder content: () -> Content) {
        self.init(title: title, meta: "\(count)", content: content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(title)
                    Spacer(minLength: 0)
                    if let meta { Text(meta).monospacedDigit().foregroundStyle(palette.fg4) }
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

/// 本会话收藏: this conversation's saved replies, newest first; a row opens it in the transcript.
private struct SessionMarksSection: View {
    let workbench: Workbench
    let session: Session
    let close: () -> Void
    @Environment(\.palette) private var palette
    @State private var expanded = false

    var body: some View {
        let marks = MarksStore.shared.marks(for: session.id)
        if !marks.isEmpty {
            InfoSection(title: String(localized: "本会话收藏"), count: marks.count) {
                ForEach(expanded ? marks : Array(marks.prefix(3))) { mark in
                    SessionMarkRow(mark: mark) {
                        close()
                        workbench.openMark(mark, file: mark.kind == "file")
                    }
                }
                if !expanded, marks.count > 3 {
                    Button { expanded = true } label: {
                        HStack {
                            Text("其余 \(marks.count - 3) 个").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                            Spacer(minLength: 0)
                            Image(icon: "chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                        }
                        .padding(.horizontal, Space.sm)
                        .frame(height: 28)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(HoverRowStyle(radius: 8))
                }
            }
        }
    }
}

private struct SessionMarkRow: View {
    let mark: Mark
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let text = (mark.quote?.exact ?? mark.asset?.path ?? mark.asset?.name ?? mark.snapshot.text)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        Button(action: action) {
            HStack(spacing: Space.sm) {
                Group {
                    if mark.isSpan {
                        Circle().fill(Color(nsColor: mark.markColor.nsColor)).frame(width: 8, height: 8)
                    } else {
                        Image(icon: mark.kind == "image" ? "photo" : mark.kind == "file" ? "doc.text" : "bookmark")
                            .font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    }
                }
                .frame(width: 18)
                Text(text).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(1)
                Spacer(minLength: Space.sm)
                if let created = ServerTime.date(mark.createdAt) {
                    Text(MarksModel.relative.localizedString(for: created, relativeTo: Date()))
                        .font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4).monospacedDigit()
                }
            }
            .padding(.horizontal, Space.sm)
            .frame(height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverRowStyle(radius: 8))
    }
}
