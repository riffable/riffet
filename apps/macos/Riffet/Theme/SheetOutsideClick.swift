import AppKit
import SwiftUI

/// Native sheets block their parent's SwiftUI gestures. Observe the backdrop click before
/// AppKit dispatches it, and route dismissal through the same draft/busy guard as the close button.
struct SheetOutsideClick: NSViewRepresentable {
    let onDismiss: () -> Void

    func makeNSView(context: Context) -> Anchor {
        let view = Anchor()
        view.start()
        return view
    }

    func updateNSView(_ view: Anchor, context: Context) { view.onDismiss = onDismiss }

    static func dismantleNSView(_ view: Anchor, coordinator: ()) { view.stop() }

    final class Anchor: NSView {
        var onDismiss: (() -> Void)?
        private var monitor: Any?
        private var observers: [NSObjectProtocol] = []
        private var trackingMenus = 0

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func start() {
            let center = NotificationCenter.default
            observers.append(center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.trackingMenus += 1 }
            })
            observers.append(center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { if let self { self.trackingMenus = max(0, self.trackingMenus - 1) } }
            })
            monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self, self.trackingMenus == 0,
                      let sheet = self.window, sheet.isVisible, sheet.attachedSheet == nil,
                      let parent = sheet.sheetParent, let eventWindow = event.window else { return event }
                let point = eventWindow.convertPoint(toScreen: event.locationInWindow)
                guard !sheet.frame.contains(point) else { return event }
                // Only the sheet's own backdrop counts. Other Riffet windows remain independent.
                var ancestor: NSWindow? = parent
                var isBackdrop = eventWindow === sheet && parent.frame.contains(point)
                while let window = ancestor {
                    if eventWindow === window { isBackdrop = true; break }
                    ancestor = window.sheetParent
                }
                guard isBackdrop else { return event }
                DispatchQueue.main.async { [weak self, weak sheet] in
                    guard let self, let sheet, self.window === sheet, sheet.attachedSheet == nil else { return }
                    self.onDismiss?()
                }
                // Do not let the dismissal click activate a row or action behind the sheet.
                return nil
            }
        }

        func stop() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            onDismiss = nil
        }
    }
}
