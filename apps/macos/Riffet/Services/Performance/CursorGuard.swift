import AppKit
import ObjectiveC
import QuartzCore

/// Skips setting the cursor that was just set. AppKit sets the cursor again whenever tracking areas
/// move or change (scrolling a list of hoverable rows, switching pages), and with a customised
/// system pointer (Accessibility → Display → Pointer) every set renders the pointer image anew,
/// a few milliseconds each. A repeat within a quarter second is dropped; anything else, and every
/// set after the app becomes active, goes through.
@MainActor
enum CursorGuard {
    /// Main thread only; `riffetGuardedSet` passes any other thread straight through.
    nonisolated(unsafe) fileprivate static weak var last: NSCursor?
    nonisolated(unsafe) fileprivate static var lastAt: CFTimeInterval = 0
    private static var installed = false

    /// `defaults write <bundle id> riffet.cursor-guard-off -bool YES` leaves AppKit alone (to compare).
    static func install() {
        guard !installed, !UserDefaults.standard.bool(forKey: "riffet.cursor-guard-off") else { return }
        installed = true
        guard let original = class_getInstanceMethod(NSCursor.self, #selector(NSCursor.set)),
              let replacement = class_getInstanceMethod(NSCursor.self, #selector(NSCursor.riffetGuardedSet)) else { return }
        method_exchangeImplementations(original, replacement)
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification, NSWindow.didBecomeKeyNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { last = nil }
            }
        }
    }
}

extension NSCursor {
    /// Swapped with `set` by `CursorGuard.install`; calling it from here reaches the original.
    @objc fileprivate func riffetGuardedSet() {
        guard Thread.isMainThread else { return riffetGuardedSet() }
        let now = CACurrentMediaTime()
        if CursorGuard.last === self, now - CursorGuard.lastAt < 0.25 { return }
        CursorGuard.last = self
        CursorGuard.lastAt = now
        riffetGuardedSet()
    }
}
