import SwiftUI
import RiffetKit

// Keyboard shortcuts of plugin commands, as `apps/web/src/app/pluginKeybindings.ts`: a plugin only declares
// a default, and it is registered (as a menu command, `RiffetCommands`) when no shortcut of the app and no
// earlier plugin holds it. A binding is `[Mod|Ctrl|Alt|Shift|Cmd+]<key>` and needs ⌃, ⌥ or ⌘.
enum PluginKeybindings {
    /// A shortcut that can be compared: the key and the modifiers.
    private struct Chord: Hashable {
        let key: Character
        let modifiers: Int
        init(_ shortcut: KeyboardShortcut) { key = shortcut.key.character; modifiers = shortcut.modifiers.rawValue }
    }

    private static let functionKeys: [Character] = (0..<12).map { Character(UnicodeScalar(0xF704 + $0)!) }

    private static let namedKeys: [String: KeyEquivalent] = [
        "enter": .return, "escape": .escape, "esc": .escape, "space": .space, "tab": .tab, "backspace": .delete, "delete": .deleteForward,
        "home": .home, "end": .end, "pageup": .pageUp, "pagedown": .pageDown,
        "up": .upArrow, "down": .downArrow, "left": .leftArrow, "right": .rightArrow,
        "arrowup": .upArrow, "arrowdown": .downArrow, "arrowleft": .leftArrow, "arrowright": .rightArrow,
    ]

    /// The shortcut a declared binding such as `Mod+Shift+K` names, or nil for one that cannot be used:
    /// an unknown key or modifier, or none of ⌃, ⌥, ⌘, which would fire while typing.
    static func parse(_ text: String) -> KeyboardShortcut? {
        var parts = text.split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let key = parts.popLast(), !key.isEmpty else { return nil }
        var modifiers: EventModifiers = []
        for part in parts {
            switch part.lowercased() {
            case "mod", "cmd", "command", "meta": modifiers.insert(.command)
            case "ctrl", "control": modifiers.insert(.control)
            case "alt", "option": modifiers.insert(.option)
            case "shift": modifiers.insert(.shift)
            default: return nil
            }
        }
        guard !modifiers.isDisjoint(with: [.control, .option, .command]) else { return nil }
        let lower = key.lowercased()
        let equivalent: KeyEquivalent
        if key.count == 1, let character = key.first, character.isASCII, character.isLetter || character.isNumber || "`-=[]\\;',./".contains(character) {
            equivalent = KeyEquivalent(Character(lower))
        } else if lower.hasPrefix("f"), let number = Int(lower.dropFirst()), (1...12).contains(number) {
            equivalent = KeyEquivalent(functionKeys[number - 1])
        } else if let named = namedKeys[lower] {
            equivalent = named
        } else {
            return nil
        }
        return KeyboardShortcut(equivalent, modifiers: modifiers)
    }

    /// What the app itself answers: its menu commands (`RiffetCommands`) and the system's. Keep it in step with them.
    private static let hostChords: Set<Chord> = {
        var keys = [
            "Mod+B", "Alt+Mod+I", "Alt+Mod+1", "Alt+Mod+2", "Alt+Mod+F", "Ctrl+`", "Shift+Mod+T", "Mod+R", "Mod+=", "Mod+-", "Mod+0",
            "Mod+N", "Mod+W", "Mod+K", "Shift+Mod+F", "Mod+F", "Mod+G", "Shift+Mod+G", "Shift+Mod+P", "Shift+Mod+L", "Shift+Mod+J",
            "Shift+Mod+E", "Shift+Mod+U", "Shift+Mod+[", "Shift+Mod+]", "Ctrl+Tab", "Ctrl+Shift+Tab", "Mod+.", "Alt+Mod+O",
            "Mod+Q", "Mod+H", "Alt+Mod+H", "Mod+M", "Mod+,", "Mod+A", "Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Shift+Mod+Z", "Ctrl+Mod+F", "Mod+P", "Mod+S", "Mod+O",
        ]
        keys += (1...9).map { "Mod+\($0)" }
        return Set(keys.compactMap { parse($0).map(Chord.init) })
    }()

    struct Resolution {
        /// The shortcut each registered command runs on.
        var registered: [(id: String, shortcut: KeyboardShortcut)] = []
        /// Commands whose binding is not registered: not usable, held by the app or by an earlier plugin.
        var rejected: Set<String> = []
    }

    /// Enabled plugins in order; a disabled plugin's binding is only checked against the app's.
    static func resolve(_ plugins: [PluginDescriptor]) -> Resolution {
        var result = Resolution()
        var taken = hostChords
        for plugin in plugins.filter(\.enabled) + plugins.filter({ !$0.enabled }) {
            for command in plugin.declared?.commands ?? [] {
                guard let binding = command.keybinding else { continue }
                guard let shortcut = parse(binding), !taken.contains(Chord(shortcut)) else { result.rejected.insert(command.id); continue }
                guard plugin.enabled else { continue }
                taken.insert(Chord(shortcut))
                result.registered.append((command.id, shortcut))
            }
        }
        return result
    }
}

/// 插件: the commands of enabled plugins that have a registered shortcut; one runs when its command is on offer.
struct PluginKeybindingMenu: Commands {
    let run: [String: () -> Void]?
    private var store: PluginsStore { PluginsStore.shared }

    var body: some Commands {
        let resolution = PluginKeybindings.resolve(store.items)
        let titles = Dictionary(store.items.flatMap { $0.declared?.commands ?? [] }.map { ($0.id, localizedText($0.title, fallback: $0.id)) }, uniquingKeysWith: { first, _ in first })
        if !resolution.registered.isEmpty {
            CommandMenu("插件") {
                ForEach(resolution.registered, id: \.id) { entry in
                    Button(titles[entry.id] ?? entry.id) { run?[entry.id]?() }
                        .keyboardShortcut(entry.shortcut)
                        .disabled(run?[entry.id] == nil)
                }
            }
        }
    }
}
