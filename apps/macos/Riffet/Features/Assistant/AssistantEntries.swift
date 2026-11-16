import AppKit
import SwiftUI
import RiffetKit

/// The 个人助理's installed capability packs, one entry each, above its composer (docs/ASSISTANT.md §8.2).
/// An entry puts the pack's command at the start of the draft, so the message is answered with that
/// pack's skill. Nothing shows until a pack is added in Settings; read again as the main window
/// comes back to the front, which is when Settings closes.
struct AssistantEntries: View {
    let workbench: Workbench
    let composer: ComposerModel
    @State private var packs: [AssistantPack] = []

    var body: some View {
        let shown = packs.compactMap { pack -> (AssistantPack, String)? in
            guard pack.installed, let entry = pack.entry, !entry.isEmpty else { return nil }
            return (pack, entry)
        }
        Group {
            if !shown.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.xs) {
                        ForEach(shown, id: \.0.id) { pack, entry in
                            Button(pack.title) { pick(entry) }
                                .buttonStyle(SolidButtonStyle(kind: .secondary))
                                .help(pack.description_ ?? "")
                        }
                    }
                }
            }
        }
        .task { await load() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeMainNotification)) { _ in Task { await load() } }
    }

    private func load() async {
        if let list = try? await workbench.host.api?.assistantPacks() { packs = list }
    }

    /// The command goes first; what was typed stays after it, on its own line.
    private func pick(_ entry: String) {
        let command = "\(entry) "
        let rest = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = rest.isEmpty ? command : "\(command)\n\(rest)"
        composer.replace(text: next, caret: (command as NSString).length)
    }
}
