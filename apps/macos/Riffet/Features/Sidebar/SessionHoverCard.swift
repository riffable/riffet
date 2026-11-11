import AppKit
import SwiftUI
import RiffetKit

/// What the hover card shows for a session row: the full title the row truncates, then the
/// project, agent and last activity the row no longer spends width on.
struct SessionHoverInfo: Equatable {
    var title: String
    var state: SessionState
    var project: String?
    /// Backend identity behind the display name in `agent`, for its mark.
    var backend: String
    var agent: String
    var model: String?
    var activity: String
}

struct SessionHoverCardView: View {
    let info: SessionHoverInfo
    @Environment(\.palette) private var palette
    @Environment(\.displayScale) private var displayScale

    static var radius: CGFloat { Radius.card }

    /// The full title, then one quiet line per fact, each led by an icon instead of a label: the
    /// card reads as a note about the row, not a form.
    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // Only a state that draws something takes the slot; an idle title starts at the edge.
                if [.running, .starting, .cancelling, .waiting, .failed].contains(info.state) { SessionStateMark(state: info.state) }
                Text(info.title)
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(2)
            }
            VStack(alignment: .leading, spacing: Space.xs) {
                line {
                    AgentIcon(id: info.backend, size: 12, color: agentMarkColor(info.backend, palette))
                } text: {
                    [info.agent, info.model].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
                }
                if let project = info.project, !project.isEmpty {
                    line { symbol("folder") } text: { project }
                }
                line { symbol("clock") } text: { info.activity }
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm + Space.xxs)
        .frame(width: 272, alignment: .leading)
        .background(surface)
    }

    /// The window's material shows through the panel behind this, tinted like the sidebar, so the
    /// card is the same glass as the sidebar it comes out of. One hairline draws its edge: what the
    /// glass looks like depends on what lies behind it, so a tint alone cannot tell it from the page.
    private var surface: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        let prefs = DisplayPreferences.shared
        return shape.fill(palette.bgPopover.opacity(prefs.material == .solid ? 1 : prefs.sidebarTint))
            // One device pixel on any screen: half a point blurs into a faint half-pixel on a 1x display.
            .overlay(shape.strokeBorder(palette.line, lineWidth: 1 / max(1, displayScale)))
    }

    private func symbol(_ name: String) -> some View {
        Image(icon: name).font(.riffet(size: S(10.5))).foregroundStyle(palette.fg4)
    }

    private func line<Icon: View>(@ViewBuilder icon: () -> Icon, text: () -> String) -> some View {
        HStack(spacing: Space.sm) {
            icon().frame(width: 12)
            Text(text())
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg2)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

/// Holds the AppKit view behind a row so the card can anchor to its screen rectangle.
final class HoverAnchorBox {
    weak var view: NSView?
}

/// An invisible background view that reports the row's AppKit frame. It never takes hits, so it
/// costs the row no interaction behaviour.
struct HoverAnchor: NSViewRepresentable {
    let box: HoverAnchorBox

    func makeNSView(context: Context) -> AnchorView {
        let view = AnchorView()
        box.view = view
        return view
    }

    func updateNSView(_ view: AnchorView, context: Context) {
        box.view = view
    }

    static func dismantleNSView(_ view: AnchorView, coordinator: ()) {
        _ = view
    }

    final class AnchorView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

/**
 * The one hover card in the app, following `AnchoredPopup`'s child-window pattern but passive:
 * the panel never becomes key and ignores the mouse, so clicks, scrolling and typing pass through
 * while it is up. `.help` is neither themeable nor quick (its delay and beige face are the
 * system's); here the delay is 450 ms and the card is palette-drawn.
 */
@MainActor
final class SessionHoverCardController {
    static let shared = SessionHoverCardController()

    private var panel: NSPanel?
    private var host: NSHostingController<AnyView>?
    private weak var parentWindow: NSWindow?
    /// The row the card is scheduled/shown for: a recycled row disappearing later must not hide it.
    private weak var currentAnchor: NSView?
    private var token = UUID()
    private var showTask: Task<Void, Never>?
    private var hideTask: Task<Void, Never>?
    private var localMonitor: Any?
    private var observers: [NSObjectProtocol] = []
    private var guardMonitor: Any?
    private var menuTracking = 0

    /// A stretchable rounded-rect mask so the effect view's corners match the card's radius, one per
    /// radius the interface styles use.
    private static var roundedCardMasks: [CGFloat: NSImage] = [:]

    private static func roundedCardMask(_ radius: CGFloat) -> NSImage {
        if let mask = roundedCardMasks[radius] { return mask }
        let edge = radius * 2 + 2
        let image = NSImage(size: NSSize(width: edge, height: edge))
        image.lockFocus()
        NSColor.black.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: edge, height: edge), xRadius: radius, yRadius: radius).fill()
        image.unlockFocus()
        image.capInsets = NSEdgeInsets(top: radius + 1, left: radius + 1, bottom: radius + 1, right: radius + 1)
        image.resizingMode = .stretch
        roundedCardMasks[radius] = image
        return image
    }

    func schedule(info: SessionHoverInfo, palette: Palette, anchor: NSView) {
        installGuardsIfNeeded()
        currentAnchor = anchor
        token = UUID()
        let scheduled = token
        showTask?.cancel()
        hideTask?.cancel()
        // A card already on screen swaps to the new row quickly; only the first appearance waits.
        let delay: UInt64 = panel?.isVisible == true ? 80_000_000 : 450_000_000
        showTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard let self, !Task.isCancelled, token == scheduled else { return }
            present(info: info, palette: palette, anchor: anchor)
        }
    }

    /// Delayed, so gliding from one row to the next swaps the card instead of flashing it away.
    /// A hide from a row that is no longer the card's anchor (recycled while scrolling) is ignored.
    func hide(anchor: NSView? = nil) {
        if let anchor, let currentAnchor, anchor !== currentAnchor { return }
        showTask?.cancel()
        let scheduled = token
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard let self, !Task.isCancelled, token == scheduled else { return }
            dismiss()
        }
    }

    func hideNow() {
        token = UUID()
        showTask?.cancel()
        hideTask?.cancel()
        dismiss()
    }

    /**
     * Interaction that must pre-empt the card even while it is only scheduled: a click (the first
     * half of the double-click that starts a rename), any scrolling, an opening menu. Installed
     * once, and cheap: it only ever cancels.
     */
    private func installGuardsIfNeeded() {
        guard guardMonitor == nil else { return }
        guardMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .scrollWheel, .keyDown]) { [weak self] event in
            self?.hideNow()
            return event
        }
        let center = NotificationCenter.default
        center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.menuTracking += 1
                self?.hideNow()
            }
        }
        center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.menuTracking = max(0, (self?.menuTracking ?? 1) - 1) }
        }
    }

    private func present(info: SessionHoverInfo, palette: Palette, anchor: NSView) {
        // Never over a rename alert or sheet, a tracked menu, or a background window: the pointer
        // can still be resting on the row behind all of those.
        guard let window = anchor.window, window.isKeyWindow, NSApp.isActive, NSApp.modalWindow == nil, menuTracking == 0 else { return }
        let panel: NSPanel
        let host: NSHostingController<AnyView>
        if let existingPanel = self.panel, let existingHost = self.host {
            panel = existingPanel
            host = existingHost
        } else {
            host = NSHostingController(rootView: AnyView(EmptyView()))
            host.sizingOptions = []
            panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isFloatingPanel = true
            panel.isReleasedWhenClosed = false
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = true
            panel.ignoresMouseEvents = true
            panel.animationBehavior = .none
            host.view.autoresizingMask = [.width, .height]
            let container = NSView()
            container.addSubview(host.view)
            panel.contentView = container
            self.panel = panel
            self.host = host
        }
        setBackdrop(DisplayPreferences.shared.material, in: panel)
        host.rootView = AnyView(SessionHoverCardView(info: info).environment(\.palette, palette))
        let size = host.sizeThatFits(in: CGSize(width: 320, height: 900))
        guard size.width > 0, size.height > 0 else { return }
        let anchorRect = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
        // Out past the sidebar, not the row: a row ends inside the sidebar's glass, and a card
        // starting there straddles its edge.
        let column = anchor.enclosingScrollView.map { window.convertToScreen($0.convert($0.bounds, to: nil)) } ?? anchorRect
        let bounds = (window.screen ?? NSScreen.main)?.visibleFrame.insetBy(dx: 8, dy: 8) ?? anchorRect
        var x = column.maxX + Space.md
        if x + size.width > bounds.maxX { x = column.minX - Space.md - size.width }
        x = min(max(x, bounds.minX), max(bounds.minX, bounds.maxX - size.width))
        // The card's title on the hovered row's line: its centre sits the top padding and half a
        // title line below the card's top.
        let titleCenter = Space.sm + Space.xxs + S(16) / 2
        let top = anchorRect.midY + titleCenter
        let y = min(max(top - size.height, bounds.minY), max(bounds.minY, bounds.maxY - size.height))
        if parentWindow !== window {
            if let parentWindow { parentWindow.removeChildWindow(panel) }
            window.addChildWindow(panel, ordered: .above)
            parentWindow = window
            installMonitors(window: window)
        }
        panel.appearance = window.effectiveAppearance
        let wasVisible = panel.isVisible
        panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
        if wasVisible {
            panel.alphaValue = 1
            panel.orderFront(nil)
        } else {
            panel.alphaValue = 0
            panel.orderFront(nil)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                panel.animator().alphaValue = 1
            }
        }
    }

    private var backdropMaterial: WindowMaterial?
    private var backdrop: NSView?

    /// The window's material behind the card: the same glass or blur, or none for an opaque card.
    private func setBackdrop(_ material: WindowMaterial, in panel: NSPanel) {
        guard material != backdropMaterial, let container = panel.contentView else { return }
        backdropMaterial = material
        // A borderless window's shadow outlines its shape with a hairline; over glass or a blur
        // that reads as a frame, so only the opaque card keeps it.
        panel.hasShadow = material == .solid
        backdrop?.removeFromSuperview()
        backdrop = nil
        let view: NSView
        switch material {
        case .solid:
            return
        case .glass:
            guard #available(macOS 26, *) else { return }
            // The window's own glass. It lights its rim from the top left, so the hairline reads
            // fainter on that side; that is the glass, kept on purpose.
            let glass = NSGlassEffectView()
            glass.style = .regular
            glass.cornerRadius = SessionHoverCardView.radius
            view = glass
        case .frosted:
            let effect = NSVisualEffectView()
            effect.material = .popover
            effect.blendingMode = .behindWindow
            effect.state = .active
            effect.maskImage = Self.roundedCardMask(SessionHoverCardView.radius)
            view = effect
        }
        view.frame = container.bounds
        view.autoresizingMask = [.width, .height]
        container.addSubview(view, positioned: .below, relativeTo: nil)
        backdrop = view
    }

    private func dismiss() {
        if let panel {
            parentWindow?.removeChildWindow(panel)
            panel.orderOut(nil)
        }
        currentAnchor = nil
        parentWindow = nil
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        localMonitor = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
    }

    private func installMonitors(window: NSWindow) {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .leftMouseDown, .rightMouseDown]) { [weak self] event in
            self?.hideNow()
            return event
        }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.hideNow() }
        })
        observers.append(center.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.hideNow() }
        })
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.hideNow() }
        })
    }
}
