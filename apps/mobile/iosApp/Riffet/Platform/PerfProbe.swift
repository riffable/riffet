#if DEBUG
import os
import QuartzCore
import UIKit

/// Debug builds only: drives a scenario without XCTest attached, so accessibility automation does not
/// add its own per-frame cost to what is measured (docs/guide/ios-performance.md §3).
///
/// - `-riffet.perf.open riffet://session?id=…` opens that link once the app has started, and again on
///   `notifyutil -p io.github.riffable.iphone.perf.open` (after `defaults write … riffet.perf.open <link>`).
/// - `xcrun simctl spawn booted notifyutil -p io.github.riffable.iphone.perf.scroll` scrolls the tallest
///   scroll view on screen as `riffet.perf.scroll` describes — `speed,distance,cycles` in points per
///   second (default `1500,3000,2`), first towards the top, then back — and logs the frame pacing under
///   the `perf` category, next to `StallMonitor`'s stalls.
/// - `notifyutil -p io.github.riffable.iphone.perf.type` types into the composer as `riffet.perf.type`
///   describes (`count,interval-ms`).
@MainActor
enum PerfProbe {
    private static let log = Logger(subsystem: "io.github.riffable.iphone", category: "perf")
    private static var scroller: Scroller?

    private static weak var model: AppModel?

    static func install(model: AppModel) {
        self.model = model
        openLink()
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterAddObserver(center, nil, { _, _, _, _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { PerfProbe.scroll() } }
        }, "io.github.riffable.iphone.perf.scroll" as CFString, nil, .deliverImmediately)
        CFNotificationCenterAddObserver(center, nil, { _, _, _, _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { PerfProbe.typeText() } }
        }, "io.github.riffable.iphone.perf.type" as CFString, nil, .deliverImmediately)
        // Opening a link from outside asks for confirmation on the simulator; this opens it in place.
        CFNotificationCenterAddObserver(center, nil, { _, _, _, _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { PerfProbe.openLink() } }
        }, "io.github.riffable.iphone.perf.open" as CFString, nil, .deliverImmediately)
    }

    private static func openLink() {
        guard let link = UserDefaults.standard.string(forKey: "riffet.perf.open"), let url = URL(string: link) else { return }
        model?.open(url)
    }

    private static func scroll() {
        guard scroller == nil, let view = tallestScrollView() else { log.info("scroll: no scroll view"); return }
        let spec = (UserDefaults.standard.string(forKey: "riffet.perf.scroll") ?? "").split(separator: ",").compactMap { Double($0) }
        let speed = spec.count > 0 ? spec[0] : 1500, distance = spec.count > 1 ? spec[1] : 3000, cycles = spec.count > 2 ? Int(spec[2]) : 2
        scroller = Scroller(view: view, speed: speed, distance: distance, cycles: cycles) { summary in
            log.info("scroll \(String(describing: Swift.type(of: view)), privacy: .public) \(summary, privacy: .public)")
            scroller = nil
        }
    }

    /// Types `riffet.perf.type` (`count,interval-ms`, default `150,60`) into the editable text view on
    /// screen, one character per interval, the way the keyboard inserts it, then logs how long it took.
    private static var typing: Timer?
    private static func typeText() {
        guard typing == nil else { return }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let field = windows.lazy.compactMap({ editable(in: $0) }).first else { log.info("type: no text view"); return }
        let spec = (UserDefaults.standard.string(forKey: "riffet.perf.type") ?? "").split(separator: ",").compactMap { Int($0) }
        let count = spec.first ?? 150, interval = Double(spec.count > 1 ? spec[1] : 60) / 1000
        let sample = Array("流畅输入测试 typing ")
        field.becomeFirstResponder()
        field.selectedRange = NSRange(location: (field.text as NSString).length, length: 0)
        var typed = 0
        let started = CACurrentMediaTime()
        typing = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { timer in
            MainActor.assumeIsolated {
                field.insertText(String(sample[typed % sample.count]))
                typed += 1
                guard typed >= count else { return }
                timer.invalidate(); typing = nil
                log.info("typed \(count) characters in \(Int((CACurrentMediaTime() - started) * 1000)) ms")
            }
        }
    }
    private static func editable(in view: UIView) -> UITextView? {
        if let text = view as? UITextView, text.isEditable, !text.isHidden, text.window != nil { return text }
        for child in view.subviews { if let found = editable(in: child) { return found } }
        return nil
    }

    /// The scroll view a finger at the middle of the screen would move: the nearest vertically scrollable
    /// ancestor of what is hit there.
    private static func tallestScrollView() -> UIScrollView? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) else { return nil }
        var view = window.hitTest(CGPoint(x: window.bounds.midX, y: window.bounds.midY), with: nil)
        while let current = view {
            if let scroll = current as? UIScrollView, scroll.contentSize.height > scroll.bounds.height { return scroll }
            view = current.superview
        }
        return nil
    }

    /// Moves the offset at a constant speed on every display frame, the way a steady drag does, and
    /// records how late each frame was.
    private final class Scroller: NSObject {
        let view: UIScrollView
        let speed: Double
        let distance: Double
        var remainingLegs: Int
        var direction = -1.0
        var travelled = 0.0
        var last: CFTimeInterval = 0
        var intervals: [Double] = []
        let done: (String) -> Void
        var link: CADisplayLink?

        init(view: UIScrollView, speed: Double, distance: Double, cycles: Int, done: @escaping (String) -> Void) {
            self.view = view; self.speed = speed; self.distance = distance; self.remainingLegs = max(1, cycles) * 2; self.done = done
            super.init()
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }

        @objc func tick(_ link: CADisplayLink) {
            let now = link.timestamp
            defer { last = now }
            guard last > 0 else { return }
            let dt = now - last
            intervals.append(dt * 1000)
            let step = min(speed * dt, distance - travelled)
            let top = -view.adjustedContentInset.top
            let bottom = max(top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
            let next = min(bottom, max(top, view.contentOffset.y + direction * step))
            view.contentOffset.y = next
            travelled += step
            if travelled >= distance || next == top || next == bottom {
                remainingLegs -= 1; travelled = 0; direction = -direction
                if remainingLegs == 0 { finish() }
            }
        }

        func finish() {
            link?.invalidate(); link = nil
            let expected = 1000 / Double(max(1, UIScreen.main.maximumFramesPerSecond))
            let sorted = intervals.sorted()
            let late = intervals.filter { $0 > expected * 1.5 }
            let dropped = intervals.reduce(0) { $0 + max(0, Int(($1 / expected).rounded()) - 1) }
            let p95 = sorted.isEmpty ? 0 : sorted[Int(Double(sorted.count - 1) * 0.95)]
            done("frames=\(intervals.count) late=\(late.count) dropped=\(dropped) p95=\(Int(p95))ms max=\(Int(sorted.last ?? 0))ms speed=\(Int(speed))")
        }
    }
}
#endif
