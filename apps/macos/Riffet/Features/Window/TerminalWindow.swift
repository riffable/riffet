import SwiftUI

/// One terminal in its own macOS window, opened from the terminal toolbar or menu.
/// Owns a dedicated [TerminalController] and client id so its AppKit view never contends with the
/// main window's keep-alive dock.
struct TerminalWindow: View {
    static let id = "terminal"

    let terminalId: String?
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var controller = TerminalController()
    @State private var windowClientId = "mac-term-\(UUID().uuidString.lowercased())"

    private var ready: Workbench? { model.phase == .ready ? model.workbench : nil }

    var body: some View {
        Group {
            if let workbench = ready, let terminalId {
                TerminalSurface(
                    workbench: workbench,
                    terminalId: terminalId,
                    title: String(localized: "终端"),
                    allowPopOut: false,
                    clientIdOverride: windowClientId,
                    controllerOverride: controller
                )
            } else {
                ContentUnavailableView {
                    Label("终端不可用", icon: "terminal")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.bg)
            }
        }
        .navigationTitle(controller.displayTitle(fallback: String(localized: "终端")))
        .frame(minWidth: 480, minHeight: 300)
        .onDisappear { controller.stop() }
    }
}
