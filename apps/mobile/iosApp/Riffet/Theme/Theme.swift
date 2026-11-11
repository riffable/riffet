import SwiftUI
import UIKit

extension RiffetRGBA {
    /// Reads the hex colours the theme library stores: `#rrggbb`, or `#rrggbbaa` in CSS byte order.
    /// The argument is optional so the generated `init?(roleValues:)` can hand a dictionary lookup
    /// straight in: a missing role reads as a failure rather than a crash.
    init?(hex: String?) {
        guard let hex else { return nil }
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6 || digits.count == 8, let value = UInt32(digits, radix: 16) else { return nil }
        let channel = { (shift: UInt32) in Double((value >> shift) & 0xFF) / 255 }
        if digits.count == 8 {
            self.init(channel(24), channel(16), channel(8), channel(0))
        } else {
            self.init(channel(16), channel(8), channel(0), 1)
        }
    }

    /// This colour moved `amount` of the way towards `other`, alpha included.
    func mixed(with other: RiffetRGBA, _ amount: Double) -> RiffetRGBA {
        let lerp = { (a: Double, b: Double) in a + (b - a) * amount }
        return RiffetRGBA(lerp(red, other.red), lerp(green, other.green), lerp(blue, other.blue), lerp(alpha, other.alpha))
    }
    func withAlpha(_ value: Double) -> RiffetRGBA { RiffetRGBA(red, green, blue, alpha * value) }

    /// `#rrggbb`, or `#rrggbbaa` when translucent — the form the wire and the editor share.
    var hex: String {
        let channel = { (value: Double) in String(format: "%02x", Int((value * 255).rounded())) }
        let rgb = "#" + channel(red) + channel(green) + channel(blue)
        return alpha >= 1 ? rgb : rgb + channel(alpha)
    }
}

/// One pickable built-in theme. Custom themes from the server library are not
/// consumed on iOS yet; the catalogue is the same six the stylesheet ships.
struct ThemeEntry: Identifiable, Sendable {
    let id: String
    let name: String
    let values: RiffetThemeValues
}

/// The selected palette, stored independently of the light/dark mode (the
/// existing `riffet.ios.appearance` preference): a theme picks the palette,
/// the mode picks which half of it is in use — the same split as the web's
/// `data-theme` + `.dark` and macOS's ThemeStore. Only built-ins for now.
@MainActor
@Observable
final class ThemeStore {
    private static let key = "riffet.ios.theme"

    var themeId: String {
        didSet {
            UserDefaults.standard.set(themeId, forKey: Self.key)
            PaletteColorCache.shared.use(entry.values)
        }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.key)
        themeId = Self.migrated(stored) ?? Self.builtins[0].id
        if stored != nil, stored != themeId { UserDefaults.standard.set(themeId, forKey: Self.key) }
        PaletteColorCache.shared.use(entry.values)
    }

    /// Ids from before a theme was renamed keep the reader's choice; an id
    /// this build does not ship (renamed away, or written by a newer build)
    /// falls back to the default instead of leaving the picker with no
    /// matching selection while the UI shows the first theme.
    private static func migrated(_ id: String?) -> String? {
        guard let id else { return nil }
        let renamed = id == "claude" ? "kiln" : id
        return Self.builtins.contains { $0.id == renamed } ? renamed : nil
    }

    static let builtins: [ThemeEntry] = RiffetThemeCatalog.all.map { values in
        ThemeEntry(id: values.id, name: builtinName(values.id), values: values)
    }

    private static func builtinName(_ id: String) -> String {
        switch id {
        case "solarized": "Solarized"
        case "catppuccin": "Catppuccin"
        case "rose-pine": "Rosé Pine"
        case "kiln": "Kiln"
        case "everforest": "Everforest"
        case "ink": "Ink"
        case "sepia": "Sepia"
        case "moss": "Moss"
        case "slate": "Slate"
        case "pencil": "Pencil"
        case "celadon": "Celadon"
        default: "Riffet"
        }
    }

    var entry: ThemeEntry { Self.builtins.first { $0.id == themeId } ?? Self.builtins[0] }
    var palette: Palette { Palette(values: entry.values) }
}

/// A resolved palette: each role is a dynamic colour that reads the light or
/// dark half from the current trait, so a mode change needs no re-resolution.
@dynamicMemberLookup
struct Palette: Sendable {
    let values: RiffetThemeValues

    /// One colour per theme and role: a theme switch hands SwiftUI a different
    /// colour, so every view that reads it redraws at once. (A single colour
    /// re-pointed at the new theme compares equal and leaves views stale.)
    subscript(dynamicMember role: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable) -> Color {
        ThemeColors.shared.color(values, key: role) { $0[keyPath: role] }
    }

    /// Rows of a grouped list: the theme's own base surface in light, raised in dark —
    /// never a pure white card on a tinted page.
    var groupedRow: Color {
        ThemeColors.shared.color(values, light: \.bg, dark: \.bgElevated)
    }

    /// A selected row, chip or bubble: the card with a little accent mixed in (Android's `selected`).
    var selected: Color {
        ThemeColors.shared.derived(values, key: "selected") { palette, dark in
            (dark ? palette.bgElevated : palette.bg).mixed(with: palette.accent, dark ? 0.22 : 0.09)
        }
    }
    /// The pressed and resting-control fill: the text colour at 5.5%.
    var press: Color {
        ThemeColors.shared.derived(values, key: "press") { palette, _ in palette.fg.withAlpha(0.055) }
    }

    /// The same role as a dynamic UIKit colour, for the app-wide bar appearances.
    func uiColor(_ role: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable) -> UIColor {
        PaletteColorCache.shared.color(role)
    }
}

/// SwiftUI colours, cached per theme so a theme's colours keep their identity while it is in use.
private final class ThemeColors: @unchecked Sendable {
    static let shared = ThemeColors()
    private let lock = NSLock()
    private var colors: [String: Color] = [:]

    func color(_ values: RiffetThemeValues, key: AnyKeyPath, _ pick: (RiffetPaletteValues) -> RiffetRGBA) -> Color {
        cached("\(values.id)|\(key.hashValue)") { Self.dynamic(light: pick(values.light), dark: pick(values.dark)) }
    }
    func color(_ values: RiffetThemeValues, light: KeyPath<RiffetPaletteValues, RiffetRGBA>, dark: KeyPath<RiffetPaletteValues, RiffetRGBA>) -> Color {
        cached("\(values.id)|\(light.hashValue)|\(dark.hashValue)") { Self.dynamic(light: values.light[keyPath: light], dark: values.dark[keyPath: dark]) }
    }
    func derived(_ values: RiffetThemeValues, key: String, _ make: (RiffetPaletteValues, Bool) -> RiffetRGBA) -> Color {
        cached("\(values.id)|derived.\(key)") { Self.dynamic(light: make(values.light, false), dark: make(values.dark, true)) }
    }
    private func cached(_ key: String, _ make: () -> Color) -> Color {
        lock.lock(); defer { lock.unlock() }
        if let hit = colors[key] { return hit }
        let color = make()
        colors[key] = color
        return color
    }
    private static func dynamic(light: RiffetRGBA, dark: RiffetRGBA) -> Color {
        func ui(_ rgba: RiffetRGBA) -> UIColor { UIColor(red: CGFloat(rgba.red), green: CGFloat(rgba.green), blue: CGFloat(rgba.blue), alpha: CGFloat(rgba.alpha)) }
        let light = ui(light), dark = ui(dark)
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

/// One dynamic colour per role for the life of the app. The provider reads the
/// current theme out of the box at draw time (dynamic colours resolve when
/// drawn, against the drawing view's traits), so a colour's identity never
/// changes when the theme does: a theme switch repaints everything through
/// the same objects. That matters beyond tidiness — the tab bar's declared
/// background keeping its identity is what stops SwiftUI reconfiguring the
/// tab controller on a theme change, which used to restart it on the first
/// tab and write that selection back over the user's.
private final class PaletteColorCache: @unchecked Sendable {
    static let shared = PaletteColorCache()

    private let lock = NSLock()
    private var colors: [AnyKeyPath: UIColor] = [:]
    private var current: RiffetThemeValues = RiffetThemeCatalog.all[0]

    /// Points every colour at a new theme. Called by the store on init and on
    /// every selection change; no colour object is created or replaced.
    func use(_ values: RiffetThemeValues) {
        lock.lock()
        current = values
        lock.unlock()
    }

    func color(_ role: KeyPath<RiffetPaletteValues, RiffetRGBA>) -> UIColor {
        lock.lock()
        defer { lock.unlock() }
        if let hit = colors[role] { return hit }
        let color = UIColor { traits in
            self.lock.lock()
            let values = self.current
            self.lock.unlock()
            let rgba = (traits.userInterfaceStyle == .dark ? values.dark : values.light)[keyPath: role]
            return UIColor(red: CGFloat(rgba.red), green: CGFloat(rgba.green), blue: CGFloat(rgba.blue), alpha: CGFloat(rgba.alpha))
        }
        colors[role] = color
        return color
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette(values: RiffetThemeCatalog.all[0])
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// The palette's agent colour for a backend's mark; droid, traex and pi have no
/// role yet, so their marks keep the shipped brand colour.
func agentMarkColor(_ backend: String, _ palette: Palette) -> Color? {
    switch backend {
    case "cursor": palette.agentCursor
    case "codex": palette.agentCodex
    case "claude": palette.agentClaude
    case "dsh": palette.agentDsh
    default: nil
    }
}
