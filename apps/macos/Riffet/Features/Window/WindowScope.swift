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

/// Moves the window's traffic lights [lightsDrop] points down from where the unified title bar puts
/// them (`CustomChrome.trafficLightsDrop`).
struct WindowTitleBarBinder: NSViewRepresentable {
    var lightsDrop: CGFloat = 0

    final class Anchor: NSView {
        var drop: CGFloat = 0

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
        }

        func apply() {
            guard let window else { return }
            TrafficLights.of(window).hold(drop)
        }
    }

    func makeNSView(context: Context) -> Anchor { Anchor() }

    func updateNSView(_ anchor: Anchor, context: Context) {
        anchor.drop = lightsDrop
        anchor.apply()
    }
}

/// Keeps a window's traffic lights [drop] points below where AppKit lays them out. One per window:
/// while a rebuilt view tree briefly holds two anchors in the window, and each keeping its
/// own record would take the other's move for AppKit's and push the buttons down without end.
@MainActor
private final class TrafficLights {
    private static let table = NSMapTable<NSWindow, TrafficLights>.weakToStrongObjects()

    static func of(_ window: NSWindow) -> TrafficLights {
        if let lights = table.object(forKey: window) { return lights }
        let lights = TrafficLights(window: window)
        table.setObject(lights, forKey: window)
        return lights
    }

    private weak var window: NSWindow?
    private var drop: CGFloat = 0
    /// Per button: the one placed (AppKit may replace them), where AppKit put it, where it was moved.
    private var placed: [NSWindow.ButtonType: Placement] = [:]
    private var placing = false
    private var pending = false

    private struct Placement {
        let button: NSButton
        let observer: NSObjectProtocol
        var system: CGFloat
        var moved: CGFloat
    }

    private init(window: NSWindow) {
        self.window = window
    }

    /// Also after a toolbar style change, which may lay the buttons out again or replace them.
    func hold(_ drop: CGFloat) {
        self.drop = drop
        place()
    }

    private func place() {
        // A move of our own posts a frame change; it is not AppKit laying the buttons out again.
        guard !placing, let window else { return }
        placing = true
        defer { placing = false }
        // In full screen the lights are in the menu bar's strip, which keeps its own layout.
        let fullScreen = window.styleMask.contains(.fullScreen)
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            guard let button = window.standardWindowButton(type), let container = button.superview else { continue }
            let y = button.frame.origin.y
            var entry: Placement
            if let known = placed[type], known.button === button {
                entry = known
                // Anywhere but where it was moved, AppKit has placed it anew.
                if abs(y - entry.moved) > 0.5 { entry.system = y }
            } else {
                if let old = placed[type] { NotificationCenter.default.removeObserver(old.observer) }
                entry = Placement(button: button, observer: observe(button), system: y, moved: y)
            }
            entry.moved = fullScreen ? entry.system : entry.system + (container.isFlipped ? drop : -drop)
            placed[type] = entry
            if abs(y - entry.moved) > 0.5 { button.setFrameOrigin(NSPoint(x: button.frame.origin.x, y: entry.moved)) }
        }
    }

    /// The title bar lays its buttons out again on resizing, full screen and key changes. Inside a
    /// button's own frame notification AppKit drops a move of that button, so the last one it lays
    /// out (the zoom button) is placed once more after the pass.
    private func observe(_ button: NSButton) -> NSObjectProtocol {
        button.postsFrameChangedNotifications = true
        return NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: button, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.placing else { return }
                self.place()
                guard !self.pending else { return }
                self.pending = true
                DispatchQueue.main.async { [weak self] in
                    self?.pending = false
                    self?.place()
                }
            }
        }
    }
}
