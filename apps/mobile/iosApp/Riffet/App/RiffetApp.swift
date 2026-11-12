import SwiftUI
import UIKit
import AppIntents
import RiffetKit

/// The full-screen wait while the saved connection comes back: the mark at a gallop.
private struct LaunchSplash: View {
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            palette.bg.ignoresSafeArea()
            LiveBrandMark(front: palette.fg, back: palette.accent, style: .run).frame(width: 64, height: 64)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在恢复连接…")
    }
}

@main
struct RiffetApp: App {
    @UIApplicationDelegateAdaptor(RiffetAppDelegate.self) private var delegate
    @State private var model = AppModel.shared
    @State private var themeStore = ThemeStore()
    @State private var localization = AppLocalization.shared
    @Environment(\.scenePhase) private var phase
    @AppStorage("riffet.ios.appearance") private var appearance = "system"
    init() { RiffetNotifications.shared.install() }
    var body: some Scene {
        WindowGroup {
            Group {
                if model.starting { LaunchSplash() }
                else if let workbench = model.workbench { RiffetRootView(workbench: workbench).id(ObjectIdentifier(workbench)) }
                else { NavigationStack { PairingView(model: model) } }
            }
            .environment(model)
            .environment(themeStore)
            .environment(\.palette, themeStore.palette)
            .environment(\.locale, localization.locale)
            .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
            .tint(themeStore.palette.accent)
            .modifier(TerminalLaunchAppearance(host: model.host, theme: themeStore.entry))
            .onAppear { applyChrome() }
            // Bars already on screen keep the appearance proxy they were
            // built with; re-applying on a theme change at least re-points
            // every bar created from then on (the dynamic colour itself is
            // identity-stable, so nothing else needs to move).
            .onChange(of: themeStore.themeId) { applyChrome() }
            .task { await model.start() }
            .onChange(of: phase) { _, next in model.scene(next) }
            .onChange(of: RiffetNotifications.shared.openedSessionID) { _, _ in
                model.consumeNotification()
            }
            .onOpenURL { model.open($0) }
        }
        // A hardware keyboard's ⌘N, and the iPad menu bar; the app has one window, so this replaces New Window.
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新会话") { model.pendingPrompt = "" }.keyboardShortcut("n").disabled(model.workbench == nil)
            }
        }
    }

    /// Bar appearances for the whole app. On iOS 26 the bars are left to the
    /// system: Liquid Glass controls over the page, with the soft scroll edge
    /// fading content beneath them — any background set here would replace both.
    /// Earlier systems get a clear bar at the scroll edge and the default
    /// material once content scrolls under it, with no shadow line.
    private func restyle(_ view: UIView, navigation: UINavigationBarAppearance, tabs: UITabBarAppearance) {
        if let bar = view as? UINavigationBar {
            bar.standardAppearance = navigation; bar.scrollEdgeAppearance = navigation; bar.compactAppearance = navigation
        } else if let bar = view as? UITabBar {
            bar.standardAppearance = tabs; bar.scrollEdgeAppearance = tabs
        }
        for child in view.subviews { restyle(child, navigation: navigation, tabs: tabs) }
    }

    private func applyChrome() {
        if #available(iOS 26.0, *) { return }
        let navigation = UINavigationBarAppearance()
        navigation.configureWithDefaultBackground()
        navigation.shadowColor = .clear
        let edge = UINavigationBarAppearance()
        edge.configureWithTransparentBackground()
        UINavigationBar.appearance().standardAppearance = navigation
        UINavigationBar.appearance().scrollEdgeAppearance = edge
        UINavigationBar.appearance().compactAppearance = navigation
        let tabs = UITabBarAppearance()
        tabs.configureWithDefaultBackground()
        tabs.shadowColor = .clear
        UITabBar.appearance().standardAppearance = tabs
        UITabBar.appearance().scrollEdgeAppearance = tabs
        for window in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows) {
            restyle(window, navigation: navigation, tabs: tabs)
        }
    }
}

struct PrepareRiffetTask: AppIntent {
    static var title: LocalizedStringResource = "准备 Riffet 任务"
    static var description = IntentDescription("在 Riffet 打开新任务编辑页，检查项目与 Agent 后发送。")
    static var openAppWhenRun = true
    @Parameter(title: "任务内容") var prompt: String
    @MainActor func perform() async throws -> some IntentResult {
        AppModel.shared.pendingPrompt = prompt
        return .result()
    }
}
struct RiffetShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: PrepareRiffetTask(), phrases: ["使用 \(.applicationName) 准备任务"], shortTitle: "新任务", systemImageName: "square.and.pencil") // i18n-ignore: App Shortcut phrases use a separate catalog
    }
}

private struct TerminalLaunchAppearance: ViewModifier {
    let host: IOSHost
    let theme: ThemeEntry
    @Environment(\.colorScheme) private var colorScheme
    func body(content: Content) -> some View {
        content.onChange(of: "\(theme.id)|\(colorScheme)", initial: true) { _, _ in
            let colors = colorScheme == .dark ? theme.values.dark : theme.values.light
            host.terminalAppearance = TerminalAppearance(foreground: String(colors.fg.hex.prefix(7)), background: String(colors.bg.hex.prefix(7)))
        }
    }
}
