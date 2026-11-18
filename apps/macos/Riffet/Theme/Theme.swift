import AppKit
import CoreText
import SwiftUI
import RiffetKit

/// One pickable theme: a built-in from the stylesheet, or one shared through the theme library.
///
/// [revision] identifies the *contents* of the palette rather than its id. Built-ins never change;
/// custom themes all share the library revision, so editing one invalidates every custom palette.
/// Anything that caches a resolved colour must key on it as well as on [id].
struct ThemeEntry: Identifiable, Sendable {
    let id: String
    let name: String
    let summary: String
    let values: RiffetThemeValues
    let revision: String
    let syntax: RiffetCodeThemeValues?

    init(id: String, name: String, summary: String, values: RiffetThemeValues, revision: String, syntax: RiffetCodeThemeValues? = nil) {
        self.id = id
        self.name = name
        self.summary = summary
        self.values = values
        self.revision = revision
        self.syntax = syntax
    }

    var ansi: RiffetAnsiValues { values.ansi }
}

/// The selected theme. Light or dark follows the system appearance; the theme picks the palette,
/// exactly as `data-theme` and `.dark` are independent on the web.
///
/// The catalogue is built-ins plus whatever the current server's library holds. A custom id is
/// kept as stored until a *successful* fetch proves the theme is gone: an unreachable server is not
/// evidence of a deletion, and rewriting the preference on a failed read would lose the choice.
@MainActor
@Observable
final class ThemeStore {
    static let shared = ThemeStore()

    enum SyncState: Equatable {
        case idle
        case syncing
        case ready
        case failed(String)
    }

    private static let key = "riffet.theme-id"
    private static let serverKeyKey = "riffet.theme-server"

    var themeId: String {
        didSet {
            UserDefaults.standard.set(themeId, forKey: Self.key)
            // Picking a built-in or custom theme means that theme shows: a plugin palette in effect steps aside.
            if !adjustingId { AppearanceStore.shared.useHostPalette() }
        }
    }

    /// Themes from the current server, in the library's order.
    private(set) var customThemes: [ThemeEntry] = []
    /// The raw library behind [customThemes]. The editor sends it back whole, so it needs the
    /// stored values rather than the parsed entries.
    private(set) var library = CachedThemeLibrary(version: 1, revision: "", themes: [])
    private(set) var libraryRevision = ""
    private(set) var syncState: SyncState = .idle

    var catalog: [ThemeEntry] { Self.builtins + customThemes }
    /// What a theme menu lists: built-in, custom, then the plugins' palettes.
    var choices: [ThemeEntry] { catalog + AppearanceStore.shared.paletteChoices.map(\.entry) }

    /// A pick from [choices]. A plugin palette is the device's appearance choice and leaves [themeId] alone.
    func choose(_ entry: ThemeEntry) {
        if let plugin = AppearanceStore.shared.paletteChoices.first(where: { $0.entry.id == entry.id }) {
            AppearanceStore.shared.selectPalette(plugin.id)
        } else {
            themeId = entry.id
        }
    }
    /// A plugin palette in effect wins over the stored theme, which it never overwrites.
    var entry: ThemeEntry { AppearanceStore.shared.paletteEntry ?? catalog.first { $0.id == themeId } ?? Self.builtins[0] }
    var palette: Palette { Palette(values: entry.values, revision: entry.revision) }
    /// The revision of the palette currently on screen; caches and redraw keys include it.
    var revision: String { entry.revision }
    /// Resolves the active code syntax theme: an explicit built-in or custom theme, or `auto`
    /// falling back to the active UI theme's custom syntax (or mapped built-in syntax).
    var codeTheme: RiffetCodeThemeValues {
        resolveCodeTheme(selection: DisplayPreferences.shared.codeTheme)
    }

    /// Revision key for the active code syntax theme so editing a custom theme's syntax invalidates caches.
    var codeThemeRevision: String {
        resolveCodeThemeRevision(selection: DisplayPreferences.shared.codeTheme)
    }

    func resolveCodeThemeRevision(selection: String) -> String {
        if selection.hasPrefix("custom-"), let custom = customThemes.first(where: { $0.id == selection }), custom.syntax != nil {
            return custom.revision
        }
        if selection != "auto", RiffetCodeThemeCatalog.all.contains(where: { $0.id == selection }) {
            return "builtin"
        }
        return entry.syntax != nil ? entry.revision : "builtin"
    }

    func resolveCodeTheme(selection: String) -> RiffetCodeThemeValues {
        if selection.hasPrefix("custom-"), let custom = customThemes.first(where: { $0.id == selection }), let syntax = custom.syntax {
            return syntax
        }
        if selection != "auto", RiffetCodeThemeCatalog.all.contains(where: { $0.id == selection }) {
            return RiffetCodeThemeCatalog.resolve(selection: selection, uiThemeId: entry.id)
        }
        if let syntax = entry.syntax {
            return syntax
        }
        return RiffetCodeThemeCatalog.resolve(selection: "auto", uiThemeId: entry.id)
    }

    @ObservationIgnored private var generation = 0
    /// True while the store itself corrects [themeId], which is not the reader picking a theme.
    @ObservationIgnored private var adjustingId = false
    @ObservationIgnored private var attachedServer: String?
    @ObservationIgnored private var api: RiffetApi?

    private init() {
        let stored = UserDefaults.standard.string(forKey: Self.key)
        themeId = Self.migrated(stored) ?? Self.builtins[0].id
        // Write the current id back, so the old name does not linger in the defaults.
        if stored != nil, stored != themeId { UserDefaults.standard.set(themeId, forKey: Self.key) }
        if let server = UserDefaults.standard.string(forKey: Self.serverKeyKey),
           let cached = ThemeLibraryCache.load(serverKey: server) {
            adopt(cached, confirmed: false)
        }
    }

    /// Ids from before a theme was renamed keep the reader's choice; unknown ids fall back later.
    private static func migrated(_ id: String?) -> String? {
        id == "claude" ? "kiln" : id
    }

    /// Points the store at one server. The cache is read synchronously so a stored custom theme is
    /// painted in the first frame; the fetch that follows only corrects it.
    func attach(api: RiffetApi, serverKey: String) {
        generation += 1
        let generation = self.generation
        UserDefaults.standard.set(serverKey, forKey: Self.serverKeyKey)
        if let cached = ThemeLibraryCache.load(serverKey: serverKey) {
            adopt(cached, confirmed: false)
        } else if attachedServer != serverKey {
            // Another server's themes must not stay selectable — the same id can mean another palette.
            customThemes = []
            library = CachedThemeLibrary(version: 1, revision: "", themes: [])
            libraryRevision = ""
        }
        attachedServer = serverKey
        self.api = api
        Task { await sync(api: api, serverKey: serverKey, generation: generation) }
    }

    /// Re-reads the library while the same server stays attached; the editor and 外观与显示 use it
    /// so a theme changed on another device appears without relaunching the app.
    func refresh() {
        guard syncState != .syncing else { return }
        Task { await reload() }
    }

    /// An explicit reload the editor can await — after a conflict it must know the revision the
    /// server actually holds before offering to overwrite.
    func reload() async {
        guard let api, let serverKey = attachedServer else { return }
        generation += 1
        let generation = self.generation
        await sync(api: api, serverKey: serverKey, generation: generation)
    }

    /// True when there is a server to save to. The editor hides its controls otherwise.
    var canEditThemes: Bool { api != nil }

    /// Replaces the whole library. Throws `RiffetHttpException` with status 409 when another device
    /// saved first; the editor turns that into a reload-or-overwrite choice.
    func replaceLibrary(_ themes: [CachedCustomTheme], expectedRevision: String? = nil) async throws {
        guard let api else { throw SettingsFailure(String(localized: "尚未连接服务器")) }
        // A sync that started before this save may answer with the pre-save library; discarding it
        // keeps the saved state from being replaced by a stale read.
        generation += 1
        let generation = self.generation
        let body = ThemeLibraryUpdate(
            expectedRevision: expectedRevision ?? library.revision,
            themes: themes.map { $0.wire() }
        )
        let answer = try await api.updateThemes(body: body)
        // The editor may have closed while the request was in flight; a late answer must not
        // overwrite the state of a different server.
        guard generation == self.generation else { return }
        guard let next = CachedThemeLibrary(answer) else {
            throw SettingsFailure(String(localized: "服务器返回的主题库版本不受支持"))
        }
        adopt(next, confirmed: true)
        syncState = .ready
        if let serverKey = attachedServer {
            Task.detached(priority: .utility) { ThemeLibraryCache.save(next, serverKey: serverKey) }
        }
    }

    /// The server is gone. The palette stays painted from the cache, but nothing may answer for it.
    func detach() {
        generation += 1
        attachedServer = nil
        api = nil
        syncState = .idle
    }

    private func sync(api: RiffetApi, serverKey: String, generation: Int) async {
        syncState = .syncing
        do {
            let library = try await api.themes()
            guard generation == self.generation else { return abandonStaleSync() }
            guard let cached = CachedThemeLibrary(library) else {
                syncState = .failed(String(localized: "服务器主题库版本不受支持"))
                return
            }
            adopt(cached, confirmed: true)
            syncState = .ready
            Task.detached(priority: .utility) { ThemeLibraryCache.save(cached, serverKey: serverKey) }
        } catch {
            guard generation == self.generation else { return abandonStaleSync() }
            syncState = .failed(error.riffetMessage)
        }
    }

    /// A stale answer is dropped, but it still has to end the `.syncing` state it started: otherwise
    /// a later `refresh()` would wait forever for a request whose result no longer applies.
    private func abandonStaleSync() {
        syncState = library.revision.isEmpty ? .idle : .ready
    }

    /// Installs a library. Only `confirmed` (a server answer) may retire a stored custom id; a cache
    /// read happens before the fetch and must keep showing a theme it cannot disprove.
    private func adopt(_ next: CachedThemeLibrary, confirmed: Bool) {
        // A revision names the library's contents. Re-installing the one already held would still
        // hand every window a new catalogue and redraw it.
        if next.revision.isEmpty || next.revision != library.revision || next.version != library.version {
            library = next
            libraryRevision = next.revision
            customThemes = next.themes.compactMap { $0.entry(revision: next.revision) }
        }
        if confirmed, themeId.hasPrefix("custom-"), !catalog.contains(where: { $0.id == themeId }) {
            adjustingId = true
            themeId = Self.builtins[0].id
            adjustingId = false
        }
    }

    // MARK: - Built-in catalogue

    /// Names and one-line descriptions live together so the pickers and 外观与显示 cannot drift.
    private static let builtinMetadata: [String: (name: String, summary: String)] = [
        "riffet": ("Riffet", String(localized: "默认外观：冷中性灰阶配蓝色强调。")),
        "solarized": ("Solarized", String(localized: "奶油纸底与墨绿黑，为长时间阅读设计。")),
        "catppuccin": ("Catppuccin", String(localized: "柔和的低对比紫调，适合暗光环境。")),
        "rose-pine": ("Rosé Pine", String(localized: "暖紫玫瑰调，低饱和的纸感配色。")),
        "everforest": ("Everforest", String(localized: "低饱和绿色系，暖而沉稳。")),
        "kiln": ("Kiln", String(localized: "暖象牙底与黏土橙。")),
        "ink": ("Ink", String(localized: "中性纸底与墨水蓝。")),
        "sepia": ("Sepia", String(localized: "旧书纸底与牛血红。")),
        "moss": ("Moss", String(localized: "微绿灰纸底与橄榄苔绿。")),
        "slate": ("Slate", String(localized: "微冷纸底与石板蓝。")),
        "pencil": ("Pencil", String(localized: "纯中性灰阶，不用彩色强调。")),
        "celadon": ("Celadon", String(localized: "青瓷纸底与深青。")),
    ]

    static let builtins: [ThemeEntry] = RiffetThemeCatalog.all.map { values in
        let meta = builtinMetadata[values.id] ?? (values.id, "")
        return ThemeEntry(id: values.id, name: meta.name, summary: meta.summary, values: values, revision: "builtin")
    }
}

@dynamicMemberLookup
struct Palette: Sendable {
    let values: RiffetThemeValues
    /// `builtin` for the stylesheet's themes, or the library revision a custom palette was read at.
    let revision: String

    subscript(dynamicMember role: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable) -> Color {
        PaletteCache.shared.color(values, revision, role)
    }

    /// What our own drawing marks with: a checked box, a running step, a chosen card, a link, a
    /// chart's single series. The theme's accent in the drawn styles; ink in the native one, where
    /// the accent belongs to the system's own controls (docs/design/macos-native.md 1.1).
    @MainActor static var markRole: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable {
        DisplayPreferences.shared.style.backend == .native ? \.fg2 : \.accent
    }

    /// The fill behind a marked thing: the accent's wash, or the muted fill in the native style.
    @MainActor static var markSoftRole: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable {
        DisplayPreferences.shared.style.backend == .native ? \.bgMuted : \.accentSoft
    }

    @MainActor var mark: Color { self[dynamicMember: Palette.markRole] }
    @MainActor var markSoft: Color { self[dynamicMember: Palette.markSoftRole] }

    /// One dynamic colour per theme, role and opacity for the life of the app: the same role is the
    /// same object, so views comparing colours see no change where there is none. The revision is
    /// part of the key because editing a custom theme keeps its id but changes every colour.
    func nsColor(_ role: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable, opacity: CGFloat = 1) -> NSColor {
        PaletteCache.shared.nsColor(values, revision, role, opacity)
    }

    /// A syntax highlighting colour mixed toward the active UI theme's `fg` / `fg3` so code sits on any paper.
    func codeNSColor(_ role: KeyPath<RiffetCodePaletteValues, RiffetRGBA> & Sendable, codeTheme: RiffetCodeThemeValues, codeRevision: String = "builtin") -> NSColor {
        PaletteCache.shared.codeNSColor(values, revision, codeTheme, codeRevision, role)
    }
}

private final class PaletteCache: @unchecked Sendable {
    static let shared = PaletteCache()

    private struct Key: Hashable {
        let theme: String
        let revision: String
        let role: AnyKeyPath
        let opacity: CGFloat
    }

    private struct CodeKey: Hashable {
        let theme: String
        let revision: String
        let codeTheme: String
        let codeRevision: String
        let role: AnyKeyPath
    }

    private let lock = NSLock()
    private var nsColors: [Key: NSColor] = [:]
    private var codeNSColors: [CodeKey: NSColor] = [:]
    private var colors: [Key: Color] = [:]

    func nsColor(_ values: RiffetThemeValues, _ revision: String, _ role: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable, _ opacity: CGFloat) -> NSColor {
        let key = Key(theme: values.id, revision: revision, role: role, opacity: opacity)
        lock.lock()
        defer { lock.unlock() }
        if let hit = nsColors[key] { return hit }
        let color = NSColor(name: nil) { appearance in
            let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let rgba = (dark ? values.dark : values.light)[keyPath: role]
            return NSColor(srgbRed: rgba.red, green: rgba.green, blue: rgba.blue, alpha: rgba.alpha * opacity)
        }
        nsColors[key] = color
        return color
    }

    func codeNSColor(_ values: RiffetThemeValues, _ revision: String, _ codeTheme: RiffetCodeThemeValues, _ codeRevision: String, _ role: KeyPath<RiffetCodePaletteValues, RiffetRGBA> & Sendable) -> NSColor {
        let key = CodeKey(theme: values.id, revision: revision, codeTheme: codeTheme.id, codeRevision: codeRevision, role: role)
        lock.lock()
        defer { lock.unlock() }
        if let hit = codeNSColors[key] { return hit }
        let isComment = role == \RiffetCodePaletteValues.comment
        let color = NSColor(name: nil) { appearance in
            let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let ui = dark ? values.dark : values.light
            let raw = (dark ? codeTheme.dark : codeTheme.light)[keyPath: role]
            let mixed = isComment
                ? raw.mixed(with: ui.fg3, dark ? 0.15 : 0.20)
                : raw.mixed(with: ui.fg, dark ? 0.10 : 0.12)
            return NSColor(srgbRed: mixed.red, green: mixed.green, blue: mixed.blue, alpha: mixed.alpha)
        }
        codeNSColors[key] = color
        return color
    }

    func color(_ values: RiffetThemeValues, _ revision: String, _ role: KeyPath<RiffetPaletteValues, RiffetRGBA> & Sendable) -> Color {
        let key = Key(theme: values.id, revision: revision, role: role, opacity: 1)
        lock.lock()
        if let hit = colors[key] {
            lock.unlock()
            return hit
        }
        lock.unlock()
        let color = Color(nsColor: nsColor(values, revision, role, 1))
        lock.lock()
        colors[key] = color
        lock.unlock()
        return color
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette(values: RiffetThemeCatalog.all[0], revision: "builtin")
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

@MainActor
enum RiffetFont {
    static func text(_ style: (size: CGFloat, lineHeight: CGFloat), weight: Font.Weight = .regular) -> Font {
        .riffet(size: S(style.size), weight: weight)
    }

    static func mono(_ size: CGFloat = RiffetTextSize.xs.size) -> Font {
        .riffet(size: S(size), design: .monospaced)
    }

    static var body: Font { text(RiffetTextSize.base) }
    static var label: Font { text(RiffetTextSize.sm) }
    static var caption: Font { text(RiffetTextSize.xs) }
    static var code: Font { mono(12.5) }
    /// A first-launch page's title: the largest step of the text scale, as the new-session greeting.
    static var pageTitle: Font { text(RiffetTextSize.x2xl, weight: .medium) }
    /// The brand name on the welcome page, the one place `.semibold` is for.
    static var brandTitle: Font { .riffet(size: S(32), weight: .semibold) } // design-rules: allow the wordmark is drawn larger than any text step
    static var codeSmall: Font { mono(RiffetTextSize.xs.size) }
}

extension View {
    /// Line spacing that reproduces the web's line-height for a given text size.
    func riffetLineHeight(_ style: (size: CGFloat, lineHeight: CGFloat)) -> some View {
        lineSpacing(max(0, style.lineHeight - style.size * 1.2))
    }
}

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

    /// `#rrggbb`, or `#rrggbbaa` when translucent — the form the wire and the editor share.
    var hex: String {
        let channel = { (value: Double) in String(format: "%02x", Int((value * 255).rounded())) }
        let rgb = "#" + channel(red) + channel(green) + channel(blue)
        return alpha >= 1 ? rgb : rgb + channel(alpha)
    }

    /// This colour moved `amount` of the way towards `other`, alpha included.
    func mixed(with other: RiffetRGBA, _ amount: Double) -> RiffetRGBA {
        let lerp = { (a: Double, b: Double) in a + (b - a) * amount }
        return RiffetRGBA(lerp(red, other.red), lerp(green, other.green), lerp(blue, other.blue), lerp(alpha, other.alpha))
    }
}
