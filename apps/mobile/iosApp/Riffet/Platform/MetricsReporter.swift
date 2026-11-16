import Foundation
import RiffetKit

/// The app's footprint, Kotlin heap and caches for the service monitor every five minutes while in the
/// foreground (docs/guide/performance.md §4). Numbers and cache names only; a failed report is not retried.
@MainActor
final class MetricsReporter {
    static let shared = MetricsReporter()

    private static let interval: TimeInterval = 300
    private static let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    private var timer: Timer?

    func foreground(_ active: Bool) {
        timer?.invalidate()
        timer = nil
        guard active else { return }
        let timer = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.report() }
        }
        timer.tolerance = 30
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func report() {
        guard let api = AppModel.shared.host.api else { return }
        let body = ClientMetricsReport(
            clientId: "app",
            platform: "ios",
            appVersion: Self.appVersion,
            sample: ClientMetricsSample(
                at: 0,
                footprintBytes: KotlinLong(value: Self.footprint()),
                managedHeapBytes: KotlinHeapKt.kotlinHeapBytes(),
                streams: nil,
                hitches: nil,
                caches: CacheRegistry.shared.snapshot().map { ClientCacheSample(name: $0.name, bytes: nil, limitBytes: KotlinLong(value: $0.limit), count: nil) }
            )
        )
        Task { try? await api.reportClientMetrics(body: body) }
    }

    /// `phys_footprint` from `TASK_VM_INFO`, the figure jetsam judges the app by.
    private static func footprint() -> Int64 {
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
