import Foundation
import RiffetKit

/// The Mac's copy of the plugin appearance catalog (`packages/contracts/src/appearance.ts`).
///
/// The wire format lives in Kotlin (`riffet.contracts.AppearanceCatalog`). These are plain Swift
/// values of the same shape so the catalog can be cached as JSON, compared and resolved without
/// carrying Kotlin objects around, the way `CachedThemeLibrary` does for custom themes.

struct PackAsset: Codable, Equatable, Sendable {
    var url: String
    var sha256: String
    var size: Int
    var type: String
}

struct PackPalette: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var plugin: String
    var title: [String: String]
    var asset: PackAsset
}

struct PackFontFile: Codable, Equatable, Sendable {
    var asset: PackAsset
    var weight: String?
    var style: String?
    var unicodeRange: String?
}

struct PackFont: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var plugin: String
    var title: [String: String]
    /// `ui` or `mono`.
    var role: String
    var family: String
    var fallback: [String]
    var files: [PackFontFile]
}

struct PackBackground: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var plugin: String
    var title: [String: String]
    var asset: PackAsset
    var areas: [String]
    var opacity: Double
    /// `cover` or `tile`.
    var fit: String
}

struct PackPreset: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var plugin: String
    var title: [String: String]
    var palette: String?
    var uiFont: String?
    var monoFont: String?
    var background: String?
}

struct PackCatalog: Codable, Equatable, Sendable {
    var version: Int
    var revision: String
    var palettes: [PackPalette]
    var fonts: [PackFont]
    var backgrounds: [PackBackground]
    var presets: [PackPreset]

    static let empty = PackCatalog(version: 1, revision: "", palettes: [], fonts: [], backgrounds: [], presets: [])

    var isEmpty: Bool { palettes.isEmpty && fonts.isEmpty && backgrounds.isEmpty && presets.isEmpty }

    /// A server answer. A version this build does not understand is not adopted.
    init?(_ catalog: AppearanceCatalog) {
        guard catalog.version == 1 else { return nil }
        func asset(_ value: AppearanceAsset) -> PackAsset {
            PackAsset(url: value.url, sha256: value.sha256, size: Int(value.size), type: value.type)
        }
        version = 1
        revision = catalog.revision
        palettes = catalog.palettes.map { PackPalette(id: $0.id, plugin: $0.plugin, title: $0.title, asset: asset($0.asset)) }
        fonts = catalog.fonts.map { font in
            PackFont(
                id: font.id, plugin: font.plugin, title: font.title, role: font.role, family: font.family, fallback: font.fallback,
                files: font.files.map {
                    PackFontFile(
                        asset: PackAsset(url: $0.url, sha256: $0.sha256, size: Int($0.size), type: $0.type),
                        weight: $0.weight, style: $0.style, unicodeRange: $0.unicodeRange
                    )
                }
            )
        }
        backgrounds = catalog.backgrounds.map {
            PackBackground(id: $0.id, plugin: $0.plugin, title: $0.title, asset: asset($0.asset), areas: $0.areas, opacity: $0.opacity, fit: $0.fit)
        }
        presets = catalog.presets.map {
            PackPreset(id: $0.id, plugin: $0.plugin, title: $0.title, palette: $0.palette, uiFont: $0.fonts?.ui, monoFont: $0.fonts?.mono, background: $0.background)
        }
    }

    init(version: Int, revision: String, palettes: [PackPalette], fonts: [PackFont], backgrounds: [PackBackground], presets: [PackPreset]) {
        self.version = version
        self.revision = revision
        self.palettes = palettes
        self.fonts = fonts
        self.backgrounds = backgrounds
        self.presets = presets
    }
}

/// What this device chose, per server-independent slot. Each field is a contribution id or
/// `AppearanceSelection.hostDefault`; the keys are the same as the web's `riffet.appearance.selection`.
struct AppearanceSelection: Codable, Equatable, Sendable {
    /// Stored when the reader wants the host's own look in a slot even though the preset names one.
    static let hostDefault = "default"

    var preset: String?
    var palette: String?
    var uiFont: String?
    var monoFont: String?
    var background: String?

    var isEmpty: Bool { preset == nil && palette == nil && uiFont == nil && monoFont == nil && background == nil }
}

/// The items actually in effect for the current selection and catalog.
struct EffectiveAppearance: Equatable, Sendable {
    var palette: PackPalette?
    var uiFont: PackFont?
    var monoFont: PackFont?
    var background: PackBackground?
}

extension PackCatalog {
    /// Host default, then the selected preset, then a per-slot choice. A choice naming a contribution
    /// this catalog does not have shows the host default and is left as stored, so turning the plugin
    /// back on restores it; plugin load order plays no part.
    func resolve(_ selection: AppearanceSelection) -> EffectiveAppearance {
        let preset = selection.preset.flatMap { chosen in presets.first { $0.id == chosen } }
        func pick<Item>(_ choice: String?, _ viaPreset: String?, _ find: (String) -> Item?) -> Item? {
            if let choice { return choice == AppearanceSelection.hostDefault ? nil : find(choice) }
            return viaPreset.flatMap(find)
        }
        return EffectiveAppearance(
            palette: pick(selection.palette, preset?.palette) { id in palettes.first { $0.id == id } },
            uiFont: pick(selection.uiFont, preset?.uiFont) { id in fonts.first { $0.id == id && $0.role == "ui" } },
            monoFont: pick(selection.monoFont, preset?.monoFont) { id in fonts.first { $0.id == id && $0.role == "mono" } },
            background: pick(selection.background, preset?.background) { id in backgrounds.first { $0.id == id && $0.areas.contains("workbench") } }
        )
    }
}

extension Dictionary where Key == String, Value == String {
    /// Display text for the current language: the exact tag, the same language, `zh-Hans`, `en`, then
    /// the first by tag (docs/PLUGIN_ARCHITECTURE.md).
    var localizedTitle: String {
        let language = Bundle.main.preferredLocalizations.first ?? "zh-Hans"
        let prefix = language.split(separator: "-").first.map(String.init)?.lowercased() ?? language.lowercased()
        let candidates = [
            first { $0.key.caseInsensitiveCompare(language) == .orderedSame }?.value,
            keys.sorted().first { $0.split(separator: "-").first?.lowercased() == prefix }.flatMap { self[$0] },
            self["zh-Hans"],
            self["en"],
            keys.sorted().first.flatMap { self[$0] },
        ]
        return candidates.compactMap { $0 }.first ?? ""
    }
}
