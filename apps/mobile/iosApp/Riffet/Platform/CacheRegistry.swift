import Foundation
import RiffetKit
import UIKit

/// Where the app's caches register so a memory warning empties all of them (docs/guide/performance.md §3.1).
/// An `NSCache` cannot report what it holds, so entries carry a limit and a way to empty, not a size.
final class CacheRegistry: @unchecked Sendable {
    static let shared = CacheRegistry()

    /// The phone's byte budgets, from `packages/contracts/src/budgets.ts`.
    enum Budget {
        static let images = Int(BudgetsKt.IMAGE_CACHE_PHONE_DECODED_BYTES)
        static let text = Int(BudgetsKt.TEXT_CACHE_BYTES_PHONE)
        /// Shares of `text`. `MarkdownModel` takes half (a quarter for each of its two caches); these share the rest.
        static let toolPresentations = text / 4
        static let highlights = text * 3 / 16
        static let math = text / 16
    }

    /// Same shape as the Mac's `CacheRegistry` (`MarkdownModel.swift` is compiled into both apps).
    /// A memory warning on iPhone is already serious, so it empties every cache.
    private struct Entry { let limit: Int64; let purge: () -> Void }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    private init() {
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            self?.purgeAll()
        }
    }

    /// An `NSCache` capped at `bytes` of cost (and `count` objects when given), registered under `name`.
    static func cache<Value: AnyObject>(_ name: String, bytes: Int = 0, count: Int = 0) -> NSCache<NSString, Value> {
        let cache = NSCache<NSString, Value>()
        if bytes > 0 { cache.totalCostLimit = bytes }
        if count > 0 { cache.countLimit = count }
        shared.register(name, limit: Int64(bytes)) { cache.removeAllObjects() }
        return cache
    }

    /// Adds `name`, replacing an earlier cache with that name. `purge` runs on any thread.
    func register(_ name: String, limit: Int64, evictsOnWarning: Bool = true, purge: @escaping () -> Void) {
        lock.lock(); defer { lock.unlock() }
        entries[name] = Entry(limit: limit, purge: purge)
    }

    /// Names and limits, for the metrics report.
    func snapshot() -> [(name: String, limit: Int64)] {
        lock.lock(); defer { lock.unlock() }
        return entries.map { (name: $0.key, limit: $0.value.limit) }.sorted { $0.name < $1.name }
    }

    func purgeAll() {
        lock.lock(); let held = Array(entries.values); lock.unlock()
        held.forEach { $0.purge() }
    }
}
