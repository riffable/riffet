import AppKit
import os
import QuartzCore
import Synchronization
import RiffetKit

/// What the app is doing while a frame is measured; frames are judged against the activity a
/// person would notice them in.
enum PerfActivity: String, CaseIterable, Sendable {
    case idle, scroll, stream, interact
}

/// Durations under one key: exact count, total and maximum, and a bounded reservoir for percentiles.
final class PerfSeries {
    private static let capacity = 4096
    private(set) var count = 0
    private(set) var total = 0.0
    private(set) var max = 0.0
    private var samples: [Double] = []
    private var seed: UInt64 = 0x9E37_79B9_7F4A_7C15

    func add(_ value: Double) {
        count += 1
        total += value
        if value > max { max = value }
        if samples.count < Self.capacity {
            samples.append(value)
        } else {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            let slot = Int(seed >> 33) % count
            if slot < Self.capacity { samples[slot] = value }
        }
    }

    func summary() -> [String: Any] {
        let sorted = samples.sorted()
        func percentile(_ p: Double) -> Double {
            guard !sorted.isEmpty else { return 0 }
            return sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * p + 0.5))]
        }
        return [
            "count": count,
            "total": round2(total),
            "mean": round2(count == 0 ? 0 : total / Double(count)),
            "p50": round2(percentile(0.5)),
            "p95": round2(percentile(0.95)),
            "p99": round2(percentile(0.99)),
            "max": round2(max),
        ]
    }
}

func round2(_ value: Double) -> Double { (value * 100).rounded() / 100 }

/// Frame pacing for one page and activity: intervals between display callbacks and how late they were.
final class PerfFrames {
    let intervals = PerfSeries()
    private(set) var hitchMs = 0.0
    private(set) var seconds = 0.0
    private(set) var dropped = 0

    func add(interval: Double, expected: Double) {
        intervals.add(interval * 1000)
        seconds += interval
        let late = interval - expected
        if late > 0.001 {
            hitchMs += late * 1000
            dropped += max(0, Int((interval / expected).rounded()) - 1)
        }
    }

    func summary() -> [String: Any] {
        var result = intervals.summary()
        result["seconds"] = round2(seconds)
        result["hitchMs"] = round2(hitchMs)
        result["hitchMsPerSecond"] = round2(seconds > 0 ? hitchMs / seconds : 0)
        result["droppedFrames"] = dropped
        result["fps"] = round2(seconds > 0 ? Double(intervals.count) / seconds : 0)
        return result
    }
}

/// The recorded numbers, written from any thread (layout runs off the main thread) under one lock.
final class PerfStore: @unchecked Sendable {
    static let shared = PerfStore()

    private let lock = OSAllocatedUnfairLock()
    private var frames: [String: PerfFrames] = [:]
    private var phases: [String: PerfSeries] = [:]
    private var inputs: [String: PerfSeries] = [:]
    private var stalls: [String: PerfSeries] = [:]
    private var gauges: [String: Double] = [:]
    private var busySeconds = 0.0
    private var startedAt = Date()
    private var pageName = "other"

    private static let recordingFlag = Atomic<Bool>(false)

    /// Whether anything records; read on every `Perf.measure`, from any thread.
    static var recording: Bool {
        get { recordingFlag.load(ordering: .relaxed) }
        set { recordingFlag.store(newValue, ordering: .relaxed) }
    }

    var page: String {
        get { lock.withLock { pageName } }
        set { lock.withLock { pageName = newValue } }
    }

    func reset() {
        lock.withLock {
            frames.removeAll()
            phases.removeAll()
            inputs.removeAll()
            stalls.removeAll()
            gauges.removeAll()
            busySeconds = 0
            startedAt = Date()
        }
    }

    func frame(activity: PerfActivity, interval: Double, expected: Double) {
        lock.withLock {
            let key = "\(pageName)|\(activity.rawValue)"
            let series = frames[key] ?? PerfFrames()
            series.add(interval: interval, expected: expected)
            frames[key] = series
        }
    }

    func busy(_ seconds: Double) {
        lock.withLock {
            busySeconds += seconds
            if seconds > 0.05 { add(&stalls, "stall", seconds * 1000) }
        }
    }

    func phase(_ name: String, ms: Double) {
        lock.withLock { add(&phases, name, ms) }
    }

    func input(_ kind: String, ms: Double) {
        lock.withLock { add(&inputs, kind, ms) }
    }

    func gauge(_ name: String, _ value: Double) {
        lock.withLock { gauges["\(pageName)|\(name)"] = value }
    }

    private func add(_ table: inout [String: PerfSeries], _ name: String, _ value: Double) {
        let key = "\(pageName)|\(name)"
        let series = table[key] ?? PerfSeries()
        series.add(value)
        table[key] = series
    }

    /// Everything since the last reset, grouped by page.
    func report() -> [String: Any] {
        let (entries, elapsed, busy) = lock.withLock { () -> ([(String, String, Any)], Double, Double) in
            var entries: [(String, String, Any)] = []
            for (key, value) in frames { entries.append((key, "frames", value.summary())) }
            for (key, value) in phases { entries.append((key, "phases", value.summary())) }
            for (key, value) in inputs { entries.append((key, "input", value.summary())) }
            for (key, value) in stalls { entries.append((key, "mainThreadStalls", value.summary())) }
            for (key, value) in gauges { entries.append((key, "gauges", round2(value))) }
            return (entries, Date().timeIntervalSince(startedAt), busySeconds)
        }
        var pages: [String: [String: Any]] = [:]
        for (key, group, value) in entries {
            let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
            let page = parts[0], name = parts.count > 1 ? parts[1] : ""
            var entry = pages[page] ?? [:]
            var section = entry[group] as? [String: Any] ?? [:]
            section[name] = value
            entry[group] = section
            pages[page] = entry
        }
        return [
            "elapsedSeconds": round2(elapsed),
            "mainThreadBusyRatio": round2(elapsed > 0 ? busy / elapsed : 0),
            "pages": pages,
        ]
    }
}

/// Measures how the app feels: frame pacing per page and activity, main-thread stalls, the delay
/// from a click or key press to the next frame, and named phases (`Perf.measure`). Off by default;
/// when off nothing runs and `Perf.measure` costs one load.
@MainActor
final class PerfMonitor: NSObject {
    static let shared = PerfMonitor()
    static let enabledKey = "riffet.perf.enabled"
    static let hudKey = "riffet.perf.hud"
    /// `defaults write io.github.riffetai.mac riffet.perf.links -bool true` lets `riffet://perf/*` links in.
    static let linksKey = "riffet.perf.links"

    private let store = PerfStore.shared

    /// Set while something is streaming into the open page.
    var streaming = false
    /// Forces the activity: the benchmark drives scrolling itself and labels it.
    var activityOverride: PerfActivity?

    private var link: CADisplayLink?
    private var lastFrame: CFTimeInterval = 0
    private var scrollingUntil: CFTimeInterval = 0
    private var interactingUntil: CFTimeInterval = 0
    private var liveScrolls = 0
    private var observer: CFRunLoopObserver?
    private var iterationStart: CFTimeInterval = 0
    private var pendingInput: (kind: String, at: TimeInterval)?
    private var awaitingFrame: (kind: String, at: TimeInterval)?
    private var monitors: [Any] = []
    private var notes: [NSObjectProtocol] = []
    /// The last second, for the HUD.
    private var recent: [(at: CFTimeInterval, interval: Double, expected: Double)] = []
    private var recentBusy: [(at: CFTimeInterval, busy: Double)] = []
    private(set) var lastInputLatency: Double?
    /// Called after every display frame while the monitor runs (the benchmark's scroll driver).
    var onFrame: ((CADisplayLink) -> Void)?

    var enabled: Bool { link != nil }

    var page: String {
        get { store.page }
        set { if store.page != newValue { store.page = newValue } }
    }

    func startIfEnabled() {
        if UserDefaults.standard.bool(forKey: Self.enabledKey) { start() }
        if UserDefaults.standard.bool(forKey: Self.hudKey) { PerfHUD.shared.show() }
    }

    func setEnabled(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: Self.enabledKey)
        on ? start() : stop()
    }

    func start() {
        guard link == nil else { return }
        PerfStore.recording = true
        // The shared client's phases (reading the device cache, projecting, grouping), from its threads.
        ClientPerf.shared.sink = { name, ms in PerfStore.shared.phase(name, ms: ms.doubleValue) }
        iterationStart = 0
        pendingInput = nil
        awaitingFrame = nil
        attachLink()
        addRunLoopObserver()
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel], handler: { [weak self] event in
            MainActor.assumeIsolated { self?.received(event) }
            return event
        }) {
            monitors.append(monitor)
        }
        let center = NotificationCenter.default
        notes.append(center.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.liveScrolls += 1 }
        })
        notes.append(center.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.liveScrolls = max(0, self.liveScrolls - 1)
                self.scrollingUntil = CACurrentMediaTime() + 0.1
            }
        })
        notes.append(center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.attachLink() }
        })
    }

    func stop() {
        PerfStore.recording = false
        ClientPerf.shared.sink = nil
        link?.invalidate()
        link = nil
        if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        observer = nil
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
        notes.forEach(NotificationCenter.default.removeObserver)
        notes.removeAll()
    }

    func reset() { store.reset() }

    /// The display link follows the key window's screen, so it ticks at that display's rate.
    private func attachLink() {
        let window = NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first { $0.isVisible && $0.contentView != nil }
        guard let view = window?.contentView else {
            if link == nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    MainActor.assumeIsolated { if PerfStore.recording { self?.attachLink() } }
                }
            }
            return
        }
        link?.invalidate()
        let link = view.displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        lastFrame = 0
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        defer {
            lastFrame = now
            onFrame?(link)
        }
        if let waiting = awaitingFrame {
            awaitingFrame = nil
            let latency = (link.targetTimestamp - waiting.at) * 1000
            lastInputLatency = latency
            store.input(waiting.kind, ms: latency)
        }
        guard lastFrame > 0 else { return }
        let interval = now - lastFrame
        let expected = max(1.0 / 240, link.targetTimestamp - link.timestamp)
        // A gap of seconds is the app idling behind another window, not a frame.
        guard interval < 2 else { return }
        store.frame(activity: currentActivity(now), interval: interval, expected: expected)
        recent.append((now, interval, expected))
        while let first = recent.first, now - first.at > 1 { recent.removeFirst() }
    }

    private func currentActivity(_ now: CFTimeInterval) -> PerfActivity {
        if let activityOverride { return activityOverride }
        if liveScrolls > 0 || now < scrollingUntil { return .scroll }
        if now < interactingUntil { return .interact }
        if streaming { return .stream }
        return .idle
    }

    private func received(_ event: NSEvent) {
        let now = CACurrentMediaTime()
        switch event.type {
        case .scrollWheel:
            scrollingUntil = now + 0.15
        case .keyDown:
            interactingUntil = now + 0.3
            pendingInput = ("key", event.timestamp)
        default:
            interactingUntil = now + 0.3
            pendingInput = ("click", event.timestamp)
        }
    }

    private func addRunLoopObserver() {
        let activities = CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue
        let observer = CFRunLoopObserverCreateWithHandler(nil, activities, true, Int.max) { [weak self] _, activity in
            MainActor.assumeIsolated { self?.runLoop(activity) }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        self.observer = observer
    }

    private func runLoop(_ activity: CFRunLoopActivity) {
        let now = CACurrentMediaTime()
        if activity == .afterWaiting {
            iterationStart = now
            return
        }
        guard iterationStart > 0 else { return }
        let busy = now - iterationStart
        iterationStart = 0
        if let input = pendingInput {
            pendingInput = nil
            awaitingFrame = input
        }
        store.busy(busy)
        recentBusy.append((now, busy))
        while let first = recentBusy.first, now - first.at > 1 { recentBusy.removeFirst() }
    }

    /// Times the next frame after [kind] happens (a toggle the benchmark performs, for instance).
    func markInput(_ kind: String) {
        awaitingFrame = (kind, CACurrentMediaTime())
    }

    // MARK: Reading

    struct Live {
        let fps: Double
        let hitchPerSecond: Double
        let worstFrame: Double
        let mainBusy: Double
        let lastInput: Double?
    }

    var live: Live {
        let seconds = recent.reduce(0) { $0 + $1.interval }
        let hitch = recent.reduce(0) { $0 + max(0, $1.interval - $1.expected) } * 1000
        let busy = recentBusy.reduce(0) { $0 + $1.busy }
        return Live(
            fps: seconds > 0 ? Double(recent.count) / seconds : 0,
            hitchPerSecond: seconds > 0 ? hitch / seconds : 0,
            worstFrame: (recent.map(\.interval).max() ?? 0) * 1000,
            mainBusy: min(1, busy),
            lastInput: lastInputLatency
        )
    }

    func report(extra: [String: Any] = [:]) -> [String: Any] {
        var result = store.report()
        result["generatedAt"] = ISO8601DateFormatter().string(from: Date())
        result["environment"] = Self.environment
        for (key, value) in extra { result[key] = value }
        return result
    }

    static var environment: [String: Any] {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        var model = [CChar](repeating: 0, count: max(1, size))
        sysctlbyname("hw.model", &model, &size, nil, 0)
        return [
            "build": _isDebugAssertConfiguration() ? "Debug" : "Release",
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "hardware": String(cString: model),
            "refreshRate": NSScreen.main?.maximumFramesPerSecond ?? 60,
        ]
    }

    /// Draws the main window's content into `snapshot-<name>.png` in the perf folder (for checking
    /// layouts from scripts).
    static func snapshot(name: String, settings: Bool = false) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appending(path: "snapshot-\(name).png").path
        let window = settings
            ? NSApp.windows.first { $0.identifier?.rawValue.contains("Settings") == true }
            : (NSApp.windows.first { $0.identifier?.rawValue == WindowRouter.mainWindow } ?? NSApp.mainWindow)
        guard let window,
              let view = window.contentView?.superview ?? window.contentView,
              let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }

    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appending(path: "Riffet/perf", directoryHint: .isDirectory)
    }

    /// Writes [report] as a dated file and as `latest-<name>.json`; returns the dated file.
    @discardableResult
    static func write(_ report: [String: Any], name: String) -> URL? {
        let directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) else { return nil }
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let url = directory.appending(path: "\(name)-\(stamp).json")
        try? data.write(to: url)
        try? data.write(to: directory.appending(path: "latest-\(name).json"))
        return url
    }
}

/// Named phases, visible in Instruments (subsystem `io.github.riffetai.mac`) and in the monitor's report.
enum Perf {
    static let signposter = OSSignposter(subsystem: "io.github.riffetai.mac", category: "perf")

    @inline(__always)
    static func measure<T>(_ name: StaticString, _ body: () throws -> T) rethrows -> T {
        guard PerfStore.recording else { return try body() }
        let state = signposter.beginInterval(name)
        let start = CACurrentMediaTime()
        defer {
            signposter.endInterval(name, state)
            PerfStore.shared.phase("\(name)", ms: (CACurrentMediaTime() - start) * 1000)
        }
        return try body()
    }

    static func gauge(_ name: String, _ value: Double) {
        guard PerfStore.recording else { return }
        PerfStore.shared.gauge(name, value)
    }
}
