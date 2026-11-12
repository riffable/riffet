import SwiftUI
import RiffetKit

/// A workbench command the palette lists (`SearchDialog`): ⌘K mixes them under the matching
/// conversations, ⇧⌘P (or a query starting with `>`) lists only them.
struct PaletteCommand: Identifiable {
    let id: String
    let title: String
    /// The menu shortcut, a settings page's summary, or the folder for a project's new conversation.
    let detail: String
    let symbol: String
    let run: () -> Void

    /// The query (without the `>`) matches the title or the detail.
    func matches(_ needle: String) -> Bool {
        needle.isEmpty || "\(title) \(detail)".lowercased().contains(needle.lowercased())
    }

    @MainActor
    static func all(workbench: Workbench, openSettings: OpenSettingsAction) -> [PaletteCommand] {
        var result: [PaletteCommand] = [
            PaletteCommand(id: "new", title: String(localized: "新会话"), detail: "⌘N", symbol: "square.and.pencil") { workbench.showHome() },
            PaletteCommand(id: "stats", title: String(localized: "打开统计"), detail: "⇧⌘U", symbol: "chart.bar") { workbench.page = .stats },
            PaletteCommand(id: "tasks", title: String(localized: "打开定时任务"), detail: "⇧⌘J", symbol: "clock") { workbench.page = .tasks },
            PaletteCommand(id: "plugins", title: String(localized: "管理插件"), detail: "", symbol: WorkbenchPage.plugins.symbol) { workbench.page = .plugins },
            PaletteCommand(id: "extensions", title: String(localized: "打开 Agent 扩展"), detail: "⇧⌘E", symbol: WorkbenchPage.extensions.symbol) { workbench.page = .extensions },
            PaletteCommand(id: "marks", title: String(localized: "打开收藏夹"), detail: "⇧⌘L", symbol: "bookmark") { workbench.page = .marks },
            PaletteCommand(id: "activity", title: String(localized: "打开活动"), detail: "", symbol: WorkbenchPage.activity.symbol) { workbench.page = .activity },
            PaletteCommand(id: "sidebar", title: String(localized: "收起/展开侧栏"), detail: "⌘B", symbol: "sidebar.left") {
                NotificationCenter.default.post(name: .riffetToggleSidebar, object: workbench)
            },
            PaletteCommand(id: "terminal", title: String(localized: "打开终端"), detail: "⌃`", symbol: "terminal") {
                Task { await workbench.terminalDock.openShell() }
            },
            PaletteCommand(id: "refresh", title: String(localized: "刷新列表"), detail: "⌘R", symbol: "arrow.clockwise") { workbench.refresh() },
            PaletteCommand(id: "settings", title: String(localized: "打开设置"), detail: "⌘,", symbol: "gearshape") { openSettings() },
        ]
        if let session = workbench.selected, !workbench.showingHome,
           ConversationState(workbench: workbench, session: session, catalog: workbench.catalogs.cached(for: session)).supportsTerminal {
            result.insert(PaletteCommand(id: "terminal-view", title: workbench.showsTerminalPage ? String(localized: "切换对话视图") : String(localized: "切换终端视图"), detail: "⇧⌘T", symbol: "rectangle.on.rectangle") {
                workbench.toggleTerminalPage()
            }, at: 7)
        }
        if workbench.selected != nil, !workbench.showingHome, workbench.canvasAvailable {
            result.insert(PaletteCommand(id: "canvas-view", title: workbench.showsCanvasPage ? String(localized: "切换对话视图") : String(localized: "切换画布视图"), detail: "", symbol: "point.3.connected.trianglepath.dotted") {
                workbench.toggleCanvasPage()
            }, at: min(7, result.count))
        }
        for command in workbench.pluginCommandList {
            result.append(PaletteCommand(id: "plugin:\(command.id)", title: command.title, detail: command.pluginTitle, symbol: "puzzlepiece.extension") {
                workbench.pluginCommands.run(command, in: workbench)
            })
        }
        for section in SettingsSection.navigable {
            result.append(PaletteCommand(id: "settings:\(section.rawValue)", title: String(localized: "设置：\(section.title)"), detail: section.summary, symbol: section.symbol) {
                UserDefaults.standard.set(section.rawValue, forKey: PreferenceKey.settingsSection)
                openSettings()
            })
        }
        for project in workbench.projects {
            result.append(PaletteCommand(id: "project:\(project.id)", title: String(localized: "在 \(project.name) 中新建会话"), detail: project.cwd, symbol: "folder") {
                workbench.showHome(projectId: project.id)
            })
        }
        return result
    }
}
