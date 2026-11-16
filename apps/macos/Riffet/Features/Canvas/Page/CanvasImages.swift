import AppKit
import ImageIO
import RiffetKit

/// Thumbnails for the canvas's cards (a prompt's attached images, an artifact shelf), by the key the layout names them with.
/// Registered with the request that fetches them when a layout arrives, loaded a few at a time, read by the painters from any
/// thread. An artifact that will not load (twice) is reported so it leaves its track.
final class CanvasImages: @unchecked Sendable {
    private let lock = NSLock()
    private let cache = NSCache<NSString, Box>()
    private var requests: [String: URLRequest] = [:]
    private var waiting: [String] = []
    private var loading: Set<String> = []
    private var attempts: [String: Int] = [:]
    private var running = 0
    private var landed = false
    private var stopped = false
    private var fetches: [String: Task<Void, Never>] = [:]

    /// Some thumbnails arrived since the last call: cards that show them should be drawn again. Called on the main actor.
    @MainActor var onLoaded: (() -> Void)?
    /// An image would not load: its key, for the artifacts the layout may then drop.
    @MainActor var onBroken: ((String) -> Void)?

    private final class Box { let image: CGImage; init(_ image: CGImage) { self.image = image } }

    private let registryName = "canvas.images.\(UUID().uuidString)"

    init() {
        // A quarter of the decoded-image budget: several canvases and the transcript share it.
        let limit = BudgetsKt.IMAGE_CACHE_MAC_DECODED_BYTES / 4
        cache.totalCostLimit = Int(limit)
        // Cards still on the canvas need their thumbnails back, so a purge reloads what was loaded.
        CacheRegistry.shared.register(registryName, limit: limit) { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.reloadLoaded() } }
        }
    }

    /// Empties the cache and queues every thumbnail that was in it again; `onLoaded` redraws the cards as they land.
    @MainActor
    private func reloadLoaded() {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        let held = requests.keys.filter { cache.object(forKey: $0 as NSString) != nil }
        cache.removeAllObjects()
        for key in held where !loading.contains(key) && !waiting.contains(key) {
            attempts[key] = 0
            waiting.append(key)
        }
        lock.unlock()
        pump()
    }

    deinit { CacheRegistry.shared.unregister(registryName) }

    /// The thumbnail if it has loaded; any thread.
    func image(_ key: String) -> CGImage? { cache.object(forKey: key as NSString)?.image }

    /// Makes [key] loadable by [request]; known keys keep what they have.
    @MainActor
    func register(_ key: String, request: URLRequest) {
        lock.lock()
        let isNew = requests[key] == nil
        if isNew {
            requests[key] = request
            waiting.append(key)
        }
        lock.unlock()
        if isNew { pump() }
    }

    @MainActor
    func removeAll() {
        lock.lock()
        requests.removeAll(); waiting.removeAll(); loading.removeAll(); attempts.removeAll()
        lock.unlock()
        cache.removeAllObjects()
    }

    /// Nothing loads, retries or reports after this: the canvas is gone.
    @MainActor
    func stop() {
        lock.lock()
        stopped = true
        fetches.values.forEach { $0.cancel() }
        fetches.removeAll()
        requests.removeAll(); waiting.removeAll(); loading.removeAll(); attempts.removeAll()
        lock.unlock()
        cache.removeAllObjects()
        onLoaded = nil; onBroken = nil
    }

    @MainActor
    private func retry(_ key: String) {
        lock.lock()
        guard !stopped, requests[key] != nil else { lock.unlock(); return }
        waiting.append(key)
        lock.unlock()
        pump()
    }

    @MainActor
    private func pump() {
        while true {
            lock.lock()
            // A key whose request is gone (after removeAll) is dropped, not left at the head.
            while let head = waiting.first, requests[head] == nil { waiting.removeFirst() }
            guard !stopped, running < 4, let key = waiting.first, let request = requests[key] else { lock.unlock(); return }
            waiting.removeFirst()
            running += 1
            loading.insert(key)
            fetches[key] = Task { [weak self] in
                let image = await Self.fetch(request)
                self?.finish(key, image)
            }
            lock.unlock()
        }
    }

    @MainActor
    private func finish(_ key: String, _ image: CGImage?) {
        lock.lock()
        fetches[key] = nil
        guard !stopped else { lock.unlock(); return }
        running -= 1
        loading.remove(key)
        let tries = (attempts[key] ?? 0) + 1
        attempts[key] = tries
        lock.unlock()
        if let image {
            cache.setObject(Box(image), forKey: key as NSString, cost: image.width * image.height * 4)
            if !landed {
                landed = true
                // One redraw for a burst of arrivals.
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(80))
                    self?.landed = false
                    self?.onLoaded?()
                }
            }
        } else if tries < 2 {
            // The file may be written a moment after the call that named it.
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(1500))
                guard let self else { return }
                self.retry(key)
            }
        } else {
            onBroken?(key)
        }
        pump()
    }

    private static func fetch(_ request: URLRequest) async -> CGImage? {
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return await Task.detached(priority: .utility) { () -> CGImage? in
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 512,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        }.value
    }
}
