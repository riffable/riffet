import Foundation

/// A few requests at a time (`useQueue` of the web view): a job with a key already waiting is not queued again; one asked for
/// while the same key runs is marked dirty and runs once more after it (its answer may predate the new request).
/// Nothing starts once the queue is cancelled.
@MainActor
final class CanvasQueue {
    private let concurrency: Int
    private var running = 0
    private var waiting: [(key: String?, job: @MainActor () async -> Void)] = []
    private var pending: Set<String> = []
    private var active: [String: @MainActor () async -> Void] = [:]
    private var dirty: [String: @MainActor () async -> Void] = [:]
    private var cancelled = false
    private var tasks: [UUID: Task<Void, Never>] = [:]

    init(concurrency: Int = 3) { self.concurrency = concurrency }

    func enqueue(key: String? = nil, _ job: @escaping @MainActor () async -> Void) {
        guard !cancelled else { return }
        if let key {
            if pending.contains(key) {
                // Waiting: it will see the newest state anyway. Running: go again afterwards.
                if active[key] != nil { dirty[key] = job }
                return
            }
            pending.insert(key)
        }
        waiting.append((key, job))
        drain()
    }

    func cancel() {
        cancelled = true
        waiting.removeAll(); dirty.removeAll()
        tasks.values.forEach { $0.cancel() }
    }

    private func drain() {
        while running < concurrency, !waiting.isEmpty, !cancelled {
            let next = waiting.removeFirst()
            running += 1
            if let key = next.key { active[key] = next.job }
            let id = UUID()
            tasks[id] = Task { [weak self] in
                if !Task.isCancelled { await next.job() }
                guard let self else { return }
                if let key = next.key {
                    active[key] = nil
                    pending.remove(key)
                    if let again = dirty.removeValue(forKey: key), !cancelled {
                        pending.insert(key)
                        waiting.append((key, again))
                    }
                }
                running -= 1
                tasks[id] = nil
                drain()
            }
        }
    }
}
