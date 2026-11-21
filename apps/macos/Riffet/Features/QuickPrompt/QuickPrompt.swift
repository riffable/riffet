import Foundation
import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    // Keep the stored name so existing custom shortcuts survive the move into the app.
    // ⌥Space as the shared table says (`quickPrompt`): ⌃Space and ⌃⌥Space are the system's input-source keys.
    static let quickPrompt: Self = {
        QuickPromptShortcutMigration.run()
        return Self("quickPrompt", initial: .init(.space, modifiers: [.option]))
    }()
}

/// The package writes a name's initial shortcut into UserDefaults the first time it is created, so a Mac
/// that never recorded its own key still holds the old initial ⌃⌥Space, and it looks the same as one
/// recorded on purpose. Once, that value becomes ⌥Space; any other key stays. Must run before the name exists.
enum QuickPromptShortcutMigration {
    private static let done = "riffet.quickPromptShortcut.v2"

    static func run() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: done) else { return }
        defaults.set(true, forKey: done)
        let key = "KeyboardShortcuts_quickPrompt"
        guard let text = defaults.string(forKey: key),
              let stored = try? JSONDecoder().decode(KeyboardShortcuts.Shortcut.self, from: Data(text.utf8)),
              stored == KeyboardShortcuts.Shortcut(.space, modifiers: [.control, .option]) else { return }
        defaults.removeObject(forKey: key)
    }
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
