import AppKit
import SwiftUI
import RiffetKit

// What the native sidebar (`SidebarView`) and the drawn one (`CustomSidebar`) both do: the row menu,
// the project menu and its dialogs, the dialogs of the list, the filter menu, and the footer's menu
// and status wording. Neither sidebar owns a copy.


/// A conversation row's context menu; a quick chat keeps only the actions that apply to one.
struct SessionRowMenuItems: View {
    let session: Session
    let menu: SessionRowMenu
    var quickChat = false

    var body: some View {
        if quickChat {
            Button(session.pinnedAt == nil ? "置顶" : "取消置顶", action: menu.togglePin)
            Button("重命名…", action: menu.rename)
            Divider()
            Button(session.archivedAt == nil ? "归档" : "取消归档", action: menu.toggleArchive)
            if let delete = menu.delete { Button("删除…", role: .destructive, action: delete).disabled(!menu.deleteEnabled) }
        } else {
            Button("在新窗口中打开", action: menu.openInWindow)
            Divider()
            Button(session.pinnedAt == nil ? "置顶" : "取消置顶", action: menu.togglePin)
            Button("重命名…", action: menu.rename)
            if let editTags = menu.editTags { Button("编辑标签…", action: editTags) }
            if let tabs = menu.tabs, session.archivedAt == nil {
                if tabs.isKept(session.id) {
                    Button("移出标签栏") { tabs.close(session.id) }
                } else {
                    Button("加入标签栏") { tabs.add(session.id) }
                }
            }
            Divider()
            if let reveal = menu.reveal { Button("在 Finder 中显示项目", action: reveal) }
            Button("复制会话 ID") { copyToPasteboard(session.nativeSessionId ?? session.id) }
            Divider()
            Button(session.archivedAt == nil ? "归档" : "取消归档", action: menu.toggleArchive)
            if let delete = menu.delete { Button("删除…", role: .destructive, action: delete).disabled(!menu.deleteEnabled) }
        }
    }
}

extension Workbench {
    /// [session]'s row is drawn selected. A page covers the conversation, so its row is the selected
    /// one, not the conversation's.
    func sidebarRowSelected(_ session: Session) -> Bool {
        sidebar.picked.map { $0 == session.id }
            ?? (page == nil && !showingHome && selected?.id == session.id)
    }

    /// The actions of a row's context menu; the sidebar's dialogs take [rename] and [editTags].
    func sidebarRowMenu(for session: Session, rename: @escaping () -> Void, editTags: @escaping () -> Void) -> SessionRowMenu {
        let cwd = local ? project(session.projectId)?.cwd : nil
        return SessionRowMenu(
            togglePin: { Task { await self.update(session, pinned: session.pinnedAt == nil) } },
            rename: rename,
            editTags: editTags,
            reveal: cwd.map { path in { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) } },
            toggleArchive: { Task { await self.update(session, archived: session.archivedAt == nil) } },
            openInWindow: { WindowRouter.shared.openConversation(session.id) },
            delete: list.canDeleteSessions ? { Task { await self.requestDeletion(session) } } : nil,
            deleteEnabled: deletionLoading == nil,
            tabs: SessionTabsPreferences.shared.active ? SessionTabs.model(for: baseURL) : nil
        )
    }
}

private struct SessionRowHover: ViewModifier {
    let box: HoverAnchorBox
    let info: () -> SessionHoverInfo
    let hover: (Bool) -> Void
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        content
            .background(HoverAnchor(box: box))
            .onHover { hovering in
                hover(hovering)
                if hovering, let anchor = box.view {
                    SessionHoverCardController.shared.schedule(info: info(), palette: palette, anchor: anchor)
                } else {
                    SessionHoverCardController.shared.hide(anchor: box.view)
                }
            }
            .onDisappear { SessionHoverCardController.shared.hide(anchor: box.view) }
    }
}

extension View {
    /// The row's hover card, shown over [box]'s view while the pointer is on it; [hover] is told of
    /// the pointer entering and leaving.
    func sessionRowHover(box: HoverAnchorBox, info: @escaping () -> SessionHoverInfo, hover: @escaping (Bool) -> Void) -> some View {
        modifier(SessionRowHover(box: box, info: info, hover: hover))
    }
}

private struct ProjectActions: ViewModifier {
    let workbench: Workbench
    let project: Project
    let favorites: FolderFavoritesModel
    @State private var renaming = false
    @State private var name = ""
    @State private var tagging = false
    @State private var deleting = false
    @State private var error: String?

    func body(content: Content) -> some View {
        content
            .contextMenu {
                if project.isTaskWorkspace {
                    Button("新建任务") { workbench.selectHomeProject(nil); workbench.showHome() }
                } else {
                    Button("在 \(project.name) 中新建会话") { workbench.showHome(projectId: project.id) }
                    Divider()
                    Button("重命名…") { name = project.name; renaming = true }
                    Button("编辑标签…") { tagging = true }
                    if workbench.local {
                        Divider()
                        Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.cwd)]) }
                        Button("在编辑器中打开") { EditorLauncher.open(path: project.cwd, line: nil) }
                    }
                    Button("复制路径") { copyToPasteboard(project.cwd) }
                    Button(favorites.favorite(at: project.cwd) == nil ? "收藏此文件夹" : "取消收藏此文件夹") { Task { await favorites.toggle(project.cwd) } }
                    Divider()
                    Button(project.archivedAt == nil ? "归档项目" : "恢复项目") {
                        Task { error = await workbench.updateProject(project, archived: project.archivedAt == nil) }
                    }
                    Button("删除项目…", role: .destructive) { deleting = true }
                }
            }
            .alert("重命名项目", isPresented: $renaming) {
                TextField("名称", text: $name)
                Button("取消", role: .cancel) {}
                Button("保存") {
                    let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !value.isEmpty, value != project.name { Task { error = await workbench.updateProject(project, name: value) } }
                }
            }
            .confirmationDialog("从 Riffet 移除「\(project.name)」？", isPresented: $deleting) {
                Button("删除项目", role: .destructive) { Task { error = await workbench.deleteProject(project) } }
            } message: {
                Text("只会从 Riffet 中移除这个项目和它的会话记录，磁盘上的目录与文件不会被删除。")
            }
            .sheet(isPresented: $tagging) {
                TagEditor(title: String(localized: "编辑项目标签"), tags: project.tags ?? [], suggestions: Array(Set(workbench.projectList.flatMap { $0.tags ?? [] })).sorted()) { tags in
                    Task { error = await workbench.updateProject(project, tags: tags) }
                }
            }
            .alert("操作失败", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("好") {}
            } message: { Text(error ?? "") }
    }
}

extension View {
    /// A project row's context menu and the dialogs its items open.
    func projectActions(workbench: Workbench, project: Project, favorites: FolderFavoritesModel) -> some View {
        modifier(ProjectActions(workbench: workbench, project: project, favorites: favorites))
    }
}

private struct SidebarDialogs: ViewModifier {
    let workbench: Workbench
    @Binding var renaming: Session?
    @Binding var renameText: String
    @Binding var tagging: Session?
    @Binding var browsing: Bool
    @Binding var addError: String?

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $browsing) {
                DirectoryBrowser(workbench: workbench) { path in
                    Task { await SidebarProjects.open(path, workbench: workbench, error: $addError) }
                }
            }
            .sheet(isPresented: Binding(get: { tagging != nil }, set: { if !$0 { tagging = nil } })) {
                if let session = tagging {
                    TagEditor(title: String(localized: "编辑会话标签"), tags: session.tags, suggestions: workbench.sessionTags) { tags in
                        Task { await workbench.update(session, tags: tags) }
                    }
                }
            }
            .alert("无法添加项目", isPresented: Binding(get: { addError != nil }, set: { if !$0 { addError = nil } })) {
                Button("好") {}
            } message: { Text(addError ?? "") }
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
}

extension View {
    /// The list's own dialogs: renaming and tagging a conversation, browsing for a project folder,
    /// and the failure of adding one. The sidebar holds the state; its rows and menus set it.
    func sidebarDialogs(
        workbench: Workbench, renaming: Binding<Session?>, renameText: Binding<String>,
        tagging: Binding<Session?>, browsing: Binding<Bool>, addError: Binding<String?>
    ) -> some View {
        modifier(SidebarDialogs(workbench: workbench, renaming: renaming, renameText: renameText, tagging: tagging, browsing: browsing, addError: addError))
    }
}

@MainActor
enum SidebarProjects {
    /// Asks for a folder (this Mac's panel, or the server's browser sheet) and opens it as a project.
    static func add(workbench: Workbench, browsing: Binding<Bool>, error: Binding<String?>) {
        guard workbench.local else { browsing.wrappedValue = true; return }
        // Leave the menu action before asking AppKit to attach a sheet.
        Task {
            guard let url = await DirectoryPanel.choose(prompt: String(localized: "添加项目")) else { return }
            await open(url.path, workbench: workbench, error: error)
        }
    }

    static func open(_ path: String, workbench: Workbench, error failure: Binding<String?>) async {
        do {
            let project = try await workbench.openDirectory(path)
            workbench.showHome(projectId: project.id)
        } catch {
            failure.wrappedValue = error.riffetMessage
        }
    }
}

/// The menu of arrangement, archive, unread and tag filters, and mark all as seen.
/// [addProject], when given, is the menu's first item.
@MainActor
enum SidebarFilterMenu {
    static func make(workbench: Workbench, addProject: (() -> Void)? = nil) -> NSMenu {
        let menu = NSMenu()
        func add(_ title: String, on: Bool, _ action: @escaping () -> Void) {
            let item = MenuAction.item(title, action)
            item.state = on ? .on : .off
            menu.addItem(item)
        }
        if let addProject {
            menu.addItem(MenuAction.item(String(localized: "添加项目"), symbol: "folder.badge.plus", addProject))
            menu.addItem(.separator())
        }
        menu.addItem(.sectionHeader(title: String(localized: "排列方式")))
        add(String(localized: "按项目分组"), on: workbench.sidebar.layout == "PROJECT") { workbench.sidebar.choose(layout: "PROJECT") }
        add(String(localized: "按时间平铺"), on: workbench.sidebar.layout == "TIME") { workbench.sidebar.choose(layout: "TIME") }
        menu.addItem(.separator())
        if workbench.sidebar.tabsShown {
            menu.addItem(.sectionHeader(title: String(localized: "排序")))
            add(String(localized: "最近活动"), on: !workbench.sidebar.pinsInTabOrder) { workbench.sidebar.pinsInTabOrder = false }
            add(String(localized: "按标签页顺序"), on: workbench.sidebar.pinsInTabOrder) { workbench.sidebar.pinsInTabOrder = true }
            menu.addItem(.separator())
        }
        add(String(localized: "显示已归档"), on: workbench.sidebar.showArchived) { workbench.sidebar.showArchived.toggle() }
        add(String(localized: "只看未读"), on: workbench.sidebar.unreadOnly) { workbench.sidebar.unreadOnly.toggle() }
        menu.addItem(MenuAction.item(String(localized: "全部标为已读")) { Task { try? await workbench.store.markAllSeen() } })
        if !workbench.sessionTags.isEmpty {
            menu.addItem(.separator())
            menu.addItem(.sectionHeader(title: String(localized: "按标签筛选")))
            add(String(localized: "全部"), on: workbench.sidebar.tag.isEmpty) { workbench.sidebar.tag = "" }
            for tag in workbench.sessionTags {
                add(tag, on: workbench.sidebar.tag == tag) { workbench.sidebar.tag = tag }
            }
        }
        return menu
    }
}

/// The sidebar footer's server status and its pages-and-appearance menu.
@MainActor
enum SidebarFooterSupport {
    struct Entry {
        let title: String
        let symbol: String
        let action: () -> Void
    }

    /// The list is a saved copy or failed to load.
    static func unhealthy(_ workbench: Workbench) -> Bool { workbench.list.cachedAt != nil || workbench.list.error != nil }

    static func hostName(_ workbench: Workbench) -> String {
        workbench.local ? String(localized: "本机") : (workbench.baseURL.host() ?? String(localized: "远程"))
    }

    static func statusText(_ workbench: Workbench) -> String {
        if let cached = workbench.list.cachedAt {
            let minutes = max(0, (Int64(workbench.minute.timeIntervalSince1970 * 1000) - cached.int64Value) / 60_000)
            return String(localized: "离线 · 显示 \(minutes) 分钟前保存的列表")
        }
        return hostName(workbench)
    }

    static func settingsHelp(_ workbench: Workbench) -> String {
        let base = String(localized: "设置 (⌘,)")
        guard let notice = workbench.backendNotice else { return base }
        return [notice.label, notice.detail].compactMap { $0 }.joined(separator: "\n")
    }

    static func openSettings(_ open: OpenSettingsAction, on section: SettingsSection) {
        UserDefaults.standard.set(section.rawValue, forKey: PreferenceKey.settingsSection)
        open()
    }

    /// [entries], then 外观: light, dark or the system's, and the palette. The chosen action runs
    /// after the menu closes.
    static func popUp(_ anchor: MenuAnchor, scheme: ColorScheme, entries: [Entry]) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var chosen: (() -> Void)?
        func item(_ title: String, _ symbol: String?, on: Bool = false, _ action: @escaping () -> Void) -> NSMenuItem {
            let item = MenuAction.item(title) { chosen = action }
            if let symbol { item.image = NSImage.icon(symbol, accessibilityDescription: nil) }
            item.state = on ? .on : .off
            return item
        }
        for entry in entries { menu.addItem(item(entry.title, entry.symbol, entry.action)) }
        if !entries.isEmpty { menu.addItem(.separator()) }
        let prefs = DisplayPreferences.shared
        let theme = ThemeStore.shared
        let appearance = NSMenu()
        appearance.autoenablesItems = false
        for (id, title, symbol) in [("system", String(localized: "跟随系统"), "circle.lefthalf.filled"), ("light", String(localized: "浅色"), "sun.max"), ("dark", String(localized: "深色"), "moon")] {
            appearance.addItem(item(title, symbol, on: prefs.appearance == id) { prefs.appearance = id })
        }
        appearance.addItem(.separator())
        for entry in theme.choices {
            let themeItem = item(entry.name, nil, on: theme.entry.id == entry.id) { theme.choose(entry) }
            themeItem.image = AppearanceMenuItems.swatch(scheme == .dark ? entry.values.dark : entry.values.light)
            appearance.addItem(themeItem)
        }
        let appearanceItem = NSMenuItem(title: String(localized: "外观"), action: nil, keyEquivalent: "")
        appearanceItem.image = NSImage.icon("paintpalette", accessibilityDescription: nil)
        appearanceItem.submenu = appearance
        menu.addItem(appearanceItem)
        // A pick inside the 外观 submenu may not count as the menu's own selection; `chosen` is only ever set by a pick.
        _ = anchor.popUp(menu)
        chosen?()
    }
}
