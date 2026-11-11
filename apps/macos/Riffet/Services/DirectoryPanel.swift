import AppKit

/// Directory selection shared by Home and Sidebar, attached only to the workbench window.
@MainActor
enum DirectoryPanel {
    private static var presenting = false

    static func choose(
        prompt: String,
        windows: [NSWindow]? = nil,
        makePanel: @MainActor () -> NSOpenPanel = { NSOpenPanel() }
    ) async -> URL? {
        guard !Task.isCancelled, !presenting,
              let window = (windows ?? NSApp.windows).first(where: { $0.identifier?.rawValue == WindowRouter.mainWindow }),
              window.attachedSheet == nil else { return nil }
        presenting = true
        defer { presenting = false }

        let panel = makePanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = prompt
        defer { panel.orderOut(nil) }

        let response = await withTaskCancellationHandler {
            await panel.beginSheetModal(for: window)
        } onCancel: {
            Task { @MainActor in
                // Cancellation owns only this panel, never another dialog attached later.
                if window.attachedSheet === panel {
                    window.endSheet(panel, returnCode: .cancel)
                }
            }
        }
        guard !Task.isCancelled, response == .OK else { return nil }
        return panel.url
    }
}
