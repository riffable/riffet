import SwiftUI
import RiffetKit

/// Retains presentation values, never the actions captured by a former view. A region belongs to
/// one source slot; the caller keys it by its server/session scope and reads live state for actions.
struct FeedbackRegion<Value: Equatable, Content: View>: View {
    let value: Value?
    var active = true
    var holding = false
    var renewal = 0
    var identity: ((Value) -> AnyHashable)?
    @ViewBuilder let content: (Value, Bool) -> Content
    @Environment(\.covered) private var covered
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.feedbackPresented) private var presented
    @State private var entries: [Entry] = []
    @State private var wake: Task<Void, Never>?
    @State private var applicationActive = NSApp.isActive

    @Observable final class Entry: Identifiable {
        let id = UUID()
        var value: Value
        let timing = FeedbackTiming(minimumVisibleMillis: feedbackMinimumVisibleMillis())
        var appeared = false
        var current = true
        var visibleProbes: Set<UUID> = []
        var actuallyVisible: Bool { !visibleProbes.isEmpty }
        init(_ value: Value) { self.value = value }
    }

    private var visible: Bool { active && presented && !covered && applicationActive && scenePhase == .active }

    var body: some View {
        ForEach(entries) { entry in
            content(entry.value, entry.current && matches(value, entry.value))
                .background {
                    FeedbackVisibilityProbe { id, visible in
                        if visible { entry.visibleProbes.insert(id) } else { entry.visibleProbes.remove(id) }
                        refresh()
                    }
                }
                .task {
                    // This row's existing size/opacity transition lasts 180ms. The enclosing
                    // assembly entrance independently reports completion through the environment.
                    do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                    guard !Task.isCancelled else { return }
                    entry.appeared = true
                    refresh()
                }
        }
        .animation(reduceMotion ? nil : ComposerMotion.resize, value: entries.map(\.id))
        .onChange(of: value, initial: true) { _, value in reconcile(value) }
        .onChange(of: renewal) { _, _ in
            let now = ProcessInfo.processInfo.systemUptime * 1000
            for entry in entries where entry.current { entry.timing.restart(nowMillis: now) }
            refresh()
        }
        .onChange(of: visible) { _, _ in refresh() }
        .onChange(of: holding) { _, _ in refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in applicationActive = true }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in applicationActive = false }
        .onDisappear {
            wake?.cancel()
            wake = nil
            let now = ProcessInfo.processInfo.systemUptime * 1000
            for entry in entries { _ = entry.timing.update(nowMillis: now, visible: false) }
        }
    }

    private func reconcile(_ value: Value?) {
        let now = ProcessInfo.processInfo.systemUptime * 1000
        for entry in entries {
            _ = entry.timing.update(nowMillis: now, visible: visible && entry.appeared && entry.actuallyVisible)
            let current = matches(value, entry.value)
            if current && !entry.current { entry.timing.restart(nowMillis: now) }
            entry.current = current
            if current, let value, entry.value != value { entry.value = value }
        }
        if let value, !entries.contains(where: { matches(value, $0.value) }) { entries.append(Entry(value)) }
        refresh()
    }

    private func matches(_ current: Value?, _ held: Value) -> Bool {
        guard let current else { return false }
        return identity.map { $0(current) == $0(held) } ?? (current == held)
    }

    private func refresh() {
        wake?.cancel()
        wake = nil
        let now = ProcessInfo.processInfo.systemUptime * 1000
        for entry in entries { _ = entry.timing.update(nowMillis: now, visible: visible && entry.appeared && entry.actuallyVisible) }
        let remaining = entries.filter { $0.current || !$0.timing.complete || holding }
        if remaining.count != entries.count { entries = remaining }
        guard visible, let next = entries.filter({ $0.appeared && $0.actuallyVisible && !$0.timing.complete }).map({ $0.timing.remainingMillis }).min() else { return }
        wake = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(max(1, next))) } catch { return }
            guard !Task.isCancelled else { return }
            refresh()
        }
    }
}

extension EnvironmentValues {
    @Entry var feedbackPresented = true
}

/// AppKit computes clipping in the view's own coordinates, including every enclosing clip view.
/// This probe observes only its window and enclosing scroll clips; it never drives layout.
struct FeedbackVisibilityProbe: NSViewRepresentable {
    let changed: (UUID, Bool) -> Void

    func makeNSView(context: Context) -> Probe { Probe(changed: changed) }
    func updateNSView(_ view: Probe, context: Context) {
        view.changed = changed
        view.refresh()
    }
    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.stop() }

    final class Probe: NSView {
        let visibilityID = UUID()
        var changed: (UUID, Bool) -> Void
        private var observers: [NSObjectProtocol] = []
        private var reported: Bool?
        private var generation = 0

        init(changed: @escaping (UUID, Bool) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
            postsFrameChangedNotifications = true
        }
        required init?(coder: NSCoder) { fatalError() }
        deinit { observers.forEach(NotificationCenter.default.removeObserver) }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func layout() { super.layout(); refresh() }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); observe(); refresh() }
        override func viewDidMoveToSuperview() { super.viewDidMoveToSuperview(); observe(); refresh() }

        func refresh() {
            let visible = window?.isVisible == true && window?.isMiniaturized == false && window?.occlusionState.contains(.visible) == true && !isHiddenOrHasHiddenAncestor &&
                bounds.width > 0 && bounds.height > 0 && visibleRect.contains(bounds)
            guard reported != visible else { return }
            reported = visible
            generation += 1
            let ticket = generation
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == ticket else { return }
                self.changed(self.visibilityID, visible)
            }
        }

        func stop() {
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            generation += 1
            let callback = changed
            let id = visibilityID
            DispatchQueue.main.async { callback(id, false) }
        }

        private func observe() {
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { return }
            let center = NotificationCenter.default
            observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: self, queue: .main) { [weak self] _ in self?.refresh() })
            for name in [NSWindow.didResizeNotification, NSWindow.didMiniaturizeNotification,
                         NSWindow.didDeminiaturizeNotification, NSWindow.didChangeOcclusionStateNotification] {
                observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in self?.refresh() })
            }
            var parent = superview
            while let current = parent {
                if let clip = current as? NSClipView {
                    clip.postsBoundsChangedNotifications = true
                    observers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in self?.refresh() })
                }
                parent = current.superview
            }
        }
    }
}
