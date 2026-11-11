import CryptoKit
import Foundation

/// The appearance catalog and its assets on disk, per server:
/// `~/Library/Application Support/Riffet/appearance/<server token>/catalog.json` and one file per
/// asset named by its content hash. A cached asset is hashed again before it is used the first time
/// in a run, so a file that was cut short or edited is discarded instead of registered or drawn.
///
/// Every call reads, hashes or writes files: `AppearanceStore` runs them on its own queue, never on
/// the main thread.
enum AppearanceCache {
    private static let directory = "Riffet/appearance"
    /// Hashes that matched their bytes in this run, by `<token>/<sha>`.
    private static let verified = Verified()

    private final class Verified: @unchecked Sendable {
        private let lock = NSLock()
        private var keys: Set<String> = []
        func contains(_ key: String) -> Bool { lock.lock(); defer { lock.unlock() }; return keys.contains(key) }
        func insert(_ key: String) { lock.lock(); keys.insert(key); lock.unlock() }
    }

    private static func folder(serverKey: String) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: directory, directoryHint: .isDirectory)
            .appending(path: ThemeLibraryCache.token(serverKey), directoryHint: .isDirectory)
    }

    /// Hashes come from the server; only a lowercase SHA-256 may become part of a path.
    static func isSHA256(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    private static func fileName(_ asset: PackAsset) -> String {
        let ext: String
        switch asset.type {
        case "font/woff2": ext = "woff2"
        case "image/png": ext = "png"
        case "image/jpeg": ext = "jpg"
        case "image/webp": ext = "webp"
        case "application/json": ext = "json"
        default: ext = "bin"
        }
        return "\(asset.sha256).\(ext)"
    }

    /// Larger than the server serves is not what the catalog described.
    static func isAcceptable(_ asset: PackAsset) -> Bool {
        isSHA256(asset.sha256) && asset.size > 0 && asset.size <= 4 * 1024 * 1024
    }

    // MARK: - Catalog

    static func loadCatalog(serverKey: String) -> PackCatalog? {
        guard let data = try? Data(contentsOf: folder(serverKey: serverKey).appending(path: "catalog.json")),
              let catalog = try? JSONDecoder().decode(PackCatalog.self, from: data),
              catalog.version == 1
        else { return nil }
        return catalog
    }

    static func saveCatalog(_ catalog: PackCatalog, serverKey: String) {
        let directory = folder(serverKey: serverKey)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(catalog).write(to: directory.appending(path: "catalog.json"), options: .atomic)
        } catch {
            // The server stays the source of truth; only the next cold start's first frame depends on this.
        }
    }

    // MARK: - Assets

    /// The cached file for [asset] when its bytes still hash to the catalog's value.
    static func file(for asset: PackAsset, serverKey: String) -> URL? {
        guard isAcceptable(asset) else { return nil }
        let url = folder(serverKey: serverKey).appending(path: fileName(asset))
        let key = ThemeLibraryCache.token(serverKey) + "/" + asset.sha256
        if verified.contains(key) { return FileManager.default.fileExists(atPath: url.path) ? url : nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard data.count == asset.size, sha256(data) == asset.sha256 else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        verified.insert(key)
        return url
    }

    /// Stores downloaded bytes when they are the asset the catalog named; returns whether they were.
    @discardableResult
    static func store(_ data: Data, for asset: PackAsset, serverKey: String) -> Bool {
        guard isAcceptable(asset), data.count == asset.size, sha256(data) == asset.sha256 else { return false }
        let directory = folder(serverKey: serverKey)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appending(path: fileName(asset)), options: .atomic)
        } catch {
            return false
        }
        verified.insert(ThemeLibraryCache.token(serverKey) + "/" + asset.sha256)
        return true
    }

    /// Drops every file the current catalog no longer names, which is how an updated package's old
    /// bytes leave the disk.
    static func prune(keeping catalog: PackCatalog, serverKey: String) {
        var assets: [PackAsset] = catalog.palettes.map { $0.asset }
        for font in catalog.fonts { assets += font.files.map { $0.asset } }
        assets += catalog.backgrounds.map { $0.asset }
        let keep = Set(assets.map { fileName($0) })
        let directory = folder(serverKey: serverKey)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where name != "catalog.json" && !keep.contains(name) {
            try? FileManager.default.removeItem(at: directory.appending(path: name))
        }
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
