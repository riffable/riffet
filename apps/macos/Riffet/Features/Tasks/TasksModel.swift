import Foundation
import Observation
import RiffetKit

/// A short message under the page header: an outcome to confirm (with a way to open the session it
/// started) or a failure of an action that has no dialog of its own.
struct TasksNotice: Identifiable, Equatable {
    let id = UUID()
    let text: String
    var isError = false
    var sessionId: String?
}

/// The automations page's data (`TasksPage.tsx`): every automation, the latest runs of all of them,
/// and the actions on them. Both are read together and refreshed every minute while the page is
/// open, because the next and last runs move on their own.
@MainActor
@Observable
final class TasksModel {
    let workbench: Workbench

    private(set) var automations: [Automation]?
    private(set) var runs: [AutomationRun] = []
    private(set) var loadError: String?
    /// The automation being run or created; one at a time.
    private(set) var running: String?
    private(set) var toggling: Set<String> = []
    /// The switch the reader flipped, shown until the server answers.
    private(set) var pendingEnabled: [String: Bool] = [:]
    private(set) var notice: TasksNotice?

    /// A retried run reuses its ids, so the server returns the conversation the first try created.
    @ObservationIgnored private var launchIds: [String: (clientSessionId: String, commandId: String)] = [:]

    /// Moves on with every write. A list read that started before one is older than what the write
    /// already put on screen, so its result is dropped.
    @ObservationIgnored private var generation = 0

    init(workbench: Workbench) {
        self.workbench = workbench
    }

    // MARK: Groups

    /// Enabled with a next time, soonest first; follow-ups are in it.
    var upcoming: [Automation] {
        (automations ?? [])
            .filter { enabled($0) && $0.nextRunAt != nil }
            // A user follow-up already due is being sent; the server refuses to delete it.
            .filter { $0.followUp?.by != "user" || (ServerTime.date($0.nextRunAt ?? "") ?? .distantFuture) > .now }
            .sorted { (ServerTime.date($0.nextRunAt ?? "") ?? .distantFuture) < (ServerTime.date($1.nextRunAt ?? "") ?? .distantFuture) }
    }

    /// No trigger and not a follow-up: run by hand.
    var manual: [Automation] {
        (automations ?? []).filter { $0.triggers.isEmpty && $0.followUp == nil }
    }

    /// Switched off, or a one-time task that has run.
    var paused: [Automation] {
        (automations ?? []).filter { $0.followUp == nil && !$0.triggers.isEmpty && !(enabled($0) && $0.nextRunAt != nil) }
    }

    /// The pending follow-ups of one conversation, soonest first.
    func followUps(for sessionId: String) -> [Automation] {
        upcoming.filter { $0.followUp?.sessionId == sessionId }
    }

    func automation(_ id: String) -> Automation? {
        automations?.first { $0.id == id }
    }

    func enabled(_ automation: Automation) -> Bool {
        pendingEnabled[automation.id] ?? automation.enabled
    }

    // MARK: Loading

    func load() async {
        guard let api = workbench.host.api else {
            if automations == nil { loadError = String(localized: "尚未连接服务器") }
            return
        }
        let issued = generation
        do {
            async let nextAutomations = api.automations()
            async let nextRuns = api.recentAutomationRuns(limit: 20)
            let (loaded, loadedRuns) = try await (nextAutomations, nextRuns)
            guard issued == generation else {
                // Nothing on screen yet, and the result was dropped: read again rather than stay blank.
                if automations == nil { await load() }
                return
            }
            if automations != loaded { automations = loaded }
            if runs != loadedRuns { runs = loadedRuns }
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            // A refresh that fails keeps what is on screen; only a page with nothing to show reports it.
            if issued == generation, automations == nil { loadError = error.riffetMessage }
        }
    }

    func retry() {
        loadError = nil
        Task { await load() }
    }

    /// After a save made elsewhere (the editor sheet): a read still on its way is older than the save.
    func reload() {
        generation += 1
        Task { await load() }
    }

    // MARK: Actions

    /// Creates a task from the quick bar. Returns whether it was saved, so the bar can clear itself.
    func create(prompt: String, when: TimePreset, projectId: String, target: LaunchTarget) async -> Bool {
        guard running == nil, let api = workbench.host.api else { return false }
        running = "create"
        defer { running = nil }
        generation += 1
        do {
            _ = try await api.createAutomation(
                name: Self.name(of: prompt), prompt: prompt, target: target, projectId: projectId, isolate: false,
                triggers: [when.trigger()], delivery: "new", catchUp: "latest", enabled: true
            )
            generation += 1
            await load()
            return true
        } catch {
            show(TasksNotice(text: String(localized: "无法创建自动化：\(error.riffetMessage)"), isError: true))
            return false
        }
    }

    /// The first line, cut to about 40 characters.
    static func name(of prompt: String) -> String {
        let line = prompt.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return line.count > 40 ? String(line.prefix(40)) + "…" : line
    }

    /// Runs [automation] once now, in [projectId] when it has none of its own.
    func run(_ automation: Automation, projectId: String? = nil) async {
        guard running == nil, let api = workbench.host.api else { return }
        running = automation.id
        defer { running = nil }
        let key = "\(automation.id):\(projectId ?? "")"
        let ids = launchIds[key] ?? (UUID().uuidString, UUID().uuidString)
        launchIds[key] = ids
        generation += 1
        do {
            let result = try await api.runAutomation(id: automation.id, projectId: projectId, clientSessionId: ids.clientSessionId, commandId: ids.commandId)
            launchIds[key] = nil
            generation += 1
            await load()
            switch result.result {
            case "started": show(TasksNotice(text: String(localized: "已运行「\(automation.name)」"), sessionId: result.sessionId))
            case "failed": show(TasksNotice(text: result.error ?? String(localized: "运行失败"), isError: true))
            default: show(TasksNotice(text: Self.reason(result) ?? String(localized: "这次已跳过")))
            }
        } catch {
            show(TasksNotice(text: String(localized: "无法运行自动化：\(error.riffetMessage)"), isError: true))
        }
    }

    func setEnabled(_ automation: Automation, _ enabled: Bool) async {
        guard !toggling.contains(automation.id), let api = workbench.host.api else { return }
        toggling.insert(automation.id)
        pendingEnabled[automation.id] = enabled
        generation += 1
        defer {
            toggling.remove(automation.id)
            pendingEnabled[automation.id] = nil
        }
        do {
            let next = try await api.updateAutomation(
                id: automation.id, name: nil, prompt: nil, target: nil, projectId: nil, isolate: nil,
                triggers: nil, delivery: nil, catchUp: nil, enabled: KotlinBoolean(bool: enabled)
            )
            generation += 1
            if let index = automations?.firstIndex(where: { $0.id == next.id }) { automations?[index] = next }
        } catch {
            show(TasksNotice(text: String(localized: "无法更新自动化：\(error.riffetMessage)"), isError: true))
        }
    }

    func delete(_ automation: Automation) async {
        guard let api = workbench.host.api else { return }
        generation += 1
        do {
            try await api.deleteAutomation(id: automation.id)
            generation += 1
            await load()
        } catch {
            show(TasksNotice(text: String(localized: "无法删除自动化：\(error.riffetMessage)"), isError: true))
        }
    }

    func dismissNotice() {
        notice = nil
    }

    /// Why a run did not start, in words; nil for a run that did.
    static func reason(_ run: AutomationRun) -> String? {
        if run.result == "failed" { return run.error }
        switch run.reason {
        case "busy": return String(localized: "上一轮仍在运行")
        case "offline": return String(localized: "Riffet 未运行")
        case "project-unavailable": return String(localized: "项目不可用")
        case "session-unavailable": return String(localized: "会话不可用")
        default: return nil
        }
    }

    private func show(_ next: TasksNotice) {
        notice = next
        guard !next.isError else { return }
        let id = next.id
        Task {
            try? await Task.sleep(for: .seconds(8))
            if notice?.id == id { notice = nil }
        }
    }
}

// MARK: - Times

/// A time the quick bar, the send-later menu and the editor offer: once at a moment, or on a cron
/// expression in this Mac's time zone.
struct TimePreset: Identifiable {
    let label: String
    private let once: ((Date) -> Date)?
    let cron: String?
    var id: String { label }

    private init(label: String, once: @escaping (Date) -> Date) {
        self.label = label
        self.once = once
        cron = nil
    }

    init(label: String, cron: String) {
        self.label = label
        self.cron = cron
        once = nil
    }

    var isRecurring: Bool { cron != nil }

    func trigger(now: Date = .now) -> AutomationTrigger {
        if let cron {
            return AutomationTrigger(kind: "cron", at: nil, cron: cron, timeZone: TimeZone.current.identifier)
        }
        return AutomationTrigger(kind: "once", at: Self.iso(once?(now) ?? now), cron: nil, timeZone: TimeZone.current.identifier)
    }

    static func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    static let in10Minutes = TimePreset(label: String(localized: "10 分钟后")) { $0.addingTimeInterval(600) }
    static let in1Hour = TimePreset(label: String(localized: "1 小时后")) { $0.addingTimeInterval(3600) }
    static let tomorrow = TimePreset(label: String(localized: "明天 9:00")) { now in
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
    }
    static let weekdays = TimePreset(label: String(localized: "每个工作日 9:00"), cron: "0 9 * * 1-5")
    static let daily = TimePreset(label: String(localized: "每天 9:00"), cron: "0 9 * * *")
    static let monday = TimePreset(label: String(localized: "每周一 9:00"), cron: "0 9 * * 1")

    /// The moment a one-time preset stands for.
    func date(now: Date = .now) -> Date? { once?(now) }

    static let all = [in10Minutes, in1Hour, tomorrow, weekdays, daily, monday]
    /// What send later offers: moments only.
    static let moments = [in10Minutes, in1Hour, tomorrow]
}

/// The next time [cron] fires after [now] in [timeZone], for the plain shapes `describeCron` reads
/// (a fixed time or every hour, on every day, workdays, weekends or listed weekdays). Nil for the
/// rest; the server's own `nextRunAt` is the truth once saved.
func nextCronRun(_ cron: String, timeZone: TimeZone = .current, after now: Date = .now) -> Date? {
    let parts = cron.split(whereSeparator: \.isWhitespace).map(String.init)
    guard parts.count == 5, parts[2] == "*", parts[3] == "*", let minute = Int(parts[0]), (0..<60).contains(minute) else { return nil }
    var weekdays = Set(0...6)
    if parts[4] != "*" {
        weekdays = []
        for item in parts[4].split(separator: ",") {
            let bounds = item.split(separator: "-").compactMap { Int($0) }
            if bounds.count == 1, bounds[0] <= 7 { weekdays.insert(bounds[0] % 7) }
            else if bounds.count == 2, bounds[0] <= bounds[1], bounds[1] <= 7 { for day in bounds[0]...bounds[1] { weekdays.insert(day % 7) } }
            else { return nil }
        }
    }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let hours: [Int]
    if parts[1] == "*" { hours = Array(0..<24) } else if let hour = Int(parts[1]), (0..<24).contains(hour) { hours = [hour] } else { return nil }
    for offset in 0...8 {
        guard let day = calendar.date(byAdding: .day, value: offset, to: now),
              weekdays.contains(calendar.component(.weekday, from: day) - 1) else { continue }
        for hour in hours {
            if let at = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day), at > now { return at }
        }
    }
    return nil
}

// MARK: - Cron

struct CronPreset: Identifiable {
    let cron: String
    let label: String
    var id: String { cron }

    static let all = [
        CronPreset(cron: "0 9 * * 1-5", label: String(localized: "工作日 9:00")),
        CronPreset(cron: "0 9 * * *", label: String(localized: "每天 9:00")),
        CronPreset(cron: "0 9 * * 1", label: String(localized: "每周一 9:00")),
        CronPreset(cron: "0 * * * *", label: String(localized: "每小时")),
    ]
}

private let cronAliases = ["@hourly": String(localized: "每小时"), "@daily": String(localized: "每天 0:00"), "@midnight": String(localized: "每天 0:00"), "@weekly": String(localized: "每周日 0:00"), "@monthly": String(localized: "每月 1 日 0:00")]
private let cronWeekdays = [String(localized: "日"), String(localized: "一"), String(localized: "二"), String(localized: "三"), String(localized: "四"), String(localized: "五"), String(localized: "六"), String(localized: "日")]

/// Reads the common shapes back as words: a fixed time on every day, workdays or one weekday, and the
/// hourly ones (the web's `describeCron`). Anything else stays the expression itself; a wrong paraphrase
/// of a schedule is worse than showing what will actually run.
func describeCron(_ cron: String) -> String {
    let text = cron.trimmingCharacters(in: .whitespacesAndNewlines)
    if let alias = cronAliases[text] { return alias }
    let parts = text.split(whereSeparator: \.isWhitespace).map(String.init)
    guard parts.count == 5 else { return text }
    let minute = parts[0], hour = parts[1], day = parts[2], month = parts[3], weekday = parts[4]
    func digits(_ value: String) -> Bool { !value.isEmpty && value.allSatisfy { $0 >= "0" && $0 <= "9" } }
    guard digits(minute), day == "*", month == "*" else { return text }
    if hour == "*" { return weekday == "*" ? (minute == "0" ? String(localized: "每小时") : String(localized: "每小时第 \(minute) 分")) : text }
    guard digits(hour) else { return text }
    let time = "\(hour):\(String(repeating: "0", count: max(0, 2 - minute.count)))\(minute)"
    if weekday == "*" { return String(localized: "每天 \(time)") }
    if weekday == "1-5" { return String(localized: "工作日 \(time)") }
    if weekday == "0,6" || weekday == "6,0" { return String(localized: "周末 \(time)") }
    if weekday.count == 1, let index = Int(weekday), index <= 7 { return String(localized: "每周\(cronWeekdays[index]) \(time)") }
    return text
}
