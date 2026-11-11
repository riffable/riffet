import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    // Keep the stored name so existing custom shortcuts survive the move into the app.
    // ⌥⌘Space is Finder's "显示搜索窗口".
    static let quickPrompt = Self("quickPrompt", initial: .init(.space, modifiers: [.control, .option]))
}

/// System entries open the app's composer, sharing its drafts and conversation lifecycle.
@MainActor
enum QuickPrompt {
    static func install() {
        KeyboardShortcuts.onKeyUp(for: .quickPrompt) { show() }
    }

    static func show(prefill: String = "") {
        WindowRouter.shared.showMain()
        AppModel.shared.whenReady { $0.openQuickChat(prefill: prefill) }
    }
}
