import Foundation

enum NativeStatsRange: String, CaseIterable, Identifiable {
    case today, week = "7d", month = "30d", quarter = "90d", year = "1y", all, custom
    var id: String { rawValue }
    var label: String {
        switch self {
        case .today: String(localized: "今天", bundle: .riffet)
        case .week: String(localized: "近 7 天", bundle: .riffet)
        case .month: String(localized: "近 30 天", bundle: .riffet)
        case .quarter: String(localized: "近 90 天", bundle: .riffet)
        case .year: String(localized: "近一年", bundle: .riffet)
        case .all: String(localized: "全部时间", bundle: .riffet)
        case .custom: String(localized: "自定义日期", bundle: .riffet)
        }
    }
}

enum NativeStatsMetric: String, CaseIterable, Identifiable {
    case totalTokens, inputTokens, outputTokens, cacheReadTokens, runs, sessions, durationMs
    var id: String { rawValue }
    var label: String {
        switch self {
        case .totalTokens: String(localized: "Token 总量", bundle: .riffet)
        case .inputTokens: String(localized: "输入 Token", bundle: .riffet)
        case .outputTokens: String(localized: "输出 Token", bundle: .riffet)
        case .cacheReadTokens: String(localized: "缓存读取", bundle: .riffet)
        case .runs: String(localized: "轮次", bundle: .riffet)
        case .sessions: String(localized: "会话", bundle: .riffet)
        case .durationMs: String(localized: "整轮耗时", bundle: .riffet)
        }
    }
    var unit: String { self == .durationMs ? String(localized: "秒", bundle: .riffet) : self == .runs ? String(localized: "轮次", bundle: .riffet) : self == .sessions ? String(localized: "会话", bundle: .riffet) : "Token" }
    func plotted(_ amount: Double) -> Double { self == .durationMs ? amount / 1000 : amount }
    func formatted(_ amount: Double) -> String { plotted(amount).formatted(.number.precision(.fractionLength(self == .durationMs ? 2 : 0))) + " " + unit }
}

enum NativeStatsSplit: String, CaseIterable, Identifiable {
    case backend, model, project
    var id: String { rawValue }
    var label: String { self == .backend ? "Agent" : self == .model ? String(localized: "模型", bundle: .riffet) : String(localized: "项目", bundle: .riffet) }
}

struct NativeStatsSelection: Equatable {
    static let maximumSelections = 100
    var range: NativeStatsRange = .month
    var from = Calendar.current.date(byAdding: .day, value: -29, to: Calendar.current.startOfDay(for: Date())) ?? Date()
    var to = Calendar.current.startOfDay(for: Date())
    var projects: Set<String> = []
    var backends: Set<String> = []
    var models: Set<String> = []
    var agentKind = "all"
    // The Web/server default includes archived sessions; the native toggle is explicit.
    var includeArchived = true
    var includeEstimated = true
    var activeCount: Int { projects.count + backends.count + models.count + (includeArchived ? 0 : 1) + (includeEstimated ? 0 : 1) + (agentKind == "all" ? 0 : 1) }

    static var calendar: Calendar { var value = Calendar(identifier: .gregorian); value.timeZone = .current; return value }
    func window(now: Date = Date(), calendar: Calendar = Self.calendar) throws -> DateInterval {
        let today = calendar.startOfDay(for: now)
        let end: Date
        let start: Date
        if range == .custom {
            start = calendar.startOfDay(for: from)
            end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: to)) ?? to
        } else {
            end = calendar.date(byAdding: .day, value: 1, to: today) ?? now
            switch range {
            case .today: start = today
            case .week: start = calendar.date(byAdding: .day, value: -6, to: today) ?? today
            case .month: start = calendar.date(byAdding: .day, value: -29, to: today) ?? today
            case .quarter: start = calendar.date(byAdding: .day, value: -89, to: today) ?? today
            case .year: start = calendar.date(byAdding: .day, value: -364, to: today) ?? today
            case .all: start = calendar.date(from: DateComponents(year: 2018, month: 1, day: 1)) ?? today
            case .custom: start = today
            }
        }
        guard start < end else { throw QueryError.invalidRange }
        return DateInterval(start: start, end: end)
    }
    func granularity(now: Date = Date(), calendar: Calendar = Self.calendar) throws -> String {
        switch range {
        case .today: return "hour"
        case .week, .month: return "day"
        case .quarter: return "week"
        case .year, .all: return "month"
        case .custom:
            let span = try window(now: now, calendar: calendar).duration
            if span <= 2 * 86_400 { return "hour" }
            if span <= 62 * 86_400 { return "day" }
            if span <= 200 * 86_400 { return "week" }
            return "month"
        }
    }
    func query(now: Date = Date(), calendar: Calendar = Self.calendar) throws -> [URLQueryItem] {
        guard [projects, backends, models].allSatisfy({ $0.count <= Self.maximumSelections }) else { throw QueryError.tooManySelections }
        let window = try window(now: now, calendar: calendar), format = Self.timestamp
        var values = [URLQueryItem(name: "from", value: format.string(from: window.start)), URLQueryItem(name: "to", value: format.string(from: window.end)),
                      URLQueryItem(name: "tz", value: calendar.timeZone.identifier), URLQueryItem(name: "agentKind", value: agentKind),
                      URLQueryItem(name: "includeArchived", value: includeArchived ? "true" : "false"), URLQueryItem(name: "includeEstimated", value: includeEstimated ? "true" : "false")]
        // These are repeated query keys, not comma-joined strings: a model name may contain commas.
        for (name, selected) in [("backend", backends), ("model", models), ("project", projects)] {
            values += selected.sorted().map { URLQueryItem(name: name, value: $0) }
        }
        return values
    }
    /// Shared: `key` is read on every pass of the statistics page.
    private nonisolated(unsafe) static let timestamp = ISO8601DateFormatter()
    var key: String {
        var components = URLComponents()
        components.queryItems = (try? query()) ?? [URLQueryItem(name: "invalid", value: "\(range.rawValue)|\(from.timeIntervalSince1970)|\(to.timeIntervalSince1970)")]
        return components.percentEncodedQuery ?? ""
    }
    enum QueryError: LocalizedError {
        case invalidRange, tooManySelections
        var errorDescription: String? { self == .invalidRange ? String(localized: "开始日期不能晚于结束日期。", bundle: .riffet) : String(localized: "每类筛选最多选择 100 项。", bundle: .riffet) }
    }
}

/// A refresh of the same filter is still a new request. Filter equality alone does not
/// prevent an earlier refresh or page turn from overwriting the latest successful result.
struct NativeStatsRequestStamp: Equatable {
    let id = UUID()
    let filterKey: String
}
struct NativeStatsRequestGate {
    private(set) var current: NativeStatsRequestStamp?
    mutating func begin(_ key: String) -> NativeStatsRequestStamp { let stamp = NativeStatsRequestStamp(filterKey: key); current = stamp; return stamp }
    func accepts(_ stamp: NativeStatsRequestStamp, key: String) -> Bool { current == stamp && stamp.filterKey == key }
}
