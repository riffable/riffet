import Foundation
import RiffetKit

/// The shared custom-theme library on the Mac.
///
/// The wire format lives in Kotlin (`riffet.contracts.ThemeLibrary`) and is the only long-lived
/// contract. This file adds what Swift needs around it: a disk cache that can be read synchronously
/// so the first frame is painted before the network answers, and the conversion into the
/// `ThemeEntry` the views and the terminal already understand.
///
/// The cache is per server, because two servers can define different themes under the same id.
/// Its name is a stable hash of the server key, not the URL itself, so a path never has to carry
/// `:` or `/` and a renamed server does not leave files behind under a name nothing can address.

struct CachedThemePalette: Codable, Sendable {
    var light: [String: String]
    var dark: [String: String]
}

struct CachedThemeAnsi: Codable, Sendable {
    var light: [String]
    var dark: [String]
}

/// Opaque versioned JSON; the Kotlin contract validates and interprets its contents.
indirect enum CachedThemeDesign: Codable, Sendable {
    case object([String: CachedThemeDesign]), array([CachedThemeDesign]), text(String), number(Double), boolean(Bool), null
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .boolean(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .text(v) }
        else if let v = try? value.decode([String: CachedThemeDesign].self) { self = .object(v) }
        else { self = .array(try value.decode([CachedThemeDesign].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .text(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .boolean(let v): try value.encode(v)
        case .null: try value.encodeNil()
        }
    }
}

/// The canvas a palette was drawn from, as `packages/contracts/src/theme.ts` stores it.
struct CachedThemeSeed: Codable, Sendable, Equatable {
    struct Point: Codable, Sendable, Equatable {
        var hue: Double
        var radius: Double
    }

    var points: [Point]
    var softness: Double
}

/// One theme as stored on disk. Mirrors the wire keys (`description`, not `summary`) so the file
/// and the API document stay recognisably the same shape.
struct CachedCustomTheme: Codable, Sendable {
    var id: String
    var name: String
    var summary: String?
    var palette: CachedThemePalette
    var ansi: CachedThemeAnsi
    var design: CachedThemeDesign? = nil
    /// The editor canvas behind the palette. Kept so a save from here does not drop it for the web.
    var seed: CachedThemeSeed? = nil

    enum CodingKeys: String, CodingKey {
        case id, name, palette, ansi, design, seed
        case summary = "description"
    }

    init(id: String, name: String, summary: String?, palette: CachedThemePalette, ansi: CachedThemeAnsi, design: CachedThemeDesign? = nil, seed: CachedThemeSeed? = nil) {
        self.id = id
        self.name = name
        self.summary = summary
        self.palette = palette
        self.ansi = ansi
        self.design = design
        self.seed = seed
    }

    /// Converts a server answer. A theme whose id is not a legal custom id is dropped: it could not
    /// be selected through the editor either, and keeping it would only make the catalogue lie.
    init?(_ theme: CustomTheme) {
        guard ThemeLibraryRules.isValidID(theme.id) else { return nil }
        id = theme.id
        name = theme.name
        summary = theme.description_
        palette = CachedThemePalette(light: theme.palette.light, dark: theme.palette.dark)
        ansi = CachedThemeAnsi(light: theme.ansi.light, dark: theme.ansi.dark)
        if let value = theme.design {
            design = try? JSONDecoder().decode(CachedThemeDesign.self, from: Data(ThemeDesignCodec.shared.encode(value: value).utf8))
        }
        seed = theme.seed.map { value in
            CachedThemeSeed(points: value.points.map { .init(hue: $0.hue, radius: $0.radius) }, softness: value.softness)
        }
    }

    /// The wire shape, for sending the library back. The editor validates before it gets here, so
    /// this is a plain conversion rather than a second place that can reject a theme.
    func wire() -> CustomTheme {
        CustomTheme(
            id: id,
            name: name,
            description: summary,
            palette: ThemePalette(light: palette.light, dark: palette.dark),
            ansi: ThemeAnsi(light: ansi.light, dark: ansi.dark),
            design: design.flatMap { value in
                guard let bytes = try? JSONEncoder().encode(value), let text = String(data: bytes, encoding: .utf8) else { return nil }
                return try? ThemeDesignCodec.shared.decode(text: text)
            },
            seed: seed.map { value in
                ThemeSeed(points: value.points.map { ThemeSeedPoint(hue: $0.hue, radius: $0.radius) }, softness: value.softness)
            }
        )
    }

    /// The catalogue entry, or nil when a colour or an ANSI slot cannot be read. A partial palette
    /// is not paintable, so it is better to leave the theme out than to show half of it.
    func entry(revision: String) -> ThemeEntry? {
        guard let light = RiffetPaletteValues(roleValues: palette.light),
              let dark = RiffetPaletteValues(roleValues: palette.dark),
              let ansi = RiffetAnsiValues(light: ansi.light, dark: ansi.dark)
        else { return nil }
        return ThemeEntry(
            id: id,
            name: name.isEmpty ? id : name,
            summary: summary ?? String(localized: "自定义主题"),
            values: RiffetThemeValues(id: id, light: light, dark: dark, ansi: ansi),
            revision: revision
        )
    }
}

struct CachedThemeLibrary: Codable, Sendable {
    var version: Int
    var revision: String
    var themes: [CachedCustomTheme]

    init(version: Int, revision: String, themes: [CachedCustomTheme]) {
        self.version = version
        self.revision = revision
        self.themes = themes
    }

    /// A version this build does not understand is not adopted; the next successful fetch replaces it.
    init?(_ library: ThemeLibrary) {
        guard library.version == 1 else { return nil }
        version = 1
        revision = library.revision
        themes = library.themes.compactMap(CachedCustomTheme.init)
    }
}

enum ThemeLibraryRules {
    /// The same id shape the contract and the server enforce.
    static func isValidID(_ id: String) -> Bool {
        id.range(of: #"^custom-[a-z0-9-]{8,64}$"#, options: .regularExpression) != nil
    }
}

enum ThemeLibraryCache {
    private static let directory = "Riffet/themes"

    static func fileURL(serverKey: String) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: directory, directoryHint: .isDirectory)
            .appending(path: token(serverKey) + ".json")
    }

    /// Synchronous on purpose: called while the first window is being built, where an async read
    /// would paint the default palette and then jump. A missing or unreadable file is simply no
    /// cache — never an error the reader has to see.
    static func load(serverKey: String) -> CachedThemeLibrary? {
        guard let data = try? Data(contentsOf: fileURL(serverKey: serverKey)),
              let library = try? JSONDecoder().decode(CachedThemeLibrary.self, from: data),
              library.version == 1
        else { return nil }
        return library
    }

    static func save(_ library: CachedThemeLibrary, serverKey: String) {
        let url = fileURL(serverKey: serverKey)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(library)
            try data.write(to: url, options: .atomic)
        } catch {
            // The server remains the source of truth; a cache that cannot be written only costs
            // the next cold start its first-frame palette.
        }
    }

    /// FNV-1a, stable across launches (unlike `hashValue`), filesystem-safe for any URL.
    static func token(_ key: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in key.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
    }
}
