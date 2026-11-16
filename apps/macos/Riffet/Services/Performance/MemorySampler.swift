import Foundation

/// The app's memory footprint and its caches' sizes every few minutes, kept for the last hours in a
/// bounded ring (docs/guide/performance.md §4). `PerfMonitor.report` carries them.
@MainActor
final class MemorySampler {
    static let shared = MemorySampler()

    struct Sample {
        let at: Date
        let footprintBytes: Int64
        let caches: [CacheRegistry.Snapshot]

        var json: [String: Any] {
            [
                "at": ISO8601DateFormatter().string(from: at),
                "footprintBytes": footprintBytes,
                "caches": caches.map { cache -> [String: Any] in
                    var entry: [String: Any] = ["name": cache.name, "limit": cache.limit]
                    if let bytes = cache.bytes { entry["bytes"] = bytes }
                    return entry
                },
            ]
        }
    }

    private static let interval: TimeInterval = 300
    /// Six hours at one sample per interval.
    private static let capacity = 72
    private(set) var samples: [Sample] = []
    private var timer: Timer?

    func start() {
        guard timer == nil else { return }
        sample()
        let timer = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { _ = self?.sample() }
        }
        timer.tolerance = 30
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    @discardableResult
    func sample() -> Sample {
        let sample = Sample(at: Date(), footprintBytes: Self.footprint(), caches: CacheRegistry.shared.snapshot())
        samples.append(sample)
        if samples.count > Self.capacity { samples.removeFirst(samples.count - Self.capacity) }
        return sample
    }

    /// What Activity Monitor calls Memory: `phys_footprint` from `TASK_VM_INFO`.
    nonisolated static func footprint() -> Int64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Int64(info.phys_footprint) : 0
    }
}
