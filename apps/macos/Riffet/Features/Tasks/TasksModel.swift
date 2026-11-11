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

/// The tasks page's data (`TasksPage.tsx`): templates and schedules, and the actions on them. The
/// lists are read together and refreshed every minute while the page is open, because the next and
/// last runs move on their own.
@MainActor
@Observable
final class TasksModel {
    let workbench: Workbench

    private(set) var templates: [TaskTemplate]?
    private(set) var schedules: [Schedule]?
    private(set) var loadError: String?
    /// The template or schedule being run; one run at a time.
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

    // MARK: Loading

    func load() async {
        guard let api = workbench.host.api else {
            if templates == nil { loadError = String(localized: "尚未连接服务器") }
            return
        }
        let issued = generation
        do {
            async let nextTemplates = api.templates()
            async let nextSchedules = api.schedules()
            let (loadedTemplates, loadedSchedules) = try await (nextTemplates, nextSchedules)
            guard issued == generation else {
                // Nothing on screen yet, and the result was dropped: read again rather than stay blank.
                if templates == nil { await load() }
                return
            }
            if templates != loadedTemplates { templates = loadedTemplates }
            if schedules != loadedSchedules { schedules = loadedSchedules }
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            // A refresh that fails keeps what is on screen; only a page with nothing to show reports it.
            if issued == generation, templates == nil || schedules == nil { loadError = error.riffetMessage }
        }
    }

    func retry() {
        loadError = nil
        Task { await load() }
    }

    /// After a save made elsewhere (the editor sheets): a read still on its way is older than the save.
    func reload() {
        generation += 1
        Task { await load() }
    }

    func template(_ id: String) -> TaskTemplate? {
        templates?.first { $0.id == id }
    }

    func enabled(_ schedule: Schedule) -> Bool {
        pendingEnabled[schedule.id] ?? schedule.enabled
    }

    // MARK: Actions

    /// Runs [template] in [project] and opens the conversation it starts.
    func run(_ template: TaskTemplate, in project: Project) async {
        guard running == nil, let api = workbench.host.api else { return }
        running = template.id
        defer { running = nil }
        let key = "\(project.id):\(template.id)"
        let ids = launchIds[key] ?? (UUID().uuidString, UUID().uuidString)
        launchIds[key] = ids
        do {
            let result = try await api.runTemplate(id: template.id, projectId: project.id, clientSessionId: ids.clientSessionId, commandId: ids.commandId)
            launchIds[key] = nil
            workbench.store.applySession(session: result.session)
            workbench.open(result.session)
        } catch {
            show(TasksNotice(text: String(localized: "无法运行模板：\(error.riffetMessage)"), isError: true))
        }
    }

    func delete(_ template: TaskTemplate) async {
        guard let api = workbench.host.api else { return }
        generation += 1
        do {
            try await api.deleteTemplate(id: template.id)
            generation += 1
            await load()
        } catch {
            show(TasksNotice(
                text: error.riffetCode == "TEMPLATE_IN_USE" ? String(localized: "还有定时任务在用这个模板，先删除它们") : String(localized: "无法删除模板：\(error.riffetMessage)"),
                isError: true
            ))
        }
    }

    /// Runs [schedule] once now, under the same skip-while-busy rule as its timer; the outcome is its `lastResult`.
    func run(_ schedule: Schedule) async {
        guard running == nil, let api = workbench.host.api else { return }
        running = schedule.id
        defer { running = nil }
        generation += 1
        do {
            let next = try await api.runSchedule(id: schedule.id)
            generation += 1
            replace(next)
            switch next.lastResult ?? "" {
            case "started": show(TasksNotice(text: String(localized: "已运行「\(next.name)」"), sessionId: next.lastSessionId))
            case "skipped": show(TasksNotice(text: String(localized: "上一次运行的会话还在进行，这次已跳过")))
            case "failed": show(TasksNotice(text: next.lastError ?? String(localized: "运行失败"), isError: true))
            default: break
            }
        } catch {
            show(TasksNotice(text: String(localized: "无法运行定时任务：\(error.riffetMessage)"), isError: true))
        }
    }

    func setEnabled(_ schedule: Schedule, _ enabled: Bool) async {
        guard !toggling.contains(schedule.id), let api = workbench.host.api else { return }
        toggling.insert(schedule.id)
        pendingEnabled[schedule.id] = enabled
        generation += 1
        defer {
            toggling.remove(schedule.id)
            pendingEnabled[schedule.id] = nil
        }
        do {
            let next = try await api.updateSchedule(id: schedule.id, name: nil, templateId: nil, projectId: nil, cron: nil, enabled: KotlinBoolean(bool: enabled), target: nil)
            generation += 1
            replace(next)
        } catch {
            show(TasksNotice(text: String(localized: "无法更新定时任务：\(error.riffetMessage)"), isError: true))
        }
    }

    func delete(_ schedule: Schedule) async {
        guard let api = workbench.host.api else { return }
        generation += 1
        do {
            try await api.deleteSchedule(id: schedule.id)
            generation += 1
            await load()
        } catch {
            show(TasksNotice(text: String(localized: "无法删除定时任务：\(error.riffetMessage)"), isError: true))
        }
    }

    func dismissNotice() {
        notice = nil
    }

    private func replace(_ schedule: Schedule) {
        guard let index = schedules?.firstIndex(where: { $0.id == schedule.id }) else { return }
        schedules?[index] = schedule
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
