import AppKit
import CoreText
import Foundation
import Observation
import SwiftUI
import RiffetKit

/// A font a plugin contributed that is registered with this process and has its files on disk.
struct ResolvedFont: Sendable, Equatable {
    let id: String
    /// The family name the font files carry; text asks for it by family and weight.
    let family: String
    /// Changes when the font's bytes do, so a redraw key built from it follows a package update.
    let identity: String

    /// The font at [size] and [weight], or nil when the system cannot match the family.
    nonisolated func nsFont(size: CGFloat, weight: NSFont.Weight = .regular, italic: Bool = false) -> NSFont? {
        ResolvedFontCache.shared.font(family: family, size: size, weight: weight, italic: italic)
    }
}

/// `NSFont` lookups by family are slower than the system's own, and a transcript asks for the same
/// few faces thousands of times.
private final class ResolvedFontCache: @unchecked Sendable {
    static let shared = ResolvedFontCache()
    private let lock = NSLock()
    private var fonts: [String: NSFont] = [:]

    /// Faces were registered or unregistered: a font looked up before no longer stands for the family.
    func removeAll() {
        lock.lock()
        fonts.removeAll()
        lock.unlock()
    }

    func font(family: String, size: CGFloat, weight: NSFont.Weight, italic: Bool) -> NSFont? {
        let key = "\(family)|\(size)|\(weight.rawValue)|\(italic)"
        lock.lock()
        if let hit = fonts[key] {
            lock.unlock()
            return hit
        }
        lock.unlock()
        var descriptor = NSFontDescriptor(fontAttributes: [.family: family, .traits: [NSFontDescriptor.TraitKey.weight: weight.rawValue]])
        if italic { descriptor = descriptor.withSymbolicTraits(.italic) }
        guard let font = NSFont(descriptor: descriptor, size: size) else { return nil }
        lock.lock()
        if fonts.count >= 256 { fonts.removeAll() }
        fonts[key] = font
        lock.unlock()
        return font
    }
}

/// The two plugin fonts in effect. [key] is part of every redraw key that depends on text metrics.
struct AppearanceFonts: Sendable, Equatable {
    var ui: ResolvedFont?
    var mono: ResolvedFont?

    static let none = AppearanceFonts(ui: nil, mono: nil)

    var key: String { "\(ui?.identity ?? "-")|\(mono?.identity ?? "-")" }

    /// The snapshot code off the main thread reads (a code view prepares its text on a queue).
    nonisolated static var current: AppearanceFonts { shared.value }
    fileprivate static let shared = Shared()

    fileprivate final class Shared: @unchecked Sendable {
        private let lock = NSLock()
        private var stored = AppearanceFonts.none
        var value: AppearanceFonts {
            get { lock.lock(); defer { lock.unlock() }; return stored }
            set { lock.lock(); stored = newValue; lock.unlock() }
        }
    }
}

/// The background image in effect, ready to draw.
struct BackgroundLayer {
    let id: String
    let image: NSImage
    let opacity: Double
    let tile: Bool
}

/// Everything the store does with files, off the main thread: reading and hashing the cache,
/// registering fonts, decoding the background. One serial queue, so jobs run in the order the main
/// thread issued them (a prune never overtakes the job that unregisters the files it removes).
private final class AppearanceDisk: @unchecked Sendable {
    static let shared = AppearanceDisk()
    /// Matches the web's 256 KB palette limit; a palette is a few KB.
    private static let paletteLimit = 256 * 1024

    private let queue = DispatchQueue(label: "riffet.appearance", qos: .userInitiated)
    // Confined to the queue.
    private var registered: [String: URL] = [:]
    private var paletteMemo: [String: ThemeEntry] = [:]
    private var imageMemo: [String: NSImage] = [:]

    struct Prepared {
        var palettes: [String: ThemeEntry] = [:]
        var ui: ResolvedFont?
        var mono: ResolvedFont?
        var background: BackgroundLayer?
    }

    func enqueue(_ work: @escaping @Sendable () -> Void) { queue.async(execute: work) }

    func run<T>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in queue.async { continuation.resume(returning: work()) } }
    }

    /// Brings what is on disk in line with the catalog and the selection: palettes parsed, the
    /// fonts in effect registered (and the ones no longer in effect unregistered), the background decoded.
    func prepare(catalog: PackCatalog, effective: EffectiveAppearance, serverKey: String, titles: [String: String]) -> Prepared {
        var result = Prepared()
        var used: [String: ThemeEntry] = [:]
        for palette in catalog.palettes {
            let title = titles[palette.plugin] ?? palette.plugin
            let memo = "\(palette.asset.sha256)|\(palette.title.localizedTitle)|\(title)"
            if let entry = paletteMemo[memo] ?? loadPalette(palette, serverKey: serverKey, title: title) {
                result.palettes[palette.id] = entry
                used[memo] = entry
            }
        }
        paletteMemo = used

        let ui = effective.uiFont.flatMap { fontFiles($0, serverKey: serverKey) }
        let mono = effective.monoFont.flatMap { fontFiles($0, serverKey: serverKey) }
        syncRegistration(needed: (ui?.files ?? []) + (mono?.files ?? []))
        result.ui = ui?.font
        result.mono = mono?.font

        if let item = effective.background, let layer = backgroundLayer(for: item, serverKey: serverKey) {
            result.background = layer
            imageMemo = imageMemo.filter { $0.key == item.asset.sha256 }
        } else {
            imageMemo = [:]
        }
        return result
    }

    /// A palette's JSON is a custom theme; it is painted under an id made from its bytes, so the
    /// stored theme choice and the user's own library are never involved.
    private func loadPalette(_ palette: PackPalette, serverKey: String, title: String) -> ThemeEntry? {
        let name = palette.title.localizedTitle
        guard palette.asset.size <= Self.paletteLimit,
              let file = AppearanceCache.file(for: palette.asset, serverKey: serverKey),
              let data = try? Data(contentsOf: file),
              var theme = try? JSONDecoder().decode(CachedCustomTheme.self, from: data)
        else { return nil }
        theme.id = "plugin-" + String(palette.asset.sha256.prefix(16))
        theme.name = name.isEmpty ? palette.id : name
        theme.summary = title
        return theme.entry(revision: palette.asset.sha256)
    }

    private func fontFiles(_ font: PackFont, serverKey: String) -> (font: ResolvedFont, files: [(String, URL)])? {
        var files: [(String, URL)] = []
        for file in font.files {
            guard let url = AppearanceCache.file(for: file.asset, serverKey: serverKey) else { return nil }
            files.append((file.asset.sha256, url))
        }
        guard !files.isEmpty else { return nil }
        let resolved = ResolvedFont(id: font.id, family: font.family, identity: font.files.map { $0.asset.sha256.prefix(12) }.joined(separator: "+"))
        return (resolved, files)
    }

    /// Makes the fonts registered with this process exactly the files in [needed]. Files that fell out
    /// (a package update, another font picked) go first: a second revision of one family repeats the
    /// first's face names, and CoreText would keep the old faces and refuse the new ones.
    private func syncRegistration(needed: [(String, URL)]) {
        let wanted = Set(needed.map(\.0))
        let stale = registered.filter { !wanted.contains($0.key) }
        let fresh = needed.filter { registered[$0.0] == nil }
        var seen: Set<String> = []
        let freshUnique = fresh.filter { seen.insert($0.0).inserted }
        guard !stale.isEmpty || !freshUnique.isEmpty else { return }
        if !stale.isEmpty {
            var errors: Unmanaged<CFArray>?
            _ = CTFontManagerUnregisterFontsForURLs(Array(stale.values) as CFArray, .process, &errors)
            errors?.release()
            for key in stale.keys { registered[key] = nil }
        }
        if !freshUnique.isEmpty {
            var errors: Unmanaged<CFArray>?
            // A second subset of one family repeats the first's face names; CoreText reports that per
            // file and keeps the first, which is the outcome wanted.
            _ = CTFontManagerRegisterFontsForURLs(freshUnique.map { $0.1 } as CFArray, .process, &errors)
            errors?.release()
            for (sha, url) in freshUnique { registered[sha] = url }
        }
        ResolvedFontCache.shared.removeAll()
        FontMemo.shared.removeAll()
    }

    private func backgroundLayer(for item: PackBackground, serverKey: String) -> BackgroundLayer? {
        guard let file = AppearanceCache.file(for: item.asset, serverKey: serverKey) else { return nil }
        let image: NSImage
        if let hit = imageMemo[item.asset.sha256] {
            image = hit
        } else if let loaded = NSImage(contentsOf: file) {
            // Decoded here rather than on the first draw.
            _ = loaded.cgImage(forProposedRect: nil, context: nil, hints: nil)
            imageMemo[item.asset.sha256] = loaded
            image = loaded
        } else {
            return nil
        }
        return BackgroundLayer(id: "\(item.id)|\(item.asset.sha256)|\(item.opacity)|\(item.fit)", image: image, opacity: min(max(item.opacity, 0), 1), tile: item.fit == "tile")
    }
}

/// What plugins contribute to appearance on this Mac, and which of it this Mac shows.
///
/// The catalog is the current server's: cached per server and read from disk off the main thread,
/// corrected by a fetch behind it. The selection is this device's alone and per server, kept in
/// `UserDefaults`; it never touches `riffet.theme-id`, so the built-in or custom theme the reader
/// chose is what shows whenever no plugin palette is in effect. A fetch that fails keeps what was
/// cached, and a stored choice naming something the catalog no longer has stays stored.
///
/// Disk, hashing and font registration happen on `AppearanceDisk`'s queue; results are applied here
/// only if no newer job was issued meanwhile, so the main thread never waits on a file.
@MainActor
@Observable
final class AppearanceStore {
    static let shared = AppearanceStore()

    enum SyncState: Equatable {
        case idle
        case syncing
        case ready
        case failed(String)
    }

    /// Before the choice was kept per server, one value stood for whichever server was current.
    private static let legacySelectionKey = "riffet.appearance-selection"
    private static let serverKeyKey = "riffet.appearance-server"

    private static func selectionKey(_ serverKey: String) -> String { "riffet.appearance-selection|\(serverKey)" }

    /// The server's stored choice. The first server to ask inherits a legacy global value, once.
    private static func storedSelection(serverKey: String) -> AppearanceSelection {
        let defaults = UserDefaults.standard
        let key = selectionKey(serverKey)
        if let legacy = defaults.data(forKey: legacySelectionKey) {
            if defaults.data(forKey: key) == nil { defaults.set(legacy, forKey: key) }
            defaults.removeObject(forKey: legacySelectionKey)
        }
        return defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(AppearanceSelection.self, from: $0) } ?? AppearanceSelection()
    }

    private(set) var catalog = PackCatalog.empty
    private(set) var selection: AppearanceSelection
    private(set) var effective = EffectiveAppearance()
    /// Every plugin palette whose file is on disk, by contribution id, for the theme gallery.
    private(set) var paletteEntries: [String: ThemeEntry] = [:]
    private(set) var fonts = AppearanceFonts.none
    private(set) var backgroundLayer: BackgroundLayer?
    private(set) var syncState: SyncState = .idle

    /// The plugin palette in effect, ready to paint. `ThemeStore` consults it before the stored theme.
    var paletteEntry: ThemeEntry? { effective.palette.flatMap { paletteEntries[$0.id] } }

    /// The plugin palettes that can be painted, in the catalog's order, for a theme menu.
    var paletteChoices: [(id: String, entry: ThemeEntry)] {
        catalog.palettes.compactMap { palette in paletteEntries[palette.id].map { (palette.id, $0) } }
    }

    @ObservationIgnored private var serverKey: String?
    @ObservationIgnored private var attachedServer: String?
    @ObservationIgnored private var api: RiffetApi?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var prepareSerial = 0
    /// True once the server answered for this connection: a cache read that finishes later must not replace it.
    @ObservationIgnored private var fromServer = false
    @ObservationIgnored private var preparedTitles: [String: String] = [:]
    @ObservationIgnored private var downloading = false
    @ObservationIgnored private var rerun = false
    @ObservationIgnored private let disk = AppearanceDisk.shared

    private init() {
        selection = AppearanceSelection()
        if let server = UserDefaults.standard.string(forKey: Self.serverKeyKey) {
            serverKey = server
            selection = Self.storedSelection(serverKey: server)
            loadCache(serverKey: server)
        }
    }

    // MARK: - Server

    /// Points the store at one server. Its cache is read behind the first frame; the fetch that
    /// follows only corrects it.
    func attach(api: RiffetApi, serverKey: String) {
        generation += 1
        let generation = self.generation
        UserDefaults.standard.set(serverKey, forKey: Self.serverKeyKey)
        if self.serverKey != serverKey {
            // Another server's items must not stay selectable: the same id can mean other files there.
            self.serverKey = serverKey
            catalog = .empty
            fromServer = false
            selection = Self.storedSelection(serverKey: serverKey)
            if !paletteEntries.isEmpty { paletteEntries = [:] }
            if fonts != AppearanceFonts.none {
                fonts = AppearanceFonts.none
                AppearanceFonts.shared.value = AppearanceFonts.none
            }
            if backgroundLayer != nil { backgroundLayer = nil }
            prepare()
            loadCache(serverKey: serverKey)
        }
        attachedServer = serverKey
        self.api = api
        Task { await sync(api: api, serverKey: serverKey, generation: generation) }
    }

    /// Reads the catalog again while the same server stays attached: a plugin turned on or off, or
    /// the settings page opening.
    func refresh() {
        guard syncState != .syncing, let api, let serverKey = attachedServer else { return }
        generation += 1
        let generation = self.generation
        Task { await sync(api: api, serverKey: serverKey, generation: generation) }
    }

    /// The server is gone. What was painted stays painted from the cache.
    func detach() {
        generation += 1
        attachedServer = nil
        api = nil
        syncState = .idle
    }

    private func loadCache(serverKey: String) {
        disk.enqueue { [self] in
            let cached = AppearanceCache.loadCatalog(serverKey: serverKey)
            Task { @MainActor in
                guard let cached, self.serverKey == serverKey, !self.fromServer else { return }
                self.catalog = cached
                self.prepare()
            }
        }
    }

    private func sync(api: RiffetApi, serverKey: String, generation: Int) async {
        syncState = .syncing
        do {
            let wire = try await api.appearance()
            guard generation == self.generation else { return abandonStaleSync() }
            guard let next = PackCatalog(wire) else {
                syncState = .failed(String(localized: "服务器外观目录版本不受支持"))
                return
            }
            fromServer = true
            if next != catalog {
                catalog = next
                disk.enqueue { AppearanceCache.saveCatalog(next, serverKey: serverKey) }
                prepare()
            } else if pluginTitles() != preparedTitles {
                prepare()
            }
            syncState = .ready
            await downloadMissing()
            // After the jobs above, on the same queue: the files a job unregisters are still there when it runs.
            if self.serverKey == serverKey {
                let keep = catalog
                disk.enqueue { AppearanceCache.prune(keeping: keep, serverKey: serverKey) }
            }
        } catch {
            guard generation == self.generation else { return abandonStaleSync() }
            syncState = .failed(error.riffetMessage)
        }
    }

    private func abandonStaleSync() {
        syncState = catalog.revision.isEmpty ? .idle : .ready
    }

    // MARK: - Choosing

    /// Picking a preset applies it: the per-slot choices are cleared so it visibly takes effect.
    /// `nil` is the host default.
    func selectPreset(_ id: String?) {
        commit(AppearanceSelection(preset: id ?? AppearanceSelection.hostDefault))
    }

    func selectPalette(_ id: String) {
        var next = selection
        next.palette = id
        commit(next)
    }

    /// A built-in or custom theme was picked: the plugin palette stops showing, the theme choice itself is untouched.
    /// A stored palette or preset is released even while its plugin is off, so turning it back on does not repaint over this pick.
    func useHostPalette() {
        guard selection.palette != nil || selection.preset != nil else { return }
        var next = selection
        next.palette = AppearanceSelection.hostDefault
        commit(next)
    }

    func selectFont(role: String, id: String) {
        var next = selection
        if role == "ui" { next.uiFont = id } else { next.monoFont = id }
        commit(next)
    }

    func selectBackground(_ id: String) {
        var next = selection
        next.background = id
        commit(next)
    }

    private func commit(_ next: AppearanceSelection) {
        guard next != selection else { return }
        selection = next
        if let serverKey {
            let key = Self.selectionKey(serverKey)
            if next.isEmpty {
                UserDefaults.standard.removeObject(forKey: key)
            } else if let data = try? JSONEncoder().encode(next) {
                UserDefaults.standard.set(data, forKey: key)
            }
        }
        prepare()
        Task { await downloadMissing() }
    }

    // MARK: - Applying

    /// The name each plugin is shown under, by plugin id.
    private func pluginTitles() -> [String: String] {
        Dictionary(PluginsStore.shared.items.map { ($0.id, $0.displayTitle) }, uniquingKeysWith: { first, _ in first })
    }

    /// Brings what is shown in line with the catalog and the selection, using only what is on disk.
    /// Which items are in effect follows at once; the files behind them are read on the disk queue and applied when ready.
    private func prepare() {
        let next = catalog.resolve(selection)
        if next != effective { effective = next }
        guard let serverKey else { return }
        prepareSerial += 1
        let serial = prepareSerial
        let catalog = self.catalog
        let titles = pluginTitles()
        preparedTitles = titles
        disk.enqueue { [self] in
            let prepared = disk.prepare(catalog: catalog, effective: next, serverKey: serverKey, titles: titles)
            Task { @MainActor in self.apply(prepared, serial: serial) }
        }
    }

    private func apply(_ prepared: AppearanceDisk.Prepared, serial: Int) {
        guard serial == prepareSerial else { return }
        func identity(_ entries: [String: ThemeEntry]) -> [String: String] { entries.mapValues { "\($0.id)|\($0.name)|\($0.summary)" } }
        if identity(prepared.palettes) != identity(paletteEntries) { paletteEntries = prepared.palettes }

        // The system must know the family after registration; one that cannot read a file leaves it
        // unknown, and text keeps the default font.
        func known(_ font: ResolvedFont?) -> ResolvedFont? {
            font.flatMap { NSFontManager.shared.availableMembers(ofFontFamily: $0.family)?.isEmpty == false ? $0 : nil }
        }
        let resolved = AppearanceFonts(ui: known(prepared.ui), mono: known(prepared.mono))
        if resolved != fonts {
            fonts = resolved
            AppearanceFonts.shared.value = resolved
        }

        if prepared.background?.id != backgroundLayer?.id { backgroundLayer = prepared.background }
    }

    // MARK: - Downloads

    /// The assets the current state needs: every palette (a gallery shows them all), and the files
    /// of what is in effect.
    private func neededAssets() -> [PackAsset] {
        catalog.palettes.map(\.asset)
            + (effective.uiFont?.files.map(\.asset) ?? []) + (effective.monoFont?.files.map(\.asset) ?? [])
            + (effective.background.map { [$0.asset] } ?? [])
    }

    /// Keeps going while the same server stays attached: a refresh is not a reason to drop a download.
    private func downloadMissing() async {
        if downloading {
            rerun = true
            return
        }
        downloading = true
        defer { downloading = false }
        repeat {
            rerun = false
            guard let api, let serverKey = attachedServer else { return }
            let needed = neededAssets()
            let missing = await disk.run { needed.filter { AppearanceCache.isAcceptable($0) && AppearanceCache.file(for: $0, serverKey: serverKey) == nil } }
            var stored = false
            var seen: Set<String> = []
            for asset in missing where seen.insert(asset.sha256).inserted {
                guard attachedServer == serverKey else { return }
                guard let bytes = try? await api.appearanceAsset(url: asset.url, maxBytes: Int64(asset.size)) else { continue }
                guard attachedServer == serverKey else { return }
                if await disk.run({ AppearanceCache.store(dataFromByteArray(bytes: bytes), for: asset, serverKey: serverKey) }) { stored = true }
            }
            if stored { prepare() }
        } while rerun
    }
}
