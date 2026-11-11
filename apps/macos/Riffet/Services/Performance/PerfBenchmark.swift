import AppKit
import QuartzCore

/// What the benchmark needs from the transcript on screen.
@MainActor
protocol TranscriptBenchTarget: AnyObject {
    var benchSessionId: String? { get }
    var benchScrollView: NSScrollView? { get }
    /// Rows are drawn and the list sits at its end.
    var benchReady: Bool { get }
    var benchRowCount: Int { get }
    /// Opens or closes the [index]th disclosure on screen; false when there is no such row.
    func benchToggle(_ index: Int) -> Bool
    /// Streams [text] into a new answer at the end, [chunk] characters every [interval] seconds.
    func benchStream(text: String, chunk: Int, interval: Double) async
}

@MainActor
enum TranscriptBench {
    static weak var current: TranscriptBenchTarget?
}

/// A repeatable run over one conversation: open it, scroll steadily up and back, jump to both
/// ends, open and close disclosures, and stream a long answer, each filed as its own page in the
/// report (`~/Library/Application Support/Riffet/perf/latest-bench.json`).
///
/// `open -a Riffet.app "riffet://perf/bench?session=<id>"` runs it; so does the diagnostics settings.
@MainActor
final class PerfBenchmark {
    static let shared = PerfBenchmark()
    private(set) var running = false

    @discardableResult
    func run(sessionId: String?) async -> URL? {
        guard !running, let workbench = AppModel.shared.workbench else { return nil }
        running = true
        defer { running = false }
        let monitor = PerfMonitor.shared
        let wasEnabled = monitor.enabled
        monitor.start()
        let hudWasVisible = PerfHUD.shared.visible
        PerfHUD.shared.show()
        defer {
            monitor.activityOverride = nil
            // Left alone when another run has started meanwhile.
            if !hudWasVisible { DispatchQueue.main.asyncAfter(deadline: .now() + 8) { MainActor.assumeIsolated { if !self.running { PerfHUD.shared.hide() } } } }
            if !wasEnabled { DispatchQueue.main.asyncAfter(deadline: .now() + 8.5) { MainActor.assumeIsolated { if !self.running, !PerfHUD.shared.visible { monitor.setEnabled(false) } } } }
        }
        WindowRouter.shared.showMain()
        monitor.reset()

        let id = sessionId ?? workbench.selected?.id
        guard let id else {
            PerfHUD.shared.flash(String(localized: "基准：没有指定会话"))
            return nil
        }
        PerfHUD.shared.flash(String(localized: "基准：打开会话…"), seconds: 60)
        workbench.showHome()
        try? await Task.sleep(for: .milliseconds(600))
        monitor.page = "bench.open"
        let opened = CACurrentMediaTime()
        workbench.open(sessionId: id)
        var openMs: Double?
        for _ in 0..<600 {
            await nextFrame()
            guard PerfMonitor.shared.enabled else { break }
            if let target = TranscriptBench.current, target.benchSessionId == id, target.benchReady {
                await nextFrame()
                openMs = (CACurrentMediaTime() - opened) * 1000
                break
            }
        }
        guard let target = TranscriptBench.current, let openMs, let scrollView = target.benchScrollView else {
            PerfHUD.shared.flash(String(localized: "基准：会话没有在 10 秒内显示"))
            return nil
        }
        try? await Task.sleep(for: .seconds(1.5))

        PerfHUD.shared.flash(String(localized: "基准：匀速滚动…"), seconds: 60)
        monitor.page = "bench.scroll"
        monitor.activityOverride = .scroll
        await scroll(scrollView, speed: 3000, limit: 6, up: true)
        await scroll(scrollView, speed: 3000, limit: 6, up: false)

        PerfHUD.shared.flash(String(localized: "基准：快速甩动…"), seconds: 60)
        monitor.page = "bench.fling"
        await scroll(scrollView, speed: 12000, limit: 3, up: true)
        await scroll(scrollView, speed: 12000, limit: 3, up: false)

        PerfHUD.shared.flash(String(localized: "基准：跳到两端…"), seconds: 60)
        monitor.page = "bench.jump"
        jump(scrollView, top: true)
        try? await Task.sleep(for: .seconds(1))
        jump(scrollView, top: false)
        try? await Task.sleep(for: .seconds(1))
        monitor.activityOverride = nil

        PerfHUD.shared.flash(String(localized: "基准：展开与折叠…"), seconds: 60)
        monitor.page = "bench.toggle"
        monitor.activityOverride = .interact
        var toggled = 0
        for index in 0..<8 where target.benchToggle(index) {
            monitor.markInput("toggle")
            toggled += 1
            try? await Task.sleep(for: .milliseconds(350))
        }
        for index in (0..<toggled).reversed() where target.benchToggle(index) {
            monitor.markInput("toggle")
            try? await Task.sleep(for: .milliseconds(350))
        }
        monitor.activityOverride = nil

        PerfHUD.shared.flash(String(localized: "基准：首页与会话切换…"), seconds: 60)
        monitor.page = "bench.switch"
        monitor.activityOverride = .interact
        await switches(sessionId: id)
        monitor.activityOverride = nil

        PerfHUD.shared.flash(String(localized: "基准：流式输出…"), seconds: 60)
        monitor.page = "bench.stream"
        monitor.activityOverride = .stream
        // The switches above put a new transcript on screen.
        let live = TranscriptBench.current ?? target
        await live.benchStream(text: Self.sample, chunk: 24, interval: 1.0 / 60)
        try? await Task.sleep(for: .milliseconds(500))
        monitor.activityOverride = nil
        monitor.page = "transcript"

        let report = monitor.report(extra: [
            "bench": ["session": id, "rows": target.benchRowCount, "openMs": round2(openMs), "toggled": toggled] as [String: Any],
        ])
        let url = PerfMonitor.write(report, name: "bench")
        PerfHUD.shared.flash(Self.headline(report, openMs: openMs), seconds: 20)
        return url
    }

    /// Opens and closes the sidebar four times the way its toolbar button does (animated), filed as
    /// `bench.sidebar`; the report is `latest-sidebar.json`.
    func toggleSidebar() async {
        running = true
        defer { running = false }
        let monitor = PerfMonitor.shared
        monitor.start()
        monitor.reset()
        WindowRouter.shared.showMain()
        try? await Task.sleep(for: .milliseconds(400))
        monitor.page = "bench.sidebar"
        monitor.activityOverride = .interact
        for _ in 0..<4 {
            NSApp.sendAction(#selector(NSSplitViewController.toggleSidebar(_:)), to: nil, from: nil)
            try? await Task.sleep(for: .milliseconds(800))
        }
        monitor.activityOverride = nil
        PerfMonitor.write(monitor.report(), name: "sidebar")
    }

    /// Previews [path] from the conversation's project in the file panel and scrolls it down and up,
    /// then right and left (`bench.preview.vertical`, `bench.preview.horizontal`).
    func preview(path: String, sessionId: String?) async {
        guard !running, let workbench = AppModel.shared.workbench else { return }
        running = true
        defer { running = false }
        let monitor = PerfMonitor.shared
        monitor.start()
        monitor.reset()
        WindowRouter.shared.showMain()
        if let sessionId {
            workbench.open(sessionId: sessionId)
            try? await Task.sleep(for: .seconds(1.5))
        }
        workbench.preview(path: path)
        var found: NSScrollView?
        for _ in 0..<300 {
            await nextFrame()
            if let scroll = Self.previewScroll(), (scroll.documentView?.frame.height ?? 0) > scroll.contentView.bounds.height + 200 {
                found = scroll
                break
            }
        }
        guard let scroll = found else {
            PerfHUD.shared.flash(String(localized: "基准：预览没有打开"))
            return
        }
        // Colours arrive after the plain text.
        try? await Task.sleep(for: .seconds(1.5))
        monitor.activityOverride = .scroll
        monitor.page = "bench.preview.vertical"
        await self.scroll(scroll, speed: 2500, limit: 4, up: false)
        await self.scroll(scroll, speed: 2500, limit: 4, up: true)
        monitor.page = "bench.preview.horizontal"
        await self.scroll(scroll, speed: 1200, limit: 2, up: false, sideways: true)
        await self.scroll(scroll, speed: 1200, limit: 2, up: true, sideways: true)
        monitor.activityOverride = nil
        PerfMonitor.write(monitor.report(), name: "preview")
    }

    private static func previewScroll() -> NSScrollView? {
        guard let window = NSApp.windows.first(where: { $0.identifier?.rawValue == WindowRouter.mainWindow }), let root = window.contentView?.superview ?? window.contentView else { return nil }
        func walk(_ view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView, scroll.documentView is NSTextView, scroll.verticalRulerView is LineNumberRuler { return scroll }
            for child in view.subviews {
                if let found = walk(child) { return found }
            }
            return nil
        }
        return walk(root)
    }

    /// Opens the settings window on its first section and visits every section the way a click in
    /// its sidebar does, timing each from the change to the second frame after it (`settingsOpen`,
    /// `settingsSection` and `settings.<section>` in the report's input section), then visits them
    /// all again (`settingsRevisit`).
    func settings() async {
        running = true
        defer { running = false }
        let monitor = PerfMonitor.shared
        monitor.start()
        monitor.reset()
        func window() -> NSWindow? { NSApp.windows.first { $0.identifier?.rawValue.contains("Settings") == true && $0.isVisible } }
        window()?.close()
        try? await Task.sleep(for: .milliseconds(500))
        monitor.page = "bench.settings"
        monitor.activityOverride = .interact
        UserDefaults.standard.set(SettingsSection.navigable[0].rawValue, forKey: PreferenceKey.settingsSection)
        var started = CACurrentMediaTime()
        WindowRouter.shared.showSettings()
        for _ in 0..<120 where window() == nil { await nextFrame() }
        await nextFrame()
        await nextFrame()
        PerfStore.shared.input("settingsOpen", ms: (CACurrentMediaTime() - started) * 1000)
        try? await Task.sleep(for: .milliseconds(800))
        for pass in 0..<2 {
            for section in SettingsSection.navigable.dropFirst() + [SettingsSection.navigable[0]] {
                started = CACurrentMediaTime()
                UserDefaults.standard.set(section.rawValue, forKey: PreferenceKey.settingsSection)
                await nextFrame()
                await nextFrame()
                let ms = (CACurrentMediaTime() - started) * 1000
                PerfStore.shared.input(pass == 0 ? "settingsSection" : "settingsRevisit", ms: ms)
                if pass == 0 { PerfStore.shared.input("settings.\(section.rawValue)", ms: ms) }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        monitor.activityOverride = nil
        // Left open, its pages keep polling and would weigh on the benchmarks that follow.
        window()?.close()
        PerfMonitor.write(monitor.report(), name: "settings")
    }

    /// Scrolls every other long list in the main window (the sidebar, the side panel's lists) down and
    /// back up, each filed as `bench.list.<n>` with where it sits (left, middle, right).
    func scrollLists() async {
        guard let window = NSApp.windows.first(where: { $0.identifier?.rawValue == WindowRouter.mainWindow }), let root = window.contentView?.superview ?? window.contentView else { return }
        running = true
        defer { running = false }
        PerfMonitor.shared.start()
        var found: [NSScrollView] = []
        func walk(_ view: NSView) {
            if let scroll = view as? NSScrollView, scroll !== TranscriptController.active(in: window)?.hostScrollView,
               let document = scroll.documentView, document.frame.height > scroll.contentView.bounds.height + 200, scroll.contentView.bounds.height > 120 {
                found.append(scroll)
            }
            view.subviews.forEach(walk)
        }
        walk(root)
        for (index, list) in found.enumerated() {
            let x = list.convert(list.bounds, to: nil).midX / window.frame.width
            PerfMonitor.shared.page = "bench.list.\(index).\(x < 0.33 ? "left" : x < 0.66 ? "middle" : "right")"
            PerfMonitor.shared.activityOverride = .scroll
            await scroll(list, speed: 2500, limit: 3, up: false)
            await scroll(list, speed: 2500, limit: 3, up: true)
            PerfMonitor.shared.activityOverride = nil
        }
        PerfMonitor.write(PerfMonitor.shared.report(), name: "lists")
    }

    /// Runs [switches] on its own and writes `latest-switch.json`.
    func switchBench(sessionId id: String, other: String?) async {
        guard !running else { return }
        running = true
        defer { running = false }
        let monitor = prepare()
        monitor.page = "bench.switch"
        monitor.activityOverride = .interact
        await switches(sessionId: id, other: other)
        monitor.activityOverride = nil
        PerfMonitor.write(monitor.report(), name: "switch")
    }

    /// Switches between the home page and [sessionId] three times the way a click in the sidebar
    /// does (no URL, no window activation), timing each from the call to the first frame after the
    /// new page is in place (`toHome`, `toSession` in the report's input section).
    func switches(sessionId id: String, other: String? = nil) async {
        guard let workbench = AppModel.shared.workbench else { return }
        if let other {
            // Conversation to conversation, as clicking between them in the sidebar.
            for round in 0..<6 {
                let target = round % 2 == 0 ? other : id
                await transition(["toOtherSession"], ready: { Self.showing(target) }) { workbench.open(sessionId: target) }
                try? await Task.sleep(for: .milliseconds(500))
            }
            return
        }
        for _ in 0..<3 {
            await transition(["toHome"]) { workbench.showHome() }
            try? await Task.sleep(for: .milliseconds(500))
            await transition(["toSession"], ready: { Self.showing(id) }) { workbench.open(sessionId: id) }
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    /// Visits every page of the sidebar's first rows from [sessionId]'s conversation and back, twice:
    /// `page.<name>` (and `toPage`) to the second frame, `….ready` once no loading spinner is left,
    /// `pageAgain.<name>` (`toPageAgain`) on the second visit, `fromPage` back to the conversation.
    /// The report is `latest-pages.json`.
    func pages(sessionId: String?) async {
        guard !running, let workbench = AppModel.shared.workbench else { return }
        running = true
        defer { running = false }
        let monitor = prepare()
        guard let id = sessionId ?? workbench.selected?.id, await show(id) else { return }
        monitor.page = "bench.pages"
        monitor.activityOverride = .interact
        let pages = WorkbenchPage.sidebarOrder
        for pass in 0..<2 {
            for page in pages {
                let name = pass == 0 ? "page" : "pageAgain"
                await transition(["\(name).\(page.rawValue)", pass == 0 ? "toPage" : "toPageAgain"]) { workbench.page = page }
                try? await Task.sleep(for: .milliseconds(600))
                await transition(["fromPage"], ready: { Self.showing(id) }) { workbench.page = nil }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        monitor.activityOverride = nil
        PerfMonitor.write(monitor.report(), name: "pages")
    }

    /// Opens each side panel tab on [sessionId]'s conversation from a closed panel, then switches
    /// between them twice (`inspector.<tab>`, `inspectorAgain.<tab>`, each with `….ready`), and puts
    /// the panel back as it was. The report is `latest-inspector.json`.
    func inspector(sessionId: String?) async {
        guard !running, let workbench = AppModel.shared.workbench else { return }
        running = true
        defer { running = false }
        let monitor = prepare()
        guard let id = sessionId ?? workbench.selected?.id, await show(id) else { return }
        let was = workbench.inspector
        workbench.setInspectorOpen(false)
        try? await Task.sleep(for: .milliseconds(500))
        monitor.page = "bench.inspector"
        monitor.activityOverride = .interact
        for pass in 0..<2 {
            for tab in workbench.inspectorViews.map(\.tab) {
                await transition(["\(pass == 0 ? "inspector" : "inspectorAgain").\(tab.rawValue)"]) { workbench.showInspector(tab) }
                try? await Task.sleep(for: .milliseconds(600))
            }
        }
        await transition(["inspectorClose"]) { workbench.setInspectorOpen(false) }
        monitor.activityOverride = nil
        workbench.setInspector { $0.open = was.open; $0.tab = was.tab }
        PerfMonitor.write(monitor.report(), name: "inspector")
    }

    /// Opens [sessionId] three times from another conversation after dropping it from the store's
    /// memory, so each open reads the device cache, projects and groups it again (`coldOpen`, and
    /// `coldOpen.ready` until its rows are on screen). The client's own phases are in the report's
    /// phases (`client.*`). The report is `latest-cold.json`.
    func cold(sessionId id: String, other: String?) async {
        guard !running, let workbench = AppModel.shared.workbench else { return }
        running = true
        defer { running = false }
        let monitor = prepare()
        guard let other = other ?? workbench.list.sessions.first(where: { $0.id != id && $0.archivedAt == nil })?.id else {
            PerfHUD.shared.flash(String(localized: "基准：没有可以切换的另一个会话"))
            return
        }
        monitor.page = "bench.cold"
        monitor.activityOverride = .interact
        for _ in 0..<3 {
            guard await show(other) else { return }
            workbench.store.forgetWarm(sessionId: id)
            try? await Task.sleep(for: .milliseconds(300))
            await transition(["coldOpen"], ready: { Self.showing(id) }) { workbench.open(sessionId: id) }
            try? await Task.sleep(for: .milliseconds(800))
        }
        monitor.activityOverride = nil
        PerfMonitor.write(monitor.report(), name: "cold")
    }

    /// Turns the monitor on with an empty report and brings the main window forward.
    private func prepare() -> PerfMonitor {
        let monitor = PerfMonitor.shared
        monitor.start()
        monitor.reset()
        WindowRouter.shared.showMain()
        return monitor
    }

    /// Opens [id] unless it is already on screen, and waits for its rows (up to 10 s) and a moment more.
    private func show(_ id: String) async -> Bool {
        guard let workbench = AppModel.shared.workbench else { return false }
        if workbench.page != nil || workbench.showingHome || workbench.selected?.id != id { workbench.open(sessionId: id) }
        let deadline = CACurrentMediaTime() + 10
        while !Self.showing(id), CACurrentMediaTime() < deadline { await nextFrame() }
        guard Self.showing(id) else {
            PerfHUD.shared.flash(String(localized: "基准：会话没有在 10 秒内显示"))
            return false
        }
        try? await Task.sleep(for: .milliseconds(800))
        return true
    }

    /// [id]'s transcript is on screen with its rows drawn.
    private static func showing(_ id: String) -> Bool {
        guard let current = TranscriptBench.current else { return false }
        return current.benchSessionId == id && current.benchReady
    }

    /// Times [action] under each of [names]: to the second frame after it, and as `<name>.ready`
    /// until [ready] holds (by default, no loading spinner left in the main window; up to 5 s).
    private func transition(_ names: [String], ready: (() -> Bool)? = nil, _ action: () -> Void) async {
        let ready = ready ?? { !Self.loading() }
        let started = CACurrentMediaTime()
        action()
        await nextFrame()
        await nextFrame()
        let shown = (CACurrentMediaTime() - started) * 1000
        let deadline = started + 5
        while !ready(), CACurrentMediaTime() < deadline { await nextFrame() }
        if !ready() { PerfHUD.shared.flash(String(localized: "基准：\(names[0]) 5 秒内没有就绪")) }
        await nextFrame()
        let loaded = (CACurrentMediaTime() - started) * 1000
        for name in names {
            PerfStore.shared.input(name, ms: shown)
            PerfStore.shared.input("\(name).ready", ms: loaded)
        }
    }

    /// A spinner larger than the sidebar's mini ones is on screen in the main window: pages and panels
    /// show one until their first data arrives.
    private static func loading() -> Bool {
        guard let window = NSApp.windows.first(where: { $0.identifier?.rawValue == WindowRouter.mainWindow }), let root = window.contentView?.superview ?? window.contentView else { return false }
        func walk(_ view: NSView) -> Bool {
            if let spinner = view as? NSProgressIndicator, spinner.style == .spinning, spinner.controlSize != .mini, !spinner.isHiddenOrHasHiddenAncestor, spinner.alphaValue > 0 { return true }
            return view.subviews.contains(where: walk)
        }
        return walk(root)
    }

    private static func headline(_ report: [String: Any], openMs: Double) -> String {
        let pages = report["pages"] as? [String: [String: Any]] ?? [:]
        func frames(_ page: String, _ activity: String) -> [String: Any] {
            (pages[page]?["frames"] as? [String: Any])?[activity] as? [String: Any] ?? [:]
        }
        let scroll = frames("bench.scroll", "scroll")
        let stream = frames("bench.stream", "stream")
        let toggle = (pages["bench.toggle"]?["input"] as? [String: Any])?["toggle"] as? [String: Any] ?? [:]
        return String(
            format: String(localized: "基准完成 · 打开 %.0fms\n滚动卡顿 %.1fms/s p99 %.1fms · 流式卡顿 %.1fms/s\n展开 p95 %.0fms"),
            openMs, scroll["hitchMsPerSecond"] as? Double ?? 0, scroll["p99"] as? Double ?? 0,
            stream["hitchMsPerSecond"] as? Double ?? 0, toggle["p95"] as? Double ?? 0
        )
    }

    /// Waits for display frames; [onFrame] returns true when done. Gives up after [timeout] seconds
    /// (a minimised window gets no frames), and resumes exactly once either way.
    private func frames(timeout: Double, _ onFrame: @escaping (CADisplayLink) -> Bool) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            var finished = false
            let finish = {
                guard !finished else { return }
                finished = true
                PerfMonitor.shared.onFrame = nil
                continuation.resume()
            }
            PerfMonitor.shared.onFrame = { link in if onFrame(link) { finish() } }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish() }
        }
    }

    private func nextFrame() async {
        await frames(timeout: 1) { _ in true }
    }

    /// Moves the list by [speed] points a second until it reaches an end or [limit] seconds pass.
    /// Moves the list by [speed] points a second until it reaches an end or [limit] seconds pass;
    /// [up] is towards the start, which is the left edge when [sideways].
    private func scroll(_ scrollView: NSScrollView, speed: Double, limit: Double, up: Bool, sideways: Bool = false) async {
        var last: CFTimeInterval?
        var elapsed = 0.0
        await frames(timeout: limit + 2) { link in
            let now = link.timestamp
            let delta = last.map { now - $0 } ?? 0
            last = now
            elapsed += delta
            let clip = scrollView.contentView
            var bounds = clip.bounds
            let step = (up ? -1 : 1) * speed * delta
            if sideways { bounds.origin.x += step } else { bounds.origin.y += step }
            let target = clip.constrainBoundsRect(bounds).origin
            clip.scroll(to: target)
            scrollView.reflectScrolledClipView(clip)
            let atEnd: Bool
            if sideways {
                let maxX = (scrollView.documentView?.frame.width ?? 0) - clip.bounds.width
                atEnd = up ? target.x <= 0.5 : target.x >= maxX - 0.5
            } else {
                let maxY = (scrollView.documentView?.frame.height ?? 0) - clip.bounds.height + scrollView.contentInsets.bottom
                atEnd = up ? target.y <= -scrollView.contentInsets.top + 0.5 : target.y >= maxY - 0.5
            }
            return elapsed >= limit || (delta > 0 && atEnd)
        }
    }

    private func jump(_ scrollView: NSScrollView, top: Bool) {
        let clip = scrollView.contentView
        var bounds = clip.bounds
        bounds.origin.y = top ? -10_000_000 : 10_000_000
        clip.scroll(to: clip.constrainBoundsRect(bounds).origin)
        scrollView.reflectScrolledClipView(clip)
    }

    /// About 7 KB of the Markdown an agent writes: headings, lists, inline code, a table and code.
    static let sample: String = {
        var text = ""
        for section in 1...6 {
            text += "## 第 \(section) 部分：渲染管线的改动\n\n" // i18n-ignore: benchmark fixture markdown
            text += "这一段说明 **为什么** 要把排版移到后台线程，以及 `TranscriptLayout` 如何按宽度缓存结果。每一行只在内容或宽度变化时重新计算，" // i18n-ignore: benchmark fixture markdown
            text += "滚动时主线程只负责摆放已经算好的视图，所以新滚进来的行不会再触发同步布局。\n\n" // i18n-ignore: benchmark fixture markdown
            text += "- 解析：`swift-markdown` 产出块，行内样式转成 `NSAttributedString`\n" // i18n-ignore: benchmark fixture markdown
            text += "- 测量：TextKit 1 在后台排版，记下每一块的高度\n" // i18n-ignore: benchmark fixture markdown
            text += "- 绘制：主线程直接画已经排好的字形，不再重新排版\n\n" // i18n-ignore: benchmark fixture markdown
            text += "| 阶段 | 线程 | 预算 |\n| --- | --- | --- |\n| 解析 | 后台 | 不限 |\n| 排版 | 后台 | 不限 |\n| 应用 | 主线程 | < 4ms |\n\n" // i18n-ignore: benchmark fixture markdown
            text += "```swift\nfunc apply(_ snapshot: TranscriptSnapshot) {\n    let changes = diff(previous, snapshot)\n    tableView.beginUpdates()\n    tableView.insertRows(at: changes.inserted, withAnimation: [])\n    tableView.noteHeightOfRows(withIndexesChanged: changes.resized)\n    tableView.endUpdates()\n}\n```\n\n"
        }
        return text
    }()
}
