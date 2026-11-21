import AppKit
import KeyboardShortcuts
import Observation
import SwiftUI

/// The Mac's keyboard shortcuts as they are now: this device's own bindings over the shared table's
/// defaults (`Shortcuts.generated.swift`, from `packages/contracts/src/shortcuts.ts`). A personal
/// preference of this Mac, so it is kept in UserDefaults and never sent to the server.
@MainActor
@Observable
final class ShortcutStore {
    static let shared = ShortcutStore()

    private static let key = "riffet.shortcuts.v1"

    /// Chords that replace the defaults, by shortcut id; an empty list turns the shortcut off.
    private(set) var overrides: [String: [String]]

    private init() {
        let data = UserDefaults.standard.data(forKey: Self.key)
        overrides = data.flatMap { try? JSONDecoder().decode([String: [String]].self, from: $0) } ?? [:]
    }

    func chords(_ id: ShortcutID) -> [String] {
        // The system-wide quick prompt is bound through KeyboardShortcuts (its own recorder and storage).
        if id == .quickPrompt {
            guard let shortcut = KeyboardShortcuts.getShortcut(for: .quickPrompt) else { return [] }
            return ShortcutChord.chord(keyCode: UInt16(shortcut.carbonKeyCode), modifiers: shortcut.modifiers).map { [$0] } ?? []
        }
        return overrides[id.rawValue] ?? id.defaults
    }

    /// The keys a menu item takes: the first usable chord.
    func shortcut(_ id: ShortcutID) -> KeyboardShortcut? {
        chords(id).lazy.compactMap { PluginKeybindings.parse($0) }.first
    }

    func isOverridden(_ id: ShortcutID) -> Bool { overrides[id.rawValue] != nil }
    var hasOverrides: Bool { !overrides.isEmpty }

    /// Binds one chord. An override equal to the default is dropped.
    func set(_ id: ShortcutID, chords: [String]) {
        if chords == id.defaults { overrides[id.rawValue] = nil } else { overrides[id.rawValue] = chords }
        save()
    }

    func reset(_ id: ShortcutID) {
        overrides[id.rawValue] = nil
        save()
    }

    func resetAll() {
        overrides = [:]
        save()
    }

    private func save() {
        if overrides.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.key)
        } else if let data = try? JSONEncoder().encode(overrides) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }

    /// Chords the app answers itself: every host shortcut as it is now, then the reserved ones.
    var hostChords: [String] {
        ShortcutID.allCases.flatMap { chords($0) } + reservedShortcutChords
    }

    enum Conflict: Equatable {
        /// Held by the system or a standard menu item.
        case reserved
        /// Held by another of the app's shortcuts.
        case taken(ShortcutID)
    }

    /// What stops `chord` from being bound to `id`, or nil.
    func conflict(_ chord: String, for id: ShortcutID) -> Conflict? {
        guard let wanted = PluginKeybindings.Chord(chord) else { return nil }
        if reservedShortcutChords.contains(where: { PluginKeybindings.Chord($0) == wanted }) { return .reserved }
        for other in ShortcutID.allCases where other != id {
            if chords(other).contains(where: { PluginKeybindings.Chord($0) == wanted }) { return .taken(other) }
        }
        return nil
    }
}

/// Chord text for display and for recording.
enum ShortcutChord {
    /// Keycaps in the system's order: ⌃ ⌥ ⇧ ⌘, then the key.
    static func keycaps(_ chord: String) -> [String] {
        guard !chord.isEmpty else { return [] }
        var parts = chord.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let key = parts.popLast() else { return [] }
        let names = Set(parts.map { $0.lowercased() })
        var caps: [String] = []
        if names.contains("ctrl") || names.contains("control") { caps.append("⌃") }
        if names.contains("alt") || names.contains("option") { caps.append("⌥") }
        if names.contains("shift") { caps.append("⇧") }
        if !names.isDisjoint(with: ["cmd", "command", "mod", "meta"]) { caps.append("⌘") }
        let glyphs = ["tab": "⇥", "space": "Space", "enter": "↩", "escape": "⎋", "backspace": "⌫", "delete": "⌦",
                      "up": "↑", "down": "↓", "left": "←", "right": "→"]
        caps.append(glyphs[key.lowercased()] ?? key.uppercased())
        return caps
    }

    /// US-layout keys by hardware key code, so a binding does not depend on the input source.
    private static let keys: [UInt16: String] = [
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V", 11: "B", 12: "Q", 13: "W", 14: "E",
        15: "R", 16: "Y", 17: "T", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9", 26: "7", 27: "-",
        28: "8", 29: "0", 30: "]", 31: "O", 32: "U", 33: "[", 34: "I", 35: "P", 37: "L", 38: "J", 39: "'", 40: "K", 41: ";",
        42: "\\", 43: ",", 44: "/", 45: "N", 46: "M", 47: ".", 50: "`",
        36: "Enter", 48: "Tab", 49: "Space", 51: "Backspace", 117: "Delete",
        115: "Home", 119: "End", 116: "PageUp", 121: "PageDown", 123: "Left", 124: "Right", 125: "Down", 126: "Up",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
    ]

    /// Keys named by what they are rather than by the character they type.
    private static let namedKeyCodes: Set<UInt16> = [36, 48, 49, 51, 117, 115, 119, 116, 121, 123, 124, 125, 126,
                                                     122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
    /// The characters a binding may name besides letters and digits (`PluginKeybindings.parse`).
    private static let punctuation = Set("`-=[]\\;',./")

    /// The chord a key press writes, or nil for a key the table cannot name. A menu key matches the character
    /// the current layout types, so that is what is recorded (⌘ with the key labelled Y on a German layout is
    /// ⌘Y); a layout that types no Latin character there falls back to the US key at that position, as the
    /// system's menus do.
    static func chord(from event: NSEvent) -> String? {
        if !namedKeyCodes.contains(event.keyCode),
           let typed = event.characters(byApplyingModifiers: [])?.lowercased(), typed.count == 1,
           let character = typed.first, character.isASCII,
           character.isLetter || character.isNumber || punctuation.contains(character) {
            return chord(key: character.isLetter ? typed.uppercased() : typed, modifiers: event.modifierFlags)
        }
        return chord(keyCode: event.keyCode, modifiers: event.modifierFlags)
    }

    /// The chord of a hardware key and modifiers, by the US layout (a system-wide hotkey is bound by key code).
    static func chord(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> String? {
        keys[keyCode].map { chord(key: $0, modifiers: modifiers) }
    }

    private static func chord(key: String, modifiers flags: NSEvent.ModifierFlags) -> String {
        var parts: [String] = []
        if flags.contains(.control) { parts.append("Ctrl") }
        if flags.contains(.option) { parts.append("Alt") }
        if flags.contains(.shift) { parts.append("Shift") }
        if flags.contains(.command) { parts.append("Cmd") }
        return (parts + [key]).joined(separator: "+")
    }
}

extension View {
    /// The menu key of a shared-table shortcut, as the user has it now.
    @MainActor func shortcut(_ id: ShortcutID) -> some View {
        keyboardShortcut(ShortcutStore.shared.shortcut(id))
    }
}
