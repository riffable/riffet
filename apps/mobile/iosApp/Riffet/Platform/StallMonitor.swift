import Foundation
import os

/// Main-thread stalls, measured from the main run loop itself: the time between two consecutive
/// run-loop activities is one piece of uninterrupted work (a source, a timer, a queue drain, a
/// Core Animation commit); the gap from going to sleep until waking is idle and is not counted.
/// A piece longer than `hitchMs` is a hitch for the service monitor (docs/guide/performance.md §4).
///
/// Every stall over `logMs` goes to the unified log under category `perf`, so a person or a script
/// can watch a scenario with
/// `xcrun simctl spawn booted log stream --predicate 'subsystem == "io.github.riffable.iphone" AND category == "perf"'`.
/// The default is the hitch threshold; `-riffet.perf.stallMs 34` lowers it for one launch.
@MainActor
final class StallMonitor {
    static let shared = StallMonitor()
    static let hitchMs = 100.0

    private let log = Logger(subsystem: "io.github.riffable.iphone", category: "perf")
    private let logMs: Double
    private var observer: CFRunLoopObserver?
    private var last: CFAbsoluteTime = 0
    private var asleep = false
    private var hitches = 0

    private init() {
        let configured = UserDefaults.standard.double(forKey: "riffet.perf.stallMs")
        logMs = configured > 0 ? configured : Self.hitchMs
    }

    /// Installed once while the app is in the foreground; costs one clock read per run-loop activity.
    func running(_ active: Bool) {
        if active, observer == nil {
            last = CFAbsoluteTimeGetCurrent()
            asleep = false
            let activities = CFRunLoopActivity.allActivities.rawValue
            // Last in order, so the Core Animation commit before sleeping is inside the measured piece.
            let observer = CFRunLoopObserverCreateWithHandler(nil, activities, true, CFIndex.max) { _, activity in
                MainActor.assumeIsolated { StallMonitor.shared.observe(activity) }
            }
            CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
            self.observer = observer
        } else if !active, let observer {
            CFRunLoopObserverInvalidate(observer)
            self.observer = nil
        }
    }

    /// Hitches since the previous call.
    func takeHitches() -> Int {
        defer { hitches = 0 }
        return hitches
    }

    private func observe(_ activity: CFRunLoopActivity) {
        let now = CFAbsoluteTimeGetCurrent()
        defer { last = now; asleep = activity == .beforeWaiting }
        guard !asleep else { return }
        let ms = (now - last) * 1000
        guard ms >= logMs else { return }
        if ms >= Self.hitchMs { hitches += 1 }
        log.info("stall \(Int(ms), privacy: .public) ms")
    }
}
