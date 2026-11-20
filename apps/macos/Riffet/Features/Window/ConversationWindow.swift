import SwiftUI
import RiffetKit

/// One conversation in its own window. It runs its own stream and transcript (`MacHost.openWindowStore`)
/// on the main window's connection; the session lists come from the main store. The window is built
/// once the app is connected, and again whenever the main workbench is replaced (another server, a
/// restart of the connection), since the stores it was built on are closed then.
struct ConversationWindow: View {
    static let id = "conversation"

    let sessionId: String?
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @State private var current: Attached?
    @State private var failed = false

    /// The window's workbench and the store it must close with it.
    @MainActor
    private final class Attached {
        let window: WindowSession
        let workbench: Workbench
        let main: Workbench
        let sessionId: String

        init(window: WindowSession, workbench: Workbench, main: Workbench, sessionId: String) {
            self.window = window
            self.workbench = workbench
            self.main = main
            self.sessionId = sessionId
        }

        func close() {
            workbench.close()
            window.close()
        }
    }

    private struct Key: Hashable {
        let main: ObjectIdentifier?
        let sessionId: String?
    }

    private var ready: Workbench? { model.phase == .ready ? model.workbench : nil }

    private var key: Key { Key(main: ready.map(ObjectIdentifier.init), sessionId: sessionId) }

    private var title: String {
        guard let title = current?.workbench.selected?.shownTitle, !title.isEmpty else { return String(localized: "会话") }
        return title
    }

    var body: some View {
        WindowContentLayout(minimum: CGSize(width: 740, height: 520), ideal: CGSize(width: 980, height: 800)) {
            if let current, ready === current.main {
                if failed {
                    message(String(localized: "无法打开这个会话"))
                } else {
                    WorkbenchView(workbench: current.workbench)
                }
            } else {
                message(model.phase == .connecting || model.phase == .launching ? String(localized: "正在连接 Riffet…") : String(localized: "未连接"))
            }
        }
        .navigationTitle(title)
        .onAppear { WindowRouter.shared.register(openWindow, settings: openSettings) }
        .task(id: key) { await attach() }
        .onDisappear { detach() }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(RiffetFont.label)
            .foregroundStyle(palette.fg3)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @MainActor
    private func attach() async {
        if let current, current.main === ready, current.sessionId == sessionId { return }
        detach()
        guard let sessionId, let main = ready, let window = model.host.openWindowStore() else { return }
        let workbench = Workbench(
            store: window.store, host: model.host, baseURL: main.baseURL, local: main.local,
            role: .window, presenter: window.presenter, listStore: main.store
        )
        current = Attached(window: window, workbench: workbench, main: main, sessionId: sessionId)
        let opened = await workbench.openReading(sessionId: sessionId)
        if !Task.isCancelled { failed = !opened }
    }

    @MainActor
    private func detach() {
        current?.close()
        current = nil
        failed = false
    }
}
