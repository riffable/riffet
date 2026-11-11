import Foundation
import RiffetKit

/// The subscriptions one Swift model holds on Kotlin flows, cancelled together.
@MainActor
final class FlowSubscriptions {
    private var tasks: [Task<Void, Never>] = []

    /// Applies the current value of [flow] now and again whenever it moves on. An element only says
    /// that something changed: the value applied is always `flow.value`, so a delivery that waited
    /// in the async sequence can never put back an older value, and the first element (the value
    /// already applied) is not applied twice.
    func observe<T>(_ flow: SkieSwiftStateFlow<T>, _ apply: @escaping @MainActor (T) -> Void) {
        let initial = flow.value
        apply(initial)
        tasks.append(Task { @MainActor in
            var last = initial
            for await _ in flow {
                if Task.isCancelled { return }
                let value = flow.value
                if Self.identical(value, last) { continue }
                last = value
                apply(value)
            }
        })
    }

    func observe<T>(_ flow: SkieSwiftOptionalStateFlow<T>, _ apply: @escaping @MainActor (T?) -> Void) {
        let initial = flow.value
        apply(initial)
        tasks.append(Task { @MainActor in
            var last = initial
            for await _ in flow {
                if Task.isCancelled { return }
                let value = flow.value
                if Self.identical(value, last) { continue }
                last = value
                apply(value)
            }
        })
    }

    /// Calls [changed] on the main actor after [flow] emits; the caller reads `flow.value` itself,
    /// usually together with other flows, so they are seen as one snapshot.
    func onChange<T>(_ flow: SkieSwiftStateFlow<T>, _ changed: @escaping @MainActor () -> Void) {
        tasks.append(Task { @MainActor in
            for await _ in flow {
                if Task.isCancelled { return }
                changed()
            }
        })
    }

    func onChange<T>(_ flow: SkieSwiftOptionalStateFlow<T>, _ changed: @escaping @MainActor () -> Void) {
        tasks.append(Task { @MainActor in
            for await _ in flow {
                if Task.isCancelled { return }
                changed()
            }
        })
    }

    /// The same Kotlin instance: values are immutable, so it cannot have changed. Anything else
    /// (a bridged list, a new instance) counts as a change and is applied.
    private static func identical<T>(_ a: T?, _ b: T?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (a?, b?):
            guard type(of: a as Any) is AnyClass, type(of: b as Any) is AnyClass else { return false }
            return (a as AnyObject) === (b as AnyObject)
        default: return false
        }
    }

    func observe<T>(_ flow: SkieSwiftSharedFlow<T>, _ apply: @escaping @MainActor (T) -> Void) {
        tasks.append(Task { @MainActor in
            for await value in flow {
                if Task.isCancelled { return }
                apply(value)
            }
        })
    }

    func cancelAll() {
        tasks.forEach { $0.cancel() }
        tasks.removeAll()
    }

    deinit {
        tasks.forEach { $0.cancel() }
    }
}

extension Error {
    /// The message a Kotlin exception carries, which the server's error envelope already phrased for people.
    var riffetMessage: String {
        let nsError = self as NSError
        if let exception = nsError.userInfo["KotlinException"] as? KotlinThrowable, let message = exception.message, !message.isEmpty {
            return message
        }
        return localizedDescription
    }

    /// The HTTP status of a failed server call: 0 when the request never got an answer, nil when the
    /// error did not come from the server client at all.
    var riffetStatus: Int? {
        let exception = (self as NSError).userInfo["KotlinException"] as? KotlinThrowable
        if let http = exception as? RiffetHttpException { return Int(http.status) }
        return exception == nil ? nil : 0
    }

    /// The server's error code (`PATH_OUTSIDE_PROJECT`, …) when it sent one.
    var riffetCode: String? {
        ((self as NSError).userInfo["KotlinException"] as? RiffetHttpException)?.code
    }

    /// The plugin that owns the Agent behind this call is off (HTTP 503 `NATIVE_BACKEND_UNAVAILABLE`).
    var riffetBackendUnavailable: Bool { riffetCode == "NATIVE_BACKEND_UNAVAILABLE" }

    /// The server refused this device's credentials (HTTP 401), as opposed to not answering.
    var riffetUnauthenticated: Bool {
        if (self as NSError).userInfo["KotlinException"] is RiffetUnauthenticatedException { return true }
        return riffetStatus == 401 || riffetCode == "UNAUTHENTICATED"
    }
}

/// ISO-8601 stamps from the server, with or without fractional seconds.
enum ServerTime {
    private nonisolated(unsafe) static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private nonisolated(unsafe) static let plain = ISO8601DateFormatter()

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
}
