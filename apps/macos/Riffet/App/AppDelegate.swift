import AppKit
import CoreSpotlight
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let services = ServicesProvider()

    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            NSApp.servicesProvider = services
            NSUpdateDynamicServices()
            AppPresence.observeWindows()
            DisplayPreferences.shared.applyAppearance()
            DisplayPreferences.shared.applyIcon()
            QuickPrompt.install()
            Updater.shared.start()
            WidgetSnapshotWriter.start()
            CursorGuard.install()
            PerfMonitor.shared.startIfEnabled()
            InstallLocation.warnIfNeeded()
            Task { await AppModel.shared.start() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { MainActor.assumeIsolated { WindowRouter.shared.showMain() } }
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        MainActor.assumeIsolated {
            AppModel.shared.host.foreground = true
            PluginsStore.shared.appBecameActive()
            Task { await AppModel.shared.checkService() }
        }
    }

    func applicationDidResignActive(_ notification: Notification) {
        MainActor.assumeIsolated {
            AppModel.shared.host.foreground = false
            PluginsStore.shared.appResigned()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            AppModel.shared.host.flushAll()
            AppLanguage.relaunchIfRestarting()
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated {
            for url in urls { URLRouter.handle(url) }
        }
    }

    func application(_ application: NSApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void) -> Bool {
        guard userActivity.activityType == CSSearchableItemActionType,
              let identifier = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return false }
        MainActor.assumeIsolated {
            WindowRouter.shared.showMain()
            AppModel.shared.whenReady { $0.open(sessionId: identifier) }
        }
        return true
    }
}

/// Dock icon or menu bar only. The menu bar item is always there. The setting is a preference: the
/// Dock icon and the app switcher entry go only when the last main window closes with it on, and come
/// back whenever a main window appears again (menu bar, notification, link, Dock reopen).
enum AppPresence {
    private static let key = "riffet.menu-bar-only"

    static var menuBarOnly: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    private static func isMain(_ window: NSWindow?) -> Bool {
        window?.identifier?.rawValue.hasPrefix(WindowRouter.mainWindow) == true
    }

    private static func mainWindowShown(besides closing: NSWindow? = nil) -> Bool {
        NSApp.windows.contains { isMain($0) && $0 !== closing && ($0.isVisible || $0.isMiniaturized) }
    }

    @MainActor
    static func observeWindows() {
        let center = NotificationCenter.default
        center.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { note in
            MainActor.assumeIsolated {
                guard menuBarOnly, let window = note.object as? NSWindow, isMain(window), !mainWindowShown(besides: window) else { return }
                NSApp.setActivationPolicy(.accessory)
            }
        }
        center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { note in
            MainActor.assumeIsolated {
                guard isMain(note.object as? NSWindow), NSApp.activationPolicy() != .regular else { return }
                NSApp.setActivationPolicy(.regular)
                DisplayPreferences.shared.applyIcon()
                NSApp.activate()
            }
        }
    }

    /// Brings the policy in line with the preference, after the setting changed.
    @MainActor
    static func apply() {
        let hidden = menuBarOnly && !mainWindowShown()
        let policy: NSApplication.ActivationPolicy = hidden ? .accessory : .regular
        guard NSApp.activationPolicy() != policy else { return }
        NSApp.setActivationPolicy(policy)
        // A Dock tile that comes back may show the bundle's icon again (as in observeWindows).
        if policy == .regular { DisplayPreferences.shared.applyIcon() }
    }
}

/// Where the app runs from matters: a Claude hook command is the absolute path of the bundled node
/// inside this app (docs/MACOS.md, "签名、公证与分发"). A copy run from Downloads is translocated to a
/// random read-only path and the hooks it writes break the moment it is quit.
enum InstallLocation {
    private static let key = "riffet.install-location-warned"

    static var translocated: Bool { Bundle.main.bundlePath.contains("/AppTranslocation/") }

    private static var inApplications: Bool {
        let path = Bundle.main.bundlePath
        return path.hasPrefix("/Applications/") || path.hasPrefix(NSHomeDirectory() + "/Applications/")
    }

    /// Asks once to move the app to Applications (every launch while it is translocated: it is broken
    /// until then). Only builds that carry the server matter: a development build runs from its
    /// build folder on purpose.
    @MainActor
    static func warnIfNeeded() {
        let misplaced = !inApplications && AppModel.shared.server.canHostServer
        guard translocated || misplaced else { return }
        if !translocated {
            guard UserDefaults.standard.string(forKey: key) != Bundle.main.bundlePath else { return }
            UserDefaults.standard.set(Bundle.main.bundlePath, forKey: key)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            MainActor.assumeIsolated { present() }
        }
    }

    @MainActor
    private static func present() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = translocated ? String(localized: "Riffet 正在被系统隔离运行") : String(localized: "请把 Riffet 放进「应用程序」文件夹")
        alert.informativeText = translocated
            ? String(localized: "你是直接从下载文件夹等位置打开的，系统把它放到了一个临时的只读位置，Agent 的 hook 命令会因此失效。请退出 Riffet，把它拖进「应用程序」文件夹，再从那里打开。")
            : String(localized: "Agent 的 hook 命令里记录的是这个 App 的路径，位置变动后会失效。请退出 Riffet，把它拖进「应用程序」文件夹，再从那里打开。")
        alert.addButton(withTitle: String(localized: "打开「应用程序」文件夹"))
        if !translocated { alert.addButton(withTitle: String(localized: "在 Finder 中显示")) }
        alert.addButton(withTitle: String(localized: "稍后"))
        NSApp.activate()
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications"))
        } else if response == .alertSecondButtonReturn, !translocated {
            NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
        }
    }
}
