import AppKit
import SwiftUI

extension Notification {
    /// The event is for [workbench]'s window. An event that names no workbench is for none: a
    /// broadcast would act in every window at once.
    @MainActor
    func targets(_ workbench: Workbench?) -> Bool {
        guard let target = object as? Workbench else { return false }
        return target === workbench
    }
}

private struct WorkbenchScopeKey: EnvironmentKey {
    static let defaultValue: Workbench? = nil
}

extension EnvironmentValues {
    /// The workbench of the window this view is in, for views that answer window-scoped events.
    var workbenchScope: Workbench? {
        get { self[WorkbenchScopeKey.self] }
        set { self[WorkbenchScopeKey.self] = newValue }
    }
}

/// Which workbench each window shows, for code that is called from AppKit and so has no SwiftUI
/// environment (a click on a path in the transcript).
@MainActor
enum WorkbenchWindows {
    private static let table = NSMapTable<NSWindow, Workbench>.weakToWeakObjects()

    /// The conversation windows' workbenches, each pinned to the session it shows.
    private static let conversations = NSHashTable<Workbench>.weakObjects()
    private static var pendingFocus: [String: TranscriptFocus] = [:]

    static func bind(_ workbench: Workbench, to window: NSWindow) {
        table.setObject(workbench, forKey: window)
    }

    static func register(_ workbench: Workbench) {
        conversations.add(workbench)
        if let sessionId = workbench.windowSessionId,
           let focus = pendingFocus.removeValue(forKey: sessionId) {
            workbench.focus = focus
        }
    }

    /// A search can open a conversation before SwiftUI has created its workbench.
    static func prepareFocus(_ focus: TranscriptFocus, for sessionId: String) {
        if let workbench = workbench(showing: sessionId) { workbench.focus = focus }
        else { pendingFocus[sessionId] = focus }
    }

    static func unregister(_ workbench: Workbench) { conversations.remove(workbench) }

    private static func workbench(showing sessionId: String) -> Workbench? {
        conversations.allObjects.first { $0.windowSessionId == sessionId }
    }

    static func window(of workbench: Workbench) -> NSWindow? {
        let windows = table.keyEnumerator().allObjects.compactMap { $0 as? NSWindow }
        return windows.first { table.object(forKey: $0) === workbench }
    }

    /// A window the reader can see shows [sessionId]: it needs no notification.
    static func isVisiblyShowing(_ sessionId: String) -> Bool {
        guard let workbench = workbench(showing: sessionId), let window = window(of: workbench) else { return false }
        return window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
    }

    /// Brings the window showing [sessionId] forward. False when no window shows it (a window still
    /// being built has no NSWindow bound yet and counts as none; SwiftUI focuses it by its value).
    @discardableResult
    static func focus(_ sessionId: String, transcriptFocus: TranscriptFocus? = nil) -> Bool {
        guard let workbench = workbench(showing: sessionId) else { return false }
        if let transcriptFocus { workbench.focus = transcriptFocus }
        guard let window = window(of: workbench) else { return false }
        NSApp.activate()
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        return true
    }

}

/// Registers the workbench with the window it lands in.
struct WorkbenchWindowBinder: NSViewRepresentable {
    let workbench: Workbench

    final class Anchor: NSView {
        var workbench: Workbench?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window, let workbench { WorkbenchWindows.bind(workbench, to: window) }
        }
    }

    func makeNSView(context: Context) -> Anchor {
        let anchor = Anchor()
        anchor.workbench = workbench
        return anchor
    }

    func updateNSView(_ anchor: Anchor, context: Context) {
        anchor.workbench = workbench
        if let window = anchor.window { WorkbenchWindows.bind(workbench, to: window) }
    }
}

/// Gives the window the style's title bar (`StyleSpec.TitleBar`). The scene opens every window with
/// the unified toolbar; a compact one is shorter and, on macOS 26, rounds the window less. The
/// traffic lights move [lightsDrop] points down from where the title bar puts them
/// (`CustomChrome.trafficLightsDrop`).
struct WindowTitleBarBinder: NSViewRepresentable {
    let titleBar: StyleSpec.TitleBar
    var lightsDrop: CGFloat = 0

    final class Anchor: NSView {
        var toolbarStyle: NSWindow.ToolbarStyle = .unified
        var drop: CGFloat = 0
        /// Each button's height as AppKit last laid it out, and the one it was moved to.
        private var heights: [ObjectIdentifier: (system: CGFloat, moved: CGFloat)] = [:]
        private var observers: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            heights = [:]
            guard let window else { return }
            // The title bar lays its buttons out again on resizing, full screen and key changes.
            for button in Self.buttons(window) {
                button.postsFrameChangedNotifications = true
                observers.append(NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: button, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.placeLights() }
                })
            }
            apply()
        }

        func apply() {
            if let window, window.toolbarStyle != toolbarStyle { window.toolbarStyle = toolbarStyle }
            placeLights()
        }

        private static func buttons(_ window: NSWindow) -> [NSButton] {
            [.closeButton, .miniaturizeButton, .zoomButton].compactMap { window.standardWindowButton($0) }
        }

        private func placeLights() {
            // In full screen the lights are in the menu bar's strip, which keeps its own layout.
            guard let window, !window.styleMask.contains(.fullScreen) else { return }
            for button in Self.buttons(window) {
                guard let container = button.superview else { continue }
                let key = ObjectIdentifier(button)
                let y = button.frame.origin.y
                var entry = heights[key] ?? (y, y)
                // Anywhere but where it was moved, AppKit has placed it anew.
                if abs(y - entry.moved) > 0.5 { entry.system = y }
                entry.moved = entry.system + (container.isFlipped ? drop : -drop)
                heights[key] = entry
                if abs(y - entry.moved) > 0.5 { button.setFrameOrigin(NSPoint(x: button.frame.origin.x, y: entry.moved)) }
            }
        }
    }

    func makeNSView(context: Context) -> Anchor { Anchor() }

    func updateNSView(_ anchor: Anchor, context: Context) {
        anchor.toolbarStyle = titleBar == .compact ? .unifiedCompact : .unified
        anchor.drop = lightsDrop
        anchor.apply()
    }
}
