import Foundation
import SwiftUI
import RiffetKit

enum StatsRangePreset: String, CaseIterable, Identifiable {
    case today, week, month, quarter, year, all, custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: String(localized: "今天")
        case .week: String(localized: "7 天")
        case .month: String(localized: "30 天")
        case .quarter: String(localized: "90 天")
        case .year: String(localized: "1 年")
        case .all: String(localized: "全部")
        case .custom: String(localized: "自定义")
        }
    }

    var windowName: String? {
        switch self {
        case .today: String(localized: "今天")
        case .week: String(localized: "近 7 天")
        case .month: String(localized: "近 30 天")
        case .quarter: String(localized: "近 90 天")
        case .year: String(localized: "近一年")
        case .all: String(localized: "全部时间")
        case .custom: nil
        }
    }
}

enum RankMetric: String, CaseIterable, Identifiable {
    case tokens, runs, speed
    var id: String { rawValue }
    var label: String {
        switch self {
        case .tokens: "Token"
        case .runs: String(localized: "轮次")
        case .speed: String(localized: "速度")
        }
    }
}

enum LatencyMetric: String, CaseIterable, Identifiable {
    case ttft, duration, speed
    var id: String { rawValue }
    var label: String {
        switch self {
        case .ttft: String(localized: "首字延迟")
        case .duration: String(localized: "整轮耗时")
        case .speed: String(localized: "输出速度")
        }
    }
}

enum StatsTime {
    private nonisolated(unsafe) static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static func string(_ date: Date) -> String { iso.string(from: date) }

    static func date(_ value: String) -> Date? { ServerTime.date(value) }

    static func dayString(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    static func day(_ value: String) -> Date? {
        let pieces = value.split(separator: "-")
        guard pieces.count == 3, let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2]) else { return nil }
        return Calendar.current.date(from: DateComponents(year: year, month: month, day: day))
    }
}

struct StatsWindow {
    var from: String
    var to: String
}

/// The same window the web sends: local midnights, `to` exclusive. A custom end that is a calendar
/// day gains one day; an instant from the chart brush is already exclusive.
func statsWindow(preset: StatsRangePreset, customFrom: String?, customTo: String?, now: Date) -> StatsWindow {
    if preset == .custom, let customFrom, let customTo, !customFrom.isEmpty, !customTo.isEmpty {
        return StatsWindow(from: statsInstant(customFrom, exclusiveEnd: false), to: statsInstant(customTo, exclusiveEnd: !customTo.contains("T")))
    }
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: now)
    let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
    let from: Date
    switch preset {
    case .today, .custom:
        from = start
    case .week:
        from = calendar.date(byAdding: .day, value: -6, to: start) ?? start
    case .month:
        from = calendar.date(byAdding: .day, value: -29, to: start) ?? start
    case .quarter:
        from = calendar.date(byAdding: .day, value: -89, to: start) ?? start
    case .year:
        from = calendar.date(byAdding: .day, value: -364, to: start) ?? start
    case .all:
        from = Calendar.current.date(from: DateComponents(year: 2018, month: 1, day: 1)) ?? start
    }
    return StatsWindow(from: StatsTime.string(from), to: StatsTime.string(end))
}

func statsInstant(_ value: String, exclusiveEnd: Bool) -> String {
    if value.contains("T") {
        return StatsTime.date(value).map(StatsTime.string) ?? value
    }
    guard let day = StatsTime.day(value) else { return value }
    let date = exclusiveEnd ? (Calendar.current.date(byAdding: .day, value: 1, to: day) ?? day) : day
    return StatsTime.string(date)
}

func statsGranularity(preset: StatsRangePreset, customFrom: String?, customTo: String?, now: Date) -> StatsGranularity {
    switch preset {
    case .today: return .hour
    case .week, .month: return .day
    case .quarter: return .week
    case .year, .all: return .month
    case .custom:
        let window = statsWindow(preset: preset, customFrom: customFrom, customTo: customTo, now: now)
        let span = (StatsTime.date(window.to)?.timeIntervalSince1970 ?? 0) - (StatsTime.date(window.from)?.timeIntervalSince1970 ?? 0)
        let day = 86_400.0
        if !span.isFinite || span <= 2 * day { return .hour }
        if span <= 62 * day { return .day }
        if span <= 200 * day { return .week }
        return .month
    }
}

func statsWindowLabel(preset: StatsRangePreset, customFrom: String?, customTo: String?, now: Date) -> String {
    if let named = preset.windowName { return named }
    let window = statsWindow(preset: preset, customFrom: customFrom, customTo: customTo, now: now)
    let endSource = (customTo?.contains("T") == false ? customTo : nil) ?? window.to
    let startSource = customFrom ?? window.from
    return "\(statsShortDate(startSource))–\(statsShortDate(endSource))"
}

func statsPreviousWindowLabel(preset: StatsRangePreset, customFrom: String?, customTo: String?, now: Date) -> String {
    if preset == .all { return "" }
    let window = statsWindow(preset: preset, customFrom: customFrom, customTo: customTo, now: now)
    guard let from = StatsTime.date(window.from), let to = StatsTime.date(window.to), to > from else { return "" }
    let span = to.timeIntervalSince(from)
    return "\(statsShortDate(from.addingTimeInterval(-span)))–\(statsShortDate(from))"
}

func statsDateInput(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "" }
    if value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil { return value }
    guard let date = StatsTime.date(value) else { return "" }
    return StatsTime.dayString(date)
}

private func statsShortDate(_ value: String) -> String {
    guard let date = StatsTime.date(value) ?? StatsTime.day(value) else { return value }
    return statsShortDate(date)
}

private func statsShortDate(_ date: Date) -> String {
    let parts = Calendar.current.dateComponents([.month, .day], from: date)
    return "\(parts.month ?? 0)/\(parts.day ?? 0)"
}

func statsPairs(_ items: [(String, String)]) -> [KotlinPair<NSString, NSString>] {
    items.map { KotlinPair(first: $0.0 as NSString, second: $0.1 as NSString) }
}

// MARK: - Numbers

let statsUnavailable = "—"

private func trimNumber(_ value: Double, digits: Int) -> String {
    String(format: "%.\(digits)f", value)
        .replacingOccurrences(of: #"(\.\d*?)0+$"#, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"\.$"#, with: "", options: .regularExpression)
}

func formatTokens(_ value: Double?) -> String {
    guard let value, value.isFinite else { return statsUnavailable }
    let sign = value < 0 ? "-" : ""
    let absValue = abs(value)
    if absValue < 1000 { return "\(sign)\(Int(absValue.rounded()))" }
    let units = ["K", "M", "B"]
    var scaled = absValue / 1000
    var unit = 0
    while scaled >= 999.5, unit < units.count - 1 {
        scaled /= 1000
        unit += 1
    }
    let digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
    return "\(sign)\(trimNumber(scaled, digits: digits))\(units[unit])"
}

func formatCount(_ value: Double?) -> String {
    guard let value, value.isFinite else { return statsUnavailable }
    return Int(value.rounded()).formatted(.number.locale(AppLocale.current))
}

func formatPercent(_ value: Double?) -> String {
    guard let value, value.isFinite else { return statsUnavailable }
    let pct = (value * 1000).rounded() / 10
    return pct.rounded() == pct ? "\(Int(pct))%" : "\(String(format: "%.1f", pct))%"
}

func formatDuration(_ ms: Double?) -> String {
    guard let ms, ms.isFinite else { return statsUnavailable }
    let sign = ms < 0 ? "-" : ""
    let absValue = abs(ms)
    if absValue < 1000 { return "\(sign)\(Int(absValue.rounded()))ms" }
    if absValue < 60_000 { return "\(sign)\(trimNumber(absValue / 1000, digits: absValue >= 10_000 ? 1 : 2))s" }
    let minutes = absValue / 60_000
    return "\(sign)\(trimNumber(minutes, digits: minutes >= 10 ? 0 : 1))min"
}

func formatSpeed(_ value: Double?) -> String {
    guard let value, value.isFinite else { return statsUnavailable }
    let digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
    return "\(trimNumber(value, digits: digits)) token/s"
}

enum KpiFormat { case tokens, count, days, percent, duration, speed }

func formatMetric(_ value: Double?, _ format: KpiFormat) -> String {
    switch format {
    case .tokens: formatTokens(value)
    case .percent: formatPercent(value)
    case .duration: formatDuration(value)
    case .speed: formatSpeed(value)
    case .count, .days: formatCount(value)
    }
}

func formatRatio(_ ratio: Double) -> String {
    let pct = abs(ratio * 100)
    let digits = pct >= 100 ? 0 : 1
    return "\(ratio > 0 ? "+" : "-")\(trimNumber(pct, digits: digits))%"
}

enum MetricDeltaKind { case none, flat, ratio, fresh }

struct MetricDelta {
    var kind: MetricDeltaKind
    var ratio: Double?
    var improved: Bool?
}

func metricDelta(current: Double?, previous: Double?, lowerIsBetter: Bool) -> MetricDelta {
    guard let current, let previous, current.isFinite, previous.isFinite else {
        return MetricDelta(kind: .none, ratio: nil, improved: nil)
    }
    if previous == 0 {
        if current == 0 { return MetricDelta(kind: .flat, ratio: 0, improved: nil) }
        return MetricDelta(kind: .fresh, ratio: nil, improved: lowerIsBetter ? current < 0 : current > 0)
    }
    let ratio = (current - previous) / abs(previous)
    if abs(ratio) < 0.005 { return MetricDelta(kind: .flat, ratio: 0, improved: nil) }
    return MetricDelta(kind: .ratio, ratio: ratio, improved: lowerIsBetter ? ratio < 0 : ratio > 0)
}

func formatTimestamp(_ iso: String?) -> String {
    guard let iso, let date = StatsTime.date(iso) else { return statsUnavailable }
    let parts = Calendar.current.dateComponents([.month, .day, .hour, .minute], from: date)
    return "\(parts.month ?? 0)/\(parts.day ?? 0) \(String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0))"
}

func formatRowTime(_ iso: String, now: Date) -> String {
    guard let date = StatsTime.date(iso) else { return statsUnavailable }
    let clock = String(format: "%02d:%02d", Calendar.current.component(.hour, from: date), Calendar.current.component(.minute, from: date))
    if Calendar.current.isDate(date, inSameDayAs: now) { return clock }
    if let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: now), Calendar.current.isDate(date, inSameDayAs: yesterday) {
        return String(localized: "昨天 \(clock)")
    }
    return formatTimestamp(iso)
}

func formatExactTimestamp(_ iso: String) -> String {
    guard let date = StatsTime.date(iso) else { return statsUnavailable }
    let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    return String(format: "%04d/%02d/%02d %02d:%02d:%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
}

func formatBucket(_ date: Date, granularity: StatsGranularity) -> String {
    let parts = Calendar.current.dateComponents([.year, .month, .day, .hour], from: date)
    switch granularity {
    case .hour: return "\(parts.hour ?? 0):00"
    case .month: return "\(parts.year ?? 0)/\(parts.month ?? 0)"
    case .week, .day: return "\(parts.month ?? 0)/\(parts.day ?? 0)"
    }
}

func runStateLabel(_ state: RunState) -> String {
    switch state {
    case .queued: String(localized: "排队")
    case .running: String(localized: "进行中")
    case .completed: String(localized: "完成")
    case .failed: String(localized: "失败")
    case .cancelled: String(localized: "取消")
    case .interrupted: String(localized: "中断")
    }
}

struct TokenDisplay {
    var text: String
    var estimated: Bool
    var unavailable: Bool
}

func tokensDisplay(_ tokens: StatsTokens, total: Int64) -> TokenDisplay {
    let measured = [tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output, tokens.reasoning]
    let estimated = tokens.estimatedOutput > 0
    let any = measured.contains { $0 != nil } || estimated || total > 0
    if !any { return TokenDisplay(text: statsUnavailable, estimated: false, unavailable: true) }
    return TokenDisplay(text: formatTokens(Double(total)), estimated: estimated, unavailable: false)
}

func optionalDouble(_ value: KotlinDouble?) -> Double? { value?.doubleValue }

func optionalLong(_ value: KotlinLong?) -> Double? { value.map { Double($0.int64Value) } }

func successRate(_ states: StatsRunStates) -> Double? {
    let total = states.completed + states.failed + states.cancelled + states.interrupted
    guard total > 0 else { return nil }
    return Double(states.completed) / Double(total)
}

/// Per-state counts of one session's loaded turns, in the order the reliability card lists them.
struct StatsStateTally {
    var completed = 0
    var failed = 0
    var cancelled = 0
    var interrupted = 0
    var running = 0
    var queued = 0

    mutating func add(_ state: RunState) {
        switch state {
        case .completed: completed += 1
        case .failed: failed += 1
        case .cancelled: cancelled += 1
        case .interrupted: interrupted += 1
        case .running: running += 1
        case .queued: queued += 1
        }
    }

    var summary: String {
        [(RunState.completed, completed), (.failed, failed), (.cancelled, cancelled), (.interrupted, interrupted), (.running, running), (.queued, queued)]
            .filter { $0.1 > 0 }
            .map { "\(runStateLabel($0.0)) \($0.1)" }
            .joined(separator: " · ")
    }
}

/// One session and the turns loaded for it. The details list is read per session: seven turns of one
/// conversation are one session with seven turns, not seven rows carrying the same title.
struct StatsSessionRow: Identifiable {
    let sessionId: String
    let title: String
    let projectName: String
    /// Newest turn first, in the order the API listed them.
    let runs: [StatsRunRow]
    let createdAt: String
    let state: RunState
    let states: StatsStateTally
    /// Newest first, without repeats: a session usually stays on one agent and one model.
    let agents: [String]
    let models: [String]
    let tokens: TokenDisplay
    /// Turns with no token measurement at all; the sum then covers only the measured ones.
    let unmeasured: Int
    /// Sum of the measured turns' durations.
    let durationMs: Double?
    /// Median of the measured turns' first-output latencies.
    let ttftMs: Double?

    var id: String { sessionId }
    var turnCount: Int { runs.count }

    init?(sessionId: String, runs: [StatsRunRow]) {
        guard let newest = runs.first else { return nil }
        self.sessionId = sessionId
        self.runs = runs
        title = newest.sessionTitle
        projectName = newest.projectName
        createdAt = newest.createdAt
        state = newest.state

        var tally = StatsStateTally()
        var backends: [String] = []
        var seenModels: [String] = []
        var durations: [Double] = []
        var latencies: [Double] = []
        var measured = false
        var estimated = false
        var missing = 0
        for run in runs {
            tally.add(run.state)
            if !backends.contains(run.agent) { backends.append(run.agent) }
            if let model = run.model, !seenModels.contains(model) { seenModels.append(model) }
            let display = tokensDisplay(run.tokens, total: run.totalTokens)
            if display.unavailable { missing += 1 } else { measured = true }
            estimated = estimated || display.estimated
            if let duration = optionalLong(run.durationMs) { durations.append(duration) }
            if let ttft = optionalLong(run.ttftMs) { latencies.append(ttft) }
        }
        states = tally
        agents = backends
        models = seenModels
        unmeasured = missing
        let total = runs.reduce(Int64(0)) { $0 + $1.totalTokens }
        // A sum over a session with unmeasured turns is a floor, and says so with "≥".
        tokens = measured
            ? TokenDisplay(text: (missing > 0 ? "≥" : "") + formatTokens(Double(total)), estimated: estimated, unavailable: false)
            : TokenDisplay(text: statsUnavailable, estimated: false, unavailable: true)
        durationMs = durations.isEmpty ? nil : durations.reduce(0, +)
        ttftMs = median(latencies)
    }
}

/// Folds the loaded runs into one row per session, keeping the API's newest-first order: a session
/// sits where its newest turn sits, and pages that arrive later join the session they belong to.
func statsSessionRows(_ runs: [StatsRunRow]) -> [StatsSessionRow] {
    var order: [String] = []
    var grouped: [String: [StatsRunRow]] = [:]
    for run in runs {
        if grouped[run.sessionId] == nil { order.append(run.sessionId) }
        grouped[run.sessionId, default: []].append(run)
    }
    return order.compactMap { id in
        guard let turns = grouped[id] else { return nil }
        return StatsSessionRow(sessionId: id, runs: turns)
    }
}

func median(_ values: [Double]) -> Double? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let middle = sorted.count / 2
    if sorted.count % 2 == 1 { return sorted[middle] }
    return (sorted[middle - 1] + sorted[middle]) / 2
}

func pointValues(_ point: StatsSeriesPoint) -> [String: Double] {
    var output: [String: Double] = [:]
    for (key, value) in point.values {
        let number = value.doubleValue
        if number.isFinite { output[key] = number }
    }
    return output
}

func pointTotal(_ values: [String: Double]) -> Double? {
    let nums = values.values.filter(\.isFinite)
    guard !nums.isEmpty else { return nil }
    return nums.reduce(0) { $0 + max(0, $1) }
}

struct KpiModel: Identifiable {
    var id: String
    var label: String
    var value: Double?
    var previous: Double?
    var format: KpiFormat
    var lowerIsBetter: Bool
    var estimated: Bool
    var note: String?
}

func buildKpis(summary: StatsSummary) -> [KpiModel] {
    let current = summary.current
    let previous = summary.previous
    return [
        KpiModel(id: "tokens", label: String(localized: "总 token"), value: Double(current.totalTokens), previous: Double(previous.totalTokens), format: .tokens, lowerIsBetter: false, estimated: current.tokens.estimatedOutput > 0, note: nil),
        KpiModel(id: "runs", label: String(localized: "轮次"), value: Double(current.runs), previous: Double(previous.runs), format: .count, lowerIsBetter: false, estimated: false, note: nil),
        KpiModel(id: "sessions", label: String(localized: "会话"), value: Double(current.sessions), previous: Double(previous.sessions), format: .count, lowerIsBetter: false, estimated: false, note: nil),
        KpiModel(id: "days", label: String(localized: "活跃天数"), value: Double(current.activeDays), previous: Double(previous.activeDays), format: .days, lowerIsBetter: false, estimated: false, note: String(localized: "连续 \(summary.streakDays) 天")),
        KpiModel(id: "cache", label: String(localized: "缓存命中率"), value: optionalDouble(current.cacheHitRate), previous: optionalDouble(previous.cacheHitRate), format: .percent, lowerIsBetter: false, estimated: false, note: nil),
        KpiModel(id: "ttft", label: String(localized: "首字延迟 p50"), value: current.ttftMs?.p50, previous: previous.ttftMs?.p50, format: .duration, lowerIsBetter: true, estimated: false, note: nil),
        KpiModel(id: "speed", label: String(localized: "输出速度 p50"), value: current.outputTokensPerSecond?.p50, previous: previous.outputTokensPerSecond?.p50, format: .speed, lowerIsBetter: false, estimated: false, note: nil),
        KpiModel(id: "success", label: String(localized: "成功率"), value: successRate(current.states), previous: successRate(previous.states), format: .percent, lowerIsBetter: false, estimated: false, note: nil),
    ]
}

func niceUpper(_ maxValue: Double) -> Double {
    guard maxValue.isFinite, maxValue > 0 else { return 1 }
    let padded = maxValue * 1.05
    let exponent = floor(log10(padded))
    let base = pow(10, exponent)
    let fraction = padded / base
    let nice: Double = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
    return nice * base
}

func heatLevel(_ value: Double, max maxValue: Double) -> Int {
    guard value.isFinite, value > 0, maxValue.isFinite, maxValue > 0 else { return 0 }
    let t = value / maxValue
    if t <= 0.25 { return 1 }
    if t <= 0.5 { return 2 }
    if t <= 0.75 { return 3 }
    return 4
}

let statsHeatAlpha: [Double] = [0, 0.18, 0.38, 0.62, 0.9]
let statsWeekdays = [String(localized: "一"), String(localized: "二"), String(localized: "三"), String(localized: "四"), String(localized: "五"), String(localized: "六"), String(localized: "日")]

func weekGrid(_ heatmap: StatsHeatmap) -> [[Int64]]? {
    let rows = heatmap.weekHour
    guard rows.count == 7, rows.allSatisfy({ $0.count >= 24 }) else { return nil }
    return rows.map { row in row.prefix(24).map(\.int64Value) }
}

func stableKeyHash(_ key: String) -> Int32 {
    var hash: Int32 = 0
    for unit in key.utf16 {
        hash = hash &* 31 &+ Int32(unit)
    }
    return hash
}

/// Fixed agent slots, then a stable hash for everything else, matching the web palette.
func seriesColorSlots(_ keys: [(key: String, agent: String?)]) -> [String: Int] {
    let backends = ["cursor", "codex", "claude", "dsh", "droid", "traex", "chat", "pi"]
    var result: [String: Int] = [:]
    var used = Set<Int>()
    let ordered = Array(Set(keys.map(\.key))).sorted()
    for key in ordered {
        let wire = keys.first { $0.key == key }?.agent ?? key
        if let slot = backends.firstIndex(of: wire) {
            result[key] = slot
            used.insert(slot)
        }
    }
    for key in ordered where result[key] == nil {
        var slot = Int((stableKeyHash(key) % 8 + 8) % 8)
        var probe = 0
        while used.contains(slot), probe < 8 {
            slot = (slot + 1) % 8
            probe += 1
        }
        used.insert(slot)
        result[key] = slot
    }
    return result
}

func chartColors(_ palette: Palette) -> [Color] {
    [palette.chart1, palette.chart2, palette.chart3, palette.chart4, palette.chart5, palette.chart6, palette.chart7, palette.chart8]
}

struct UsageMark: Identifiable {
    var id: String
    var date: Date
    var y0: Double
    var y1: Double
    var series: String
    var layer: String
    var kind: Kind
    enum Kind { case area, line, gap, point }
}

struct UsageLayerInfo: Identifiable {
    var id: String { key }
    var key: String
    var label: String
    var slot: Int
    var reported: [Double?]
}

struct UsageChartData {
    var marks: [UsageMark]
    var layers: [UsageLayerInfo]
    var dates: [Date]
    var totals: [Double?]
    var yMax: Double
    var scaleDomain: [String]
    var measured: Bool
}

func usageChartData(_ series: StatsSeries) -> UsageChartData {
    let keys = series.keys
    let slots = seriesColorSlots(keys.map { ($0.key, $0.agent) })
    var dates: [Date] = []
    var reportedByLayer: [[Double?]] = Array(repeating: [], count: keys.count)
    var bands: [[(Double, Double)?]] = Array(repeating: [], count: keys.count)
    var totals: [Double?] = []
    var maxY = 0.0
    for point in series.points {
        dates.append(StatsTime.date(point.start) ?? .distantPast)
        let values = pointValues(point)
        let reported = keys.map { key -> Double? in
            guard let raw = values[key.key], raw.isFinite else { return nil }
            return max(0, raw)
        }
        if reported.allSatisfy({ $0 == nil }) {
            totals.append(nil)
            for index in keys.indices {
                bands[index].append(nil)
                reportedByLayer[index].append(nil)
            }
            continue
        }
        var y = 0.0
        for index in keys.indices {
            let height = reported[index] ?? 0
            bands[index].append((y, y + height))
            reportedByLayer[index].append(reported[index])
            y += height
        }
        totals.append(y)
        maxY = max(maxY, y)
    }
    var marks: [UsageMark] = []
    var domain: [String] = []
    for (index, key) in keys.enumerated() {
        var segment = 0
        var current: [Int] = []
        func flush() {
            guard !current.isEmpty else { return }
            let seriesId = "\(key.key)#\(segment)"
            if current.count == 1, let only = current.first, let band = bands[index][only] {
                let id = "\(seriesId)#point"
                domain.append(id)
                marks.append(UsageMark(id: id, date: dates[only], y0: band.0, y1: band.1, series: id, layer: key.key, kind: .point))
            } else {
                domain.append(seriesId)
                domain.append("\(seriesId)#line")
                for offset in current {
                    guard let band = bands[index][offset] else { continue }
                    marks.append(UsageMark(id: "\(seriesId)#\(offset)#a", date: dates[offset], y0: band.0, y1: band.1, series: seriesId, layer: key.key, kind: .area))
                    marks.append(UsageMark(id: "\(seriesId)#\(offset)#l", date: dates[offset], y0: band.0, y1: band.1, series: "\(seriesId)#line", layer: key.key, kind: .line))
                }
            }
            segment += 1
            current = []
        }
        for offset in bands[index].indices {
            if bands[index][offset] == nil { flush() } else { current.append(offset) }
        }
        flush()
        var previousEnd: Int?
        for offset in bands[index].indices {
            if bands[index][offset] != nil {
                if let previousEnd, offset > previousEnd + 1, let from = bands[index][previousEnd], let to = bands[index][offset] {
                    let id = "\(key.key)#gap#\(previousEnd)"
                    domain.append(id)
                    marks.append(UsageMark(id: "\(id)#0", date: dates[previousEnd], y0: from.0, y1: from.1, series: id, layer: key.key, kind: .gap))
                    marks.append(UsageMark(id: "\(id)#1", date: dates[offset], y0: to.0, y1: to.1, series: id, layer: key.key, kind: .gap))
                }
                previousEnd = offset
            }
        }
    }
    let layers = keys.enumerated().map { index, key in
        UsageLayerInfo(key: key.key, label: key.label, slot: slots[key.key] ?? 0, reported: reportedByLayer[index])
    }
    let measured = totals.contains { ($0 ?? 0) > 0 } || reportedByLayer.contains { $0.contains { $0 != nil } }
    let start = dates.first ?? Date()
    let end = dates.last ?? start
    return UsageChartData(marks: marks, layers: layers, dates: dates, totals: totals, yMax: niceUpper(maxY), scaleDomain: domain, measured: measured && end >= start)
}

func nearestBucket(_ dates: [Date], _ date: Date) -> Int? {
    guard !dates.isEmpty else { return nil }
    var best = 0
    var bestDistance = Double.greatestFiniteMagnitude
    for (index, candidate) in dates.enumerated() {
        let distance = abs(candidate.timeIntervalSince(date))
        if distance < bestDistance {
            best = index
            bestDistance = distance
        }
    }
    return best
}

struct DonutSlice: Identifiable {
    var id: String { key }
    var key: String
    var label: String
    var value: Double
    var share: Double
    var slot: Int
}

func donutSlices(_ rows: [StatsBreakdownRow]) -> (slices: [DonutSlice], basis: String) {
    let basisTokens = rows.contains { $0.totalTokens > 0 }
    let usable = rows.compactMap { row -> (StatsBreakdownRow, Double)? in
        let value = basisTokens ? Double(row.totalTokens) : Double(row.count)
        return value > 0 && value.isFinite ? (row, value) : nil
    }
    let total = usable.reduce(0) { $0 + $1.1 }
    guard total > 0 else { return ([], basisTokens ? "Token" : String(localized: "轮次")) }
    let slots = seriesColorSlots(usable.map { ($0.0.key, $0.0.agent) })
    let slices = usable.map { row, value in
        DonutSlice(key: row.key, label: row.label, value: value, share: value / total, slot: slots[row.key] ?? 0)
    }
    return (slices, basisTokens ? "Token" : String(localized: "轮次"))
}

func sortedBreakdown(_ rows: [StatsBreakdownRow], rank: RankMetric) -> [StatsBreakdownRow] {
    rows.sorted { lhs, rhs in
        rankValue(lhs, rank) > rankValue(rhs, rank)
    }
}

func rankValue(_ row: StatsBreakdownRow, _ rank: RankMetric) -> Double {
    switch rank {
    case .runs: Double(row.count)
    case .speed: row.outputTokensPerSecond?.p50 ?? -.infinity
    case .tokens: Double(row.totalTokens)
    }
}

func latencySample(_ row: StatsLatencyRow, _ kind: LatencyMetric) -> StatsPercentiles? {
    switch kind {
    case .ttft: row.ttftMs
    case .duration: row.durationMs
    case .speed: row.outputTokensPerSecond
    }
}
