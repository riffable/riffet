import AppKit
import os

/// Every bounded cache in the app, by name (docs/guide/performance.md §3.1). It empties them when
/// the system asks for memory and when no window has been on screen for a while, and reports their
/// sizes for the memory samples.
final class CacheRegistry: @unchecked Sendable {
    static let shared = CacheRegistry()

    enum Level: Sendable {
        /// A system warning or an idle app: what is cheap to build again.
        case warning
        /// Critical pressure: everything.
        case critical
    }

    struct Snapshot: Sendable {
        let name: String
        /// Bytes held now; nil when the cache cannot report it.
        let bytes: Int64?
        let limit: Int64
    }

    private struct Entry {
        let limit: Int64
        let size: (() -> Int64?)?
        let evictsOnWarning: Bool
        let purge: () -> Void
    }

    private let lock = OSAllocatedUnfairLock<[String: Entry]>(uncheckedState: [:])
    private var pressure: DispatchSourceMemoryPressure?
    private var idleTimer: Timer?
    private var observers: [NSObjectProtocol] = []
    /// No window on screen for this long counts as idle.
    private static let idleDelay: TimeInterval = 300

    /// Adds [name], replacing an earlier cache with that name. [purge] runs on any thread.
    func register(
        _ name: String,
        limit: Int64,
        evictsOnWarning: Bool = true,
        size: (() -> Int64?)? = nil,
        purge: @escaping () -> Void
    ) {
        lock.withLock { $0[name] = Entry(limit: limit, size: size, evictsOnWarning: evictsOnWarning, purge: purge) }
    }

    func unregister(_ name: String) {
        lock.withLock { _ = $0.removeValue(forKey: name) }
    }

    func purge(_ level: Level) {
        let entries = lock.withLock { Array($0.values) }
        for entry in entries where level == .critical || entry.evictsOnWarning { entry.purge() }
    }

    func snapshot() -> [Snapshot] {
        let entries = lock.withLock { $0 }
        return entries.map { Snapshot(name: $0.key, bytes: $0.value.size?(), limit: $0.value.limit) }.sorted { $0.name < $1.name }
    }

    /// Listens for memory pressure and for the windows going away; call once at launch.
    @MainActor
    func start() {
        guard pressure == nil else { return }
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self, weak source] in
            guard let self, let source else { return }
            self.purge(source.data.contains(.critical) ? .critical : .warning)
        }
        source.resume()
        pressure = source
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification, NSWindow.didMiniaturizeNotification, NSWindow.willCloseNotification,
            NSApplication.didHideNotification, NSApplication.didUnhideNotification,
        ]
        for name in names {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                // The offscreen renderers' windows come and go without the user seeing anything.
                if let window = note.object as? NSWindow, window.alphaValue == 0 { return }
                MainActor.assumeIsolated { self?.windowsChanged() }
            })
        }
        // A launch without a window (menu bar only) starts counting too.
        windowsChanged()
    }

    @MainActor
    private func windowsChanged() {
        idleTimer?.invalidate()
        idleTimer = nil
        // A closing window is still in `windows` while its notification runs, so look again after it left.
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !Self.hasVisibleWindow else { return }
                self.idleTimer = Timer.scheduledTimer(withTimeInterval: Self.idleDelay, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard !Self.hasVisibleWindow else { return }
                        self?.purge(.warning)
                    }
                }
            }
        }
    }

    @MainActor
    private static var hasVisibleWindow: Bool {
        !NSApp.isHidden && NSApp.windows.contains { $0.isVisible && !$0.isMiniaturized && $0.level == .normal && $0.alphaValue > 0 }
    }
}
