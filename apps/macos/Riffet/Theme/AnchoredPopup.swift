import AppKit
import SwiftUI

enum PopupEdge { case above, below }

private struct PopupAvailableSizeKey: EnvironmentKey {
    static let defaultValue = CGSize(width: 420, height: 800)
}

extension EnvironmentValues {
    var popupAvailableSize: CGSize {
        get { self[PopupAvailableSizeKey.self] }
        set { self[PopupAvailableSizeKey.self] = newValue }
    }
}

/// Menu placement in screen coordinates. Its left edge follows the trigger, and content updates
/// never change that alignment. Only an actual window/screen boundary can move it sideways.
enum PopupPlacement {
    static func frame(anchor: CGRect, size: CGSize, bounds: CGRect, edge: PopupEdge, gap: CGFloat = 8) -> CGRect {
        let width = min(size.width, bounds.width)
        let height = min(size.height, bounds.height)
        let above = bounds.maxY - anchor.maxY - gap
        let below = anchor.minY - bounds.minY - gap
        let useAbove = edge == .above ? (above >= height || above >= below) : !(below >= height || below >= above)
        let x = min(max(anchor.minX, bounds.minX), bounds.maxX - width)
        let y = useAbove ? anchor.maxY + gap : anchor.minY - gap - height
        return CGRect(x: x, y: min(max(y, bounds.minY), bounds.maxY - height), width: width, height: height)
    }
}

extension View {
    /// A native child panel for compact menus, without the system popover's bubble and arrow.
    /// [inset] is transparent room the content leaves around itself for a shadow it draws; the
    /// window then draws none of its own, and the content, not the window, is what sits at the anchor.
    func anchoredPopup<Content: View>(isPresented: Binding<Bool>, edge: PopupEdge = .above, inset: CGFloat = 0, @ViewBuilder content: () -> Content) -> some View {
        background(PopupAnchor(isPresented: isPresented, edge: edge, inset: inset, content: content()).allowsHitTesting(false))
    }

    /// A system `.popover` under the system menu recipe; under the drawn one, a non-glass anchored
    /// popup with the drawn menu's surface. The arrow edge only picks above or below.
    func stylePopover<Content: View>(isPresented: Binding<Bool>, arrowEdge: Edge? = nil, @ViewBuilder content: @escaping () -> Content) -> some View {
        modifier(StylePopover(isPresented: isPresented, arrowEdge: arrowEdge, popup: content))
    }
}

private struct StylePopover<Popup: View>: ViewModifier {
    @Binding var isPresented: Bool
    let arrowEdge: Edge?
    let popup: () -> Popup

    func body(content: Content) -> some View {
        if DisplayPreferences.shared.style.menu == .drawn {
            content.anchoredPopup(isPresented: $isPresented, edge: arrowEdge == .top ? .above : .below, inset: PopoverSurface<Popup>.inset) {
                PopoverSurface(content: popup)
            }
        } else if let arrowEdge {
            content.popover(isPresented: $isPresented, arrowEdge: arrowEdge, content: popup)
        } else {
            content.popover(isPresented: $isPresented, content: popup)
        }
    }
}

/// The drawn menu's card around a popup's content: paper fill, hairline, floating radius, and its shadow.
private struct PopoverSurface<Content: View>: View {
    static var inset: CGFloat { 44 }

    let content: () -> Content
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let style = DisplayPreferences.shared.style
        let shape = RoundedRectangle(cornerRadius: style.radii.floating, style: .continuous)
        content()
            .background(palette.bgPopover, in: shape)
            .clipShape(shape)
            .overlay(shape.strokeBorder(style.surface == .outlined ? palette.lineStrong : palette.line, lineWidth: 1))
            .shadow(color: scheme == .dark ? .black.opacity(0.5) : Color(red: 60 / 255, green: 50 / 255, blue: 40 / 255).opacity(0.16), radius: 20, y: 12)
            .padding(Self.inset)
    }
}

private struct PopupAnchor<Content: View>: NSViewRepresentable {
    @Binding var isPresented: Bool
    let edge: PopupEdge
    let inset: CGFloat
    let content: Content

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.changed = { [weak coordinator = context.coordinator] in coordinator?.position() }
        context.coordinator.anchor = view
        return view
    }

    func updateNSView(_ view: AnchorView, context: Context) {
        let coordinator = context.coordinator
        coordinator.presented = $isPresented
        coordinator.edge = edge
        coordinator.inset = inset
        guard isPresented, context.environment.isEnabled else {
            coordinator.close(updateBinding: isPresented, restoreFocus: false)
            return
        }
        coordinator.show(AnyView(content
            .environment(\.palette, context.environment.palette)
            .environment(\.colorScheme, context.environment.colorScheme)))
    }

    static func dismantleNSView(_ view: AnchorView, coordinator: Coordinator) {
        coordinator.close(updateBinding: false, restoreFocus: false)
        view.changed = nil
    }

    final class AnchorView: NSView {
        var changed: (() -> Void)?
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); changed?() }
        override func layout() { super.layout(); changed?() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    @MainActor
    final class Coordinator: NSObject {
        weak var anchor: AnchorView?
        var presented: Binding<Bool>?
        var edge = PopupEdge.above
        var inset: CGFloat = 0
        private var panel: MenuPanel?
        private var host: NSHostingController<AnyView>?
        private var content: AnyView?
        private var localMonitor: Any?
        private var globalMonitor: Any?
        private var observers: [NSObjectProtocol] = []
        private weak var previousResponder: NSResponder?
        private var trackingMenus = 0
        private var availableSize = CGSize.zero

        func show(_ content: AnyView) {
            self.content = content
            guard let window = anchor?.window else { return }
            availableSize = availableSpace(in: window)
            let fitted = AnyView(content.environment(\.popupAvailableSize, availableSize))
            if let host, panel?.isVisible == true {
                host.rootView = fitted
                position()
                return
            }
            let host = NSHostingController(rootView: fitted)
            host.sizingOptions = []
            let panel = MenuPanel(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = inset == 0
            panel.hidesOnDeactivate = true
            panel.animationBehavior = .none
            panel.contentViewController = host
            panel.appearance = window.effectiveAppearance
            self.host = host
            self.panel = panel
            previousResponder = window.firstResponder
            window.addChildWindow(panel, ordered: .above)
            position()
            panel.makeKeyAndOrderFront(nil)
            monitor(window)
        }

        func position() {
            guard let anchor, let window = anchor.window else { return }
            if panel == nil, let content, presented?.wrappedValue == true { show(content); return }
            guard let panel, let host, let screen = window.screen ?? NSScreen.main else { return }
            let bounds = screen.visibleFrame.insetBy(dx: 8, dy: 8)
            let nextAvailableSize = availableSpace(in: window)
            if availableSize != nextAvailableSize, let content {
                availableSize = nextAvailableSize
                host.rootView = AnyView(content.environment(\.popupAvailableSize, availableSize))
            }
            panel.appearance = window.effectiveAppearance
            let size = host.sizeThatFits(in: availableSize)
            guard size.width > 0, size.height > 0 else { return }
            let rect = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
            let inner = CGSize(width: max(1, size.width - 2 * inset), height: max(1, size.height - 2 * inset))
            let frame = PopupPlacement.frame(anchor: rect, size: inner, bounds: bounds, edge: edge).insetBy(dx: -inset, dy: -inset)
            if panel.frame != frame { panel.setFrame(frame, display: true) }
        }

        private func availableSpace(in window: NSWindow) -> CGSize {
            let bounds = (window.screen ?? NSScreen.main)?.visibleFrame.insetBy(dx: 8, dy: 8) ?? window.frame
            return CGSize(width: min(420, bounds.width), height: bounds.height)
        }

        func close(updateBinding: Bool = true, restoreFocus: Bool = false) {
            let parent = panel?.parent
            if let panel { parent?.removeChildWindow(panel); panel.orderOut(nil) }
            panel = nil
            host = nil
            content = nil
            if let localMonitor { NSEvent.removeMonitor(localMonitor) }
            if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
            localMonitor = nil
            globalMonitor = nil
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            trackingMenus = 0
            if restoreFocus, let parent { parent.makeKeyAndOrderFront(nil); parent.makeFirstResponder(previousResponder) }
            previousResponder = nil
            if updateBinding, let presented, presented.wrappedValue {
                DispatchQueue.main.async { presented.wrappedValue = false }
            }
        }

        private func monitor(_ parent: NSWindow) {
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { [weak self] event in
                guard let self, let panel = self.panel else { return event }
                // AppKit menus have their own tracking windows and consume their own Escape key.
                if self.trackingMenus > 0 { return event }
                if event.type == .keyDown {
                    if event.window === panel, event.keyCode == 53 { self.close(restoreFocus: true); return nil }
                } else if event.window !== panel, event.window === parent || event.window?.isKeyWindow == true {
                    if event.window === parent, let anchor = self.anchor,
                       anchor.bounds.contains(anchor.convert(event.locationInWindow, from: nil)) { return event }
                    self.close()
                }
                return event
            }
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in self?.close() }
            let center = NotificationCenter.default
            observers.append(center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.trackingMenus += 1 }
            })
            observers.append(center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.trackingMenus = max(0, self.trackingMenus - 1)
                }
            })
            for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
                observers.append(center.addObserver(forName: name, object: parent, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.position() } })
            }
            observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: parent, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.close() } })
            observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.close() } })
        }
    }
}

private final class MenuPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
