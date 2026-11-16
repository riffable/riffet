import AppKit
import SwiftUI

/// Local display preferences (the web's `display-settings.ts`), stored per Mac. The settings window
/// writes them through `@AppStorage` with these keys; the views read them from `DisplayPreferences`.
enum PreferenceKey {
    /// `system`, `light` or `dark`.
    static let appearance = "riffet.appearance"
    /// 0.9, 1.0, 1.1 or 1.2.
    static let textScale = "riffet.text-scale"
    /// Transcript spacing: 0.75, 1.0 or 1.25.
    static let density = "riffet.density"
    /// Terminal font size in points, 11–16.
    static let terminalFontSize = "riffet.terminal-font-size"
    /// Terminal content padding in points.
    static let terminalHorizontalPadding = "riffet.terminal-horizontal-padding"
    static let terminalVerticalPadding = "riffet.terminal-vertical-padding"
    /// Reading column width in points, 640–1600.
    static let contentWidth = "riffet.content-width"
    /// Whether an answer shows its chapter navigation.
    static let chapterNavigation = "riffet.chapter-navigation"
    /// Whether the conversation shows the overview column beside the transcript, where its style has one.
    static let sessionOverview = "riffet.session-overview"
    /// Whether the turn rail draws dots instead of lines.
    static let railDots = "riffet.rail-dots"
    /// Dock icon variant id (`AppIconVariant`).
    static let appIcon = "riffet.app-icon"
    /// What shows behind the window (`WindowMaterial.rawValue`).
    static let windowMaterial = "riffet.window-material"
    /// The interface style (`InterfaceStyle.rawValue`).
    static let interfaceStyle = "riffet.interface-style"
    /// Code syntax highlighting theme (`auto` or a built-in id).
    static let codeTheme = "riffet.code-theme"
    /// How much of the material shows through the sidebar and the content, in percent.
    static let sidebarTransparency = "riffet.sidebar-transparency"
    static let contentTransparency = "riffet.content-transparency"
    /// The settings window's selected section (`SettingsSection.rawValue`).
    static let settingsSection = "riffet.settings-section"
}

/// The settings window's panes, plus the panes they replaced.
///
/// The raw values are persisted in `riffet.settings-section`, used by `riffet://settings?section=`
/// and by the perf benchmark's report keys. Rename the display title, never the case. An earlier
/// pane's case stays so stored selections and links open the pane that took it over (`pane`).
/// `appearance` is the theme pane: the appearance pane it named was split into its group's pages.
enum SettingsSection: String, CaseIterable, Identifiable {
    case profile, general, appearance, window, tabs, typography, terminal, appIcon
    case input, shortcuts, notifications, files
    case agents, auxiliaryModels, quickChat
    case connection, shares, channels, server, backup
    case diagnostics, about
    case cli, service, projectConfigs

    var id: String { rawValue }

    /// The pane that shows this section. Project configuration opens as a sheet over 模型设置.
    var pane: SettingsSection {
        switch self {
        case .cli, .projectConfigs: .agents
        case .service: .server
        default: self
        }
    }

    var title: String {
        switch pane {
        case .profile: String(localized: "个人资料")
        case .appearance: String(localized: "主题")
        case .window: String(localized: "界面")
        case .tabs: String(localized: "标签页")
        case .typography: String(localized: "排版")
        case .terminal: String(localized: "终端")
        case .appIcon: String(localized: "应用图标")
        case .input: String(localized: "输入")
        case .shortcuts: String(localized: "快捷键")
        case .notifications: String(localized: "通知")
        case .files: String(localized: "文件与编辑器")
        case .agents: String(localized: "模型设置")
        case .auxiliaryModels: String(localized: "辅助模型")
        case .quickChat: String(localized: "快速对话")
        case .connection: String(localized: "连接与设备")
        case .shares: String(localized: "会话分享")
        case .channels: String(localized: "机器人")
        case .server: String(localized: "本机服务器")
        case .backup: String(localized: "备份与恢复")
        case .diagnostics: String(localized: "诊断")
        case .about: String(localized: "关于 Riffet")
        default: String(localized: "通用设置")
        }
    }

    var symbol: String {
        switch pane {
        case .profile: "person.crop.circle"
        case .appearance: "paintpalette"
        case .window: "macwindow"
        case .tabs: "rectangle.split.3x1"
        case .typography: "textformat.size"
        case .terminal: "terminal"
        case .appIcon: "app.badge"
        case .input: "character.cursor.ibeam"
        case .shortcuts: "command"
        case .notifications: "bell"
        case .files: "folder"
        case .agents: "sparkles"
        case .auxiliaryModels: "wand.and.stars"
        case .quickChat: "bubble.left.and.bubble.right"
        case .connection: "laptopcomputer.and.iphone"
        case .shares: "square.and.arrow.up"
        case .channels: "paperplane"
        case .server: "server.rack"
        case .backup: "externaldrive"
        case .diagnostics: "stethoscope"
        case .about: "info.circle"
        default: "gearshape"
        }
    }

    var group: SettingsGroup {
        switch pane {
        case .appearance, .window, .tabs, .typography, .terminal, .appIcon: .appearance
        case .input, .shortcuts, .notifications, .files: .behavior
        case .agents, .auxiliaryModels, .quickChat: .models
        case .connection, .shares, .channels, .server, .backup: .connection
        case .diagnostics, .about: .support
        default: .general
        }
    }

    /// What the pane holds, for the command palette and the sidebar's tooltip.
    var summary: String {
        switch pane {
        case .profile: String(localized: "名称与头像")
        case .appearance: String(localized: "明暗、配色主题与自定义主题")
        case .window: String(localized: "材质与透明度")
        case .tabs: String(localized: "标签栏与打开方式")
        case .typography: String(localized: "文字大小、间距与阅读宽度")
        case .terminal: String(localized: "终端字号与边距")
        case .appIcon: String(localized: "Dock 中的应用图标")
        case .input: String(localized: "发送键与运行中发送的消息")
        case .shortcuts: String(localized: "全局快捷键与应用内快捷键")
        case .notifications: String(localized: "系统通知与网页端提醒")
        case .files: String(localized: "编辑器、任务文件与文件访问")
        case .agents: String(localized: "Agent、提供商与新会话默认")
        case .auxiliaryModels: String(localized: "会话标题与交接摘要")
        case .quickChat: String(localized: "默认模型与归档")
        case .connection: String(localized: "服务器与已配对设备")
        case .shares: String(localized: "已发布的分享链接")
        case .channels: String(localized: "飞书机器人与可用账号")
        case .server: String(localized: "状态、数据目录与资源回收")
        case .backup: String(localized: "备份位置与恢复")
        case .diagnostics: String(localized: "诊断信息与性能监测")
        case .about: String(localized: "版本与更新")
        default: String(localized: "语言、启动与审批")
        }
    }

    /// Extra search terms, separated by spaces. The sidebar matches title, summary and these words.
    var keywords: String {
        switch pane {
        case .profile: String(localized: "个人 资料 名称 昵称 头像 profile name avatar", comment: "Search terms, space-separated")
        case .appearance: String(localized: "外观 主题 颜色 配色 暗色 浅色 明暗 appearance theme", comment: "Search terms, space-separated")
        case .window: String(localized: "外观 窗口 材质 透明 玻璃 磨砂 侧栏 window material", comment: "Search terms, space-separated")
        case .tabs: String(localized: "标签 标签栏 会话 快捷键 tab tabs shortcut", comment: "Search terms, space-separated")
        case .typography: String(localized: "外观 文字 字号 字体 间距 宽度 预览 font", comment: "Search terms, space-separated")
        case .terminal: String(localized: "外观 终端 字号 边距 terminal", comment: "Search terms, space-separated")
        case .appIcon: String(localized: "外观 图标 dock icon", comment: "Search terms, space-separated")
        case .input: String(localized: "回车 enter 发送 排队 引导 steer queue 键盘", comment: "Search terms, space-separated")
        case .shortcuts: String(localized: "快捷 热键 快捷键 键盘 hotkey shortcut command", comment: "Search terms, space-separated")
        case .notifications: String(localized: "通知 提醒 权限 notification", comment: "Search terms, space-separated")
        case .files: String(localized: "编辑器 文件 路径 editor 读取", comment: "Search terms, space-separated")
        case .agents: String(localized: "模型 提供商 网关 api key 审批 provider backend agent cursor cli 项目配置 rules skills commands", comment: "Search terms, space-separated")
        case .auxiliaryModels: String(localized: "标题 交接 摘要 模型 title handoff summary model", comment: "Search terms, space-separated")
        case .quickChat: String(localized: "快速会话 归档 chat quick archive retention", comment: "Search terms, space-separated")
        case .connection: String(localized: "服务器 设备 配对 配对码 二维码 地址 remote", comment: "Search terms, space-separated")
        case .shares: String(localized: "分享 链接 发布 取消分享 share publish link", comment: "Search terms, space-separated")
        case .channels: String(localized: "机器人 飞书 lark 卡片 绑定 群聊 话题 bot feishu channel", comment: "Search terms, space-separated")
        case .server: String(localized: "守护进程 启动 重启 日志 doctor 托管 daemon 回收 监控 cpu 内存 进程", comment: "Search terms, space-separated")
        case .backup: String(localized: "备份 恢复 backup restore", comment: "Search terms, space-separated")
        case .diagnostics: String(localized: "诊断 导出 性能 帧率 基准 diagnostics performance", comment: "Search terms, space-separated")
        case .about: String(localized: "版本 更新 关于 version update", comment: "Search terms, space-separated")
        default: String(localized: "语言 language 菜单栏 登录 启动 后台 touch id 审批", comment: "Search terms, space-separated")
        }
    }

    /// Where most of the pane's settings live, stated once at the end of the pane
    /// (`SettingsScopeFooter`). A section stored elsewhere carries its own badge. `nil` for panes
    /// about this Mac's app and service.
    var scope: SettingsScope? {
        switch pane {
        case .general, .appearance, .window, .tabs, .typography, .terminal, .appIcon, .shortcuts, .notifications, .connection: .mac
        case .input, .files, .agents, .auxiliaryModels, .quickChat, .shares, .channels: .server
        default: nil
        }
    }

    /// The sidebar and command palette walk these, in order.
    @MainActor static var navigable: [SettingsSection] {
        // The tab pane is the Riffet style's: other styles draw no tabs.
        all.filter { $0 != .tabs || DisplayPreferences.shared.style.header == .sessionTabs }
    }

    private static let all: [SettingsSection] = [
        .profile, .general,
        .appearance, .window, .tabs, .typography, .terminal, .appIcon,
        .input, .shortcuts, .notifications, .files,
        .agents, .auxiliaryModels, .quickChat,
        .connection, .shares, .channels, .server, .backup,
        .diagnostics, .about,
    ]
}

/// The sidebar's groups. 通用设置 stands alone at the top, untitled; the others are titled.
enum SettingsGroup: String, CaseIterable, Identifiable {
    case general, appearance, behavior, models, connection, support

    var id: String { rawValue }

    var title: String? {
        switch self {
        case .general: nil
        case .appearance: String(localized: "外观")
        case .behavior: String(localized: "行为")
        case .models: String(localized: "模型")
        case .connection: String(localized: "连接")
        case .support: String(localized: "支持")
        }
    }

    @MainActor var sections: [SettingsSection] {
        SettingsSection.navigable.filter { $0.group == self }
    }
}

/// The display preferences as observable values, so changing one re-renders what reads it.
@MainActor
@Observable
final class DisplayPreferences {
    static let shared = DisplayPreferences()
    static let defaultTerminalHorizontalPadding: Double = 24
    static let defaultTerminalVerticalPadding: Double = 16

    var appearance: String { didSet { save(PreferenceKey.appearance, appearance); applyAppearance() } }
    var textScale: Double { didSet { save(PreferenceKey.textScale, textScale) } }
    var density: Double { didSet { save(PreferenceKey.density, density) } }
    var terminalFontSize: Double { didSet { save(PreferenceKey.terminalFontSize, terminalFontSize) } }
    var terminalHorizontalPadding: Double { didSet { save(PreferenceKey.terminalHorizontalPadding, terminalHorizontalPadding) } }
    var terminalVerticalPadding: Double { didSet { save(PreferenceKey.terminalVerticalPadding, terminalVerticalPadding) } }
    var contentWidth: Double { didSet { save(PreferenceKey.contentWidth, contentWidth) } }
    /// The reading column until the reader drags or sets it; 640 is the narrowest it goes.
    static let defaultContentWidth: Double = 760
    var chapterNavigation: Bool { didSet { save(PreferenceKey.chapterNavigation, chapterNavigation) } }
    var sessionOverview: Bool { didSet { save(PreferenceKey.sessionOverview, sessionOverview) } }
    var railDots: Bool { didSet { save(PreferenceKey.railDots, railDots) } }
    var appIcon: String { didSet { save(PreferenceKey.appIcon, appIcon); applyIcon() } }
    var windowMaterial: WindowMaterial { didSet { save(PreferenceKey.windowMaterial, windowMaterial.rawValue) } }
    var interfaceStyle: InterfaceStyle {
        didSet {
            save(PreferenceKey.interfaceStyle, interfaceStyle.rawValue)
            NotificationCenter.default.post(name: .riffetInterfaceStyleChanged, object: nil)
        }
    }
    var codeTheme: String { didSet { save(PreferenceKey.codeTheme, codeTheme) } }
    /// The recipe of the style on screen.
    var style: StyleSpec { interfaceStyle.spec }
    /// 0–100, for the sidebar and the content each.
    var sidebarTransparency: Double { didSet { save(PreferenceKey.sidebarTransparency, sidebarTransparency) } }
    var contentTransparency: Double { didSet { save(PreferenceKey.contentTransparency, contentTransparency) } }
    /// The system's 降低透明度, which overrides the material.
    private(set) var reduceTransparency = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency

    /// A flat window (`StyleSpec.Window.flat`) is one opaque sheet whatever the material.
    var materialApplies: Bool { style.window != .flat }
    /// The material on screen: the stored one unless the system asks for no transparency or the
    /// style draws no material.
    var material: WindowMaterial { reduceTransparency || !materialApplies ? .solid : windowMaterial }
    /// Alpha of the palette's sidebar and content colours over the material.
    var sidebarTint: Double { material == .solid ? 1 : 1 - sidebarTransparency / 100 }
    var contentTint: Double { material == .solid ? 1 : 1 - contentTransparency / 100 }

    private init() {
        let defaults = UserDefaults.standard
        appearance = defaults.string(forKey: PreferenceKey.appearance) ?? "system"
        textScale = defaults.object(forKey: PreferenceKey.textScale) as? Double ?? 1.0
        density = defaults.object(forKey: PreferenceKey.density) as? Double ?? 1.0
        terminalFontSize = defaults.object(forKey: PreferenceKey.terminalFontSize) as? Double ?? 12
        terminalHorizontalPadding = Self.terminalPadding(
            defaults.object(forKey: PreferenceKey.terminalHorizontalPadding),
            defaultValue: Self.defaultTerminalHorizontalPadding, in: 0...48
        )
        terminalVerticalPadding = Self.terminalPadding(
            defaults.object(forKey: PreferenceKey.terminalVerticalPadding),
            defaultValue: Self.defaultTerminalVerticalPadding, in: 0...32
        )
        contentWidth = defaults.object(forKey: PreferenceKey.contentWidth) as? Double ?? DisplayPreferences.defaultContentWidth
        chapterNavigation = defaults.object(forKey: PreferenceKey.chapterNavigation) as? Bool ?? true
        sessionOverview = defaults.object(forKey: PreferenceKey.sessionOverview) as? Bool ?? true
        railDots = defaults.object(forKey: PreferenceKey.railDots) as? Bool ?? false
        appIcon = defaults.string(forKey: PreferenceKey.appIcon) ?? AppIconVariant.defaultId
        windowMaterial = defaults.string(forKey: PreferenceKey.windowMaterial)
            .flatMap(WindowMaterial.init(rawValue:))
            .flatMap { WindowMaterial.available.contains($0) ? $0 : nil } ?? .defaultValue
        // `claude` was the line style's id before it was renamed.
        interfaceStyle = defaults.string(forKey: PreferenceKey.interfaceStyle)
            .map { $0 == "claude" ? InterfaceStyle.line.rawValue : $0 }
            .flatMap(InterfaceStyle.init(rawValue:)) ?? .defaultValue
        let storedCodeTheme = defaults.string(forKey: PreferenceKey.codeTheme)
        codeTheme = storedCodeTheme.flatMap { id in
            RiffetCodeThemeCatalog.all.contains(where: { $0.id == id }) || ThemeLibraryRules.isValidID(id) ? id : nil
        } ?? "auto"
        sidebarTransparency = defaults.object(forKey: PreferenceKey.sidebarTransparency) as? Double ?? 60
        contentTransparency = defaults.object(forKey: PreferenceKey.contentTransparency) as? Double ?? 0
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                DisplayPreferences.shared.reduceTransparency = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
            }
        }
    }

    private func save(_ key: String, _ value: Any) {
        UserDefaults.standard.set(value, forKey: key)
    }

    private static func terminalPadding(_ stored: Any?, defaultValue: Double, in range: ClosedRange<Double>) -> Double {
        guard let number = stored as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return defaultValue }
        let value = number.doubleValue
        return min(max(value, range.lowerBound), range.upperBound)
    }

    func applyAppearance() {
        switch appearance {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }

    /// Only the running app's icon changes: once it quits, the Dock shows the bundle's icon again.
    func applyIcon() {
        NSApp.applicationIconImage = AppIconVariant.named(appIcon).image
    }
}

/// A font size on the shared ladder, scaled by the reader's text size preference.
@MainActor
func S(_ size: CGFloat) -> CGFloat { ladderTextSize(size) * DisplayPreferences.shared.textScale }
