import AppKit

/// A small floating readout of the monitor: frame rate, lateness, worst frame, main-thread load and
/// the last click-to-frame delay. It never takes focus and ignores the mouse.
@MainActor
final class PerfHUD {
    static let shared = PerfHUD()

    private var panel: NSPanel?
    private var label: NSTextField?
    private var timer: Timer?
    private var message: (text: String, until: Date)?

    var visible: Bool { panel != nil }

    func setVisible(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: PerfMonitor.hudKey)
        on ? show() : hide()
    }

    func show() {
        guard panel == nil else { return }
        if !PerfMonitor.shared.enabled { PerfMonitor.shared.setEnabled(true) }
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 58), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.ignoresMouseEvents = true
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let background = NSVisualEffectView(frame: panel.contentRect(forFrameRect: panel.frame))
        background.material = .hudWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 10
        background.layer?.masksToBounds = true
        let label = NSTextField(labelWithString: "")
        label.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        label.textColor = .labelColor
        label.maximumNumberOfLines = 3
        label.frame = background.bounds.insetBy(dx: 10, dy: 6)
        label.autoresizingMask = [.width, .height]
        background.addSubview(label)
        panel.contentView = background
        self.panel = panel
        self.label = label
        place()
        panel.orderFrontRegardless()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        refresh()
    }

    func hide() {
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
        panel = nil
        label = nil
    }

    /// Shows [text] in place of the numbers for a few seconds (benchmark progress and results).
    func flash(_ text: String, seconds: Double = 4) {
        message = (text, Date().addingTimeInterval(seconds))
        refresh()
    }

    private func place() {
        guard let panel else { return }
        let window = NSApp.windows.first { $0.identifier?.rawValue == WindowRouter.mainWindow } ?? NSApp.mainWindow
        let frame = window?.frame ?? NSScreen.main?.visibleFrame ?? .zero
        panel.setFrameOrigin(NSPoint(x: frame.maxX - panel.frame.width - 16, y: frame.minY + 16))
    }

    private func refresh() {
        guard let label else { return }
        place()
        if let message, message.until > Date() {
            label.stringValue = message.text
            return
        }
        message = nil
        let live = PerfMonitor.shared.live
        let input = live.lastInput.map { String(format: "%.0fms", $0) } ?? "—"
        label.stringValue = String(
            format: String(localized: "%@ · %.0f fps · 卡顿 %.1fms/s\n最差帧 %.1fms · 主线程 %.0f%% · 点击→帧 %@"),
            PerfMonitor.shared.page, live.fps, live.hitchPerSecond, live.worstFrame, live.mainBusy * 100, input
        )
    }
}
