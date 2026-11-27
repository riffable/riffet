import AppKit
import SwiftUI
import RiffetKit

@main
struct RiffetApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model: AppModel
    @State private var theme: ThemeStore

    init() {
        // First, before anything resolves a string: the bundle picks its localization once.
        AppLanguage.applyDefault()
        _model = State(initialValue: AppModel.shared)
        _theme = State(initialValue: ThemeStore.shared)
        // Its cache reads off the main thread, started now so they finish before the first window draws.
        _ = AppearanceStore.shared
        BundledFonts.register()
    }

    var body: some Scene {
        Window("Riffet", id: WindowRouter.mainWindow) {
            RootView()
                .environment(model)
                .environment(\.palette, theme.palette)
                .tint(theme.palette.accent)
                .modifier(TerminalLaunchAppearance(host: model.host, theme: theme.entry))
        }
        .defaultSize(width: 1360, height: 860)
        .windowResizability(.contentMinSize)
        // The window is how every other entry point (menu bar, notifications, links) reaches the
        // workbench; launching without one, because it was closed last time, would strand them.
        .defaultLaunchBehavior(.presented)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { RiffetCommands(model: model) }

        // One conversation per window, opened from a conversation's menu or the sidebar. SwiftUI
        // focuses the window that already shows a session instead of opening a second one, and
        // restores these windows with their session id at launch.
        WindowGroup("会话", id: ConversationWindow.id, for: String.self) { $sessionId in
            ConversationWindow(sessionId: sessionId)
                .environment(model)
                .environment(\.palette, theme.palette)
                .tint(theme.palette.accent)
                .modifier(TerminalLaunchAppearance(host: model.host, theme: theme.entry))
        }
        .defaultSize(width: 980, height: 800)
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified(showsTitle: false))

        WindowGroup("终端", id: TerminalWindow.id, for: String.self) { $terminalId in
            TerminalWindow(terminalId: terminalId)
                .environment(model)
                .environment(\.palette, theme.palette)
                .tint(theme.palette.accent)
                .modifier(TerminalLaunchAppearance(host: model.host, theme: theme.entry))
        }
        .defaultSize(width: 820, height: 520)
        .windowResizability(.contentMinSize)

        MenuBarExtra {
            MenuBarPanel()
                .environment(model)
                .environment(\.palette, theme.palette)
                .modifier(TerminalLaunchAppearance(host: model.host, theme: theme.entry))
        } label: {
            MenuBarLabel(model: model)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environment(model)
                .environment(\.palette, theme.palette)
                .tint(theme.palette.accent)
        }
        // The content's ideal size, so the window opens at the size the sections were laid out for
        // instead of being measured into place a few frames after it appears. Tall enough for the
        // whole settings sidebar, through the 支持 group.
        .defaultSize(width: 880, height: 780)
        // As the other windows: the content sets a minimum only. The Settings scene's default
        // (content size) re-derives the window's size limits from the content on every update,
        // which re-tiles the window frame while the first section lays out.
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified)
    }
}

/// Opens the main window from places that have no SwiftUI environment: notifications, URLs, services.
@MainActor
final class WindowRouter {
    static let shared = WindowRouter()
    static let mainWindow = "main"

    private var opener: OpenWindowAction?
    private var settingsOpener: OpenSettingsAction?

    func register(_ action: OpenWindowAction, settings: OpenSettingsAction) {
        opener = action
        settingsOpener = settings
    }

    func showSettings() {
        NSApp.activate()
        settingsOpener?()
    }

    /// Opens [sessionId] in its own window, or brings the one that has it forward. The main window
    /// gives up that conversation first, so one conversation never streams into two windows at once.
    func openConversation(_ sessionId: String, focus: TranscriptFocus? = nil) {
        if let focus { WorkbenchWindows.prepareFocus(focus, for: sessionId) }
        if WorkbenchWindows.focus(sessionId) { return }
        if let main = AppModel.shared.workbench, !main.showingHome, main.selected?.id == sessionId {
            main.showHome()
        }
        NSApp.activate()
        opener?(id: ConversationWindow.id, value: sessionId)
    }

    func openTerminal(_ terminalId: String) {
        NSApp.activate()
        opener?(id: TerminalWindow.id, value: terminalId)
    }

    func showMain() {
        NSApp.activate()
        if let window = NSApp.windows.first(where: { $0.identifier?.rawValue == Self.mainWindow }) {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        } else {
            opener?(id: Self.mainWindow)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        WindowContentLayout(minimum: CGSize(width: 760, height: 520)) {
            // The window is always the workbench shell; a missing server is said inside it (the
            // new-session page's setup card, `NeedsServerView`). Only the first launch's guide covers
            // it, and the splash shows while a known server is restored before any shell exists.
            if model.onboarding {
                OnboardingView().transition(.opacity)
            } else if let shell = model.shell {
                WorkbenchView(workbench: shell)
            } else {
                ConnectingView()
            }
        }
        .animation(Motion.expressive, value: model.onboarding)
        .onAppear { WindowRouter.shared.register(openWindow, settings: openSettings) }
    }
}

/// Content with a fixed minimum size. A window (or split view column) takes its minimum from its
/// content, and a `frame(minWidth:minHeight:)` answers that by measuring everything inside, on every
/// layout pass: every frame of the sidebar's animation measured the whole window.
struct WindowContentLayout: Layout {
    let minimum: CGSize
    var ideal = CGSize(width: 1360, height: 860)

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: max(minimum.width, proposal.width ?? ideal.width), height: max(minimum.height, proposal.height ?? ideal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews { subview.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size)) }
    }
}

struct ConnectingView: View {
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 12) {
            LiveBrandMark(front: palette.fg, back: palette.accent, style: .run).frame(width: 44, height: 44)
            Text("正在连接 Riffet…").font(RiffetFont.label).foregroundStyle(palette.fg3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// All creation surfaces publish the app's actual colours before a terminal process exists.
struct TerminalLaunchAppearance: ViewModifier {
    let host: MacHost
    let theme: ThemeEntry
    @Environment(\.colorScheme) private var colorScheme
    func body(content: Content) -> some View {
        content.onChange(of: "\(theme.id)|\(theme.revision)|\(colorScheme)", initial: true) { _, _ in
            let colors = colorScheme == .dark ? theme.values.dark : theme.values.light
            host.terminalAppearance = TerminalAppearance(foreground: String(colors.fg.hex.prefix(7)), background: String(colors.bg.hex.prefix(7)))
        }
    }
}
