import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
import RiffetKit

/// Reads the stats APIs the web page reads, and keeps the live stream only while the page is visible.
/// The workbench keeps one across visits: the range, filters and last answer stay.
@MainActor
@Observable
final class StatsModel {
    let workbench: Workbench

    var preset: StatsRangePreset = .month
    var customFrom: String?
    var customTo: String?
    var backends: [String] = []
    var models: [String] = []
    var projects: [String] = []
    var includeEstimated = true
    var metric: StatsSeriesMetric = .totalTokens { didSet { deriveUsage() } }
    var split: StatsSplit = .backend { didSet { deriveUsage() } }
    var rank: RankMetric = .tokens { didSet { if rank != oldValue { deriveRank() } } }
    var latencyKind: LatencyMetric = .ttft

    private(set) var dashboard: StatsDashboard? { didSet { deriveDashboard() } }
    private(set) var series: StatsSeries? { didSet { deriveUsage() } }
    private(set) var latency: StatsLatency? { didSet { deriveLatency() } }

    // Chart data derived once per answer, not on every hover redraw of a chart.
    private(set) var usageData: UsageChartData?
    @ObservationIgnored private var usageSource: StatsSeries?
    /// The calendar's days in date order.
    private(set) var calendarDays: [StatsHeatmapDay] = []
    private(set) var weekHours: [[Int64]]?
    /// The first eight models by the chosen rank, and tools by calls.
    private(set) var rankedModels: [StatsBreakdownRow] = []
    private(set) var toolRows: [StatsBreakdownRow] = []
    /// The speed windows of the models that report a speed.
    private(set) var speedWindows: [String] = []
    private(set) var runs: [StatsRunRow] = []
    private(set) var runsHasMore = false
    private(set) var loading = false
    private(set) var refreshing = false
    private(set) var runsLoading = false
    private(set) var seriesStale = false
    private(set) var exporting = false
    private(set) var error: String?
    private(set) var runsError: String?
    private(set) var exportError: String?
    private(set) var latencyError: String?

    private var generation = 0
    private var seriesGeneration = 0
    private var runsGeneration = 0
    private var nextCursor: String?
    private var pageCount = 0
    private var streamTask: Task<Void, Never>?
    private var reloadTask: Task<Void, Never>?
    private var trailing: Task<Void, Never>?
    private var lastRefresh = Date.distantPast
    /// When the shown answer arrived for the current filters; distant past while a read is pending.
    @ObservationIgnored private var loadedAt = Date.distantPast
    /// A revisit within this long shows the last answer without reading again; the stream reports changes.
    private static let freshFor: TimeInterval = 15

    static let pageSize = "50"

    init(workbench: Workbench) {
        self.workbench = workbench
    }

    var displayedSeries: StatsSeries? {
        if let series, series.metric == metric, series.split == split { return series }
        if let embedded = dashboard?.series, embedded.metric == metric, embedded.split == split { return embedded }
        return series ?? dashboard?.series
    }

    var agentOptions: [(key: String, label: String)] {
        let reported = dashboard?.options.backends ?? []
        if !reported.isEmpty { return reported.map { ($0.key, $0.label) } }
        return AgentDirectory.shared.pickable.map { ($0.id, $0.label) }
    }

    var modelOptions: [(key: String, label: String)] {
        (dashboard?.options.models ?? []).map { ($0.key, $0.label) }
    }

    /// Projects come from the open workbench first; recorded projects the list no longer has stay selectable.
    var projectOptions: [(key: String, label: String)] {
        var seen = Set<String>()
        var options: [(String, String)] = []
        let quickChatId = workbench.quickChatProject?.id
        for project in workbench.projectList where !project.isBuiltInQuickChat && seen.insert(project.id).inserted {
            options.append((project.id, project.name))
        }
        for info in dashboard?.options.projects ?? [] where info.key != quickChatId && seen.insert(info.key).inserted {
            options.append((info.key, info.label))
        }
        return options.sorted { $0.1.localizedStandardCompare($1.1) == .orderedAscending }
    }

    var periodLabel: String { statsWindowLabel(preset: preset, customFrom: customFrom, customTo: customTo, now: Date()) }

    var compareLabel: String { statsPreviousWindowLabel(preset: preset, customFrom: customFrom, customTo: customTo, now: Date()) }

    var activeFilterCount: Int { backends.count + models.count + projects.count + (includeEstimated ? 0 : 1) }

    func reload() { scheduleReload(resetRuns: true) }

    /// The page appeared: the last answer stays on screen and is read again in the background once
    /// older than a few seconds; the first visit reads with the skeleton.
    func start() {
        guard streamTask == nil else { return }
        if dashboard == nil {
            scheduleReload(resetRuns: true)
        } else if Date().timeIntervalSince(loadedAt) > Self.freshFor {
            scheduleReload(resetRuns: false, quiet: true)
        }
        guard let api = workbench.host.api else { return }
        streamTask = Task { @MainActor [weak self] in
            let session = api.statsStream()
            do {
                for await message in session.messages {
                    if Task.isCancelled { return }
                    guard message.type == "stats_changed" else { continue }
                    self?.noteChanged()
                }
            } catch {
                if !Task.isCancelled { self?.error = error.riffetMessage }
            }
        }
    }

    /// The page went away: the stream and any read in flight stop; a stopped read is redone on return.
    func stop() {
        streamTask?.cancel()
        streamTask = nil
        trailing?.cancel()
        trailing = nil
        reloadTask?.cancel()
        reloadTask = nil
        if loading { loading = false }
        if refreshing { refreshing = false }
        if runsLoading { runsLoading = false }
    }

    func setPreset(_ next: StatsRangePreset) {
        guard next != preset else { return }
        if next == .custom {
            let window = statsWindow(preset: preset, customFrom: nil, customTo: nil, now: Date())
            customFrom = statsDateInput(window.from)
            customTo = inclusiveDay(window.to)
        } else {
            customFrom = nil
            customTo = nil
        }
        preset = next
        scheduleReload(resetRuns: true)
    }

    func setCustom(from: Date?, to: Date?) {
        if let from { customFrom = StatsTime.dayString(from) }
        if let to { customTo = StatsTime.dayString(to) }
        preset = .custom
        scheduleReload(resetRuns: true)
    }

    func applyBrush(from: Date, to: Date) {
        let start = min(from, to)
        let end = max(from, to)
        guard end.timeIntervalSince(start) > 60 else { return }
        preset = .custom
        customFrom = StatsTime.string(start)
        customTo = StatsTime.string(end)
        scheduleReload(resetRuns: true)
    }

    func toggleBackend(_ key: String) { toggle(key, in: &backends) }
    func toggleModel(_ key: String) { toggle(key, in: &models) }
    func toggleProject(_ key: String) { toggle(key, in: &projects) }

    func toggleEstimated() {
        includeEstimated.toggle()
        scheduleReload(resetRuns: true)
    }

    func clearFilters() {
        backends = []
        models = []
        projects = []
        includeEstimated = true
        scheduleReload(resetRuns: true)
    }

    func setMetric(_ next: StatsSeriesMetric) {
        guard next != metric else { return }
        metric = next
        refreshSeries()
    }

    func setSplit(_ next: StatsSplit) {
        guard next != split else { return }
        split = next
        refreshSeries()
    }

    func loadMore() {
        guard runsHasMore, !runsLoading, let cursor = nextCursor, let api = workbench.host.api else { return }
        let token = runsGeneration
        let query = filterPairs() + statsPairs([("cursor", cursor), ("limit", Self.pageSize)])
        runsLoading = true
        Task { @MainActor in
            do {
                let page = try await api.statsRuns(query: query)
                guard token == self.runsGeneration else { return }
                let seen = Set(self.runs.map(\.runId))
                self.runs.append(contentsOf: page.rows.filter { !seen.contains($0.runId) })
                self.nextCursor = page.nextCursor
                self.runsHasMore = page.nextCursor?.isEmpty == false
                self.pageCount += 1
                self.runsError = nil
            } catch {
                guard token == self.runsGeneration else { return }
                self.runsError = error.riffetMessage
            }
            if token == self.runsGeneration { self.runsLoading = false }
        }
    }

    func retryRuns() {
        if runs.isEmpty { scheduleReload(resetRuns: true) } else { loadMore() }
    }

    func export(format: String) {
        guard !exporting, let api = workbench.host.api else { return }
        exporting = true
        exportError = nil
        let query = statsPairs(filterItems() + [("format", format)])
        Task { @MainActor in
            defer { self.exporting = false }
            do {
                let file = try await api.exportStats(query: query)
                let panel = NSSavePanel()
                panel.canCreateDirectories = true
                panel.isExtensionHidden = false
                panel.nameFieldStringValue = file.name ?? "riffet-stats-\(StatsTime.dayString(Date())).\(format)"
                panel.allowedContentTypes = [format == "json" ? .json : .commaSeparatedText]
                guard panel.runModal() == .OK, let destination = panel.url else { return }
                try Data(file.text.utf8).write(to: destination, options: .atomic)
            } catch {
                self.exportError = error.riffetMessage
            }
        }
    }

    private func toggle(_ key: String, in list: inout [String]) {
        if let index = list.firstIndex(of: key) { list.remove(at: index) } else { list.append(key) }
        scheduleReload(resetRuns: true)
    }

    private func noteChanged() {
        let wait = 2.0
        let elapsed = Date().timeIntervalSince(lastRefresh)
        if lastRefresh != .distantPast, elapsed < wait {
            guard trailing == nil else { return }
            let delay = wait - elapsed
            trailing = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled else { return }
                self.trailing = nil
                self.scheduleReload(resetRuns: false)
            }
            return
        }
        scheduleReload(resetRuns: false)
    }

    /// A [quiet] read refreshes what is shown without the 更新中 spinner.
    private func scheduleReload(resetRuns: Bool, quiet: Bool = false) {
        lastRefresh = Date()
        loadedAt = .distantPast
        generation += 1
        let ticket = generation
        if resetRuns {
            runsGeneration += 1
            runs = []
            runsHasMore = false
            nextCursor = nil
            pageCount = 0
            runsError = nil
            runsLoading = true
            series = nil
        } else if pageCount <= 1 {
            // Replacing the first page invalidates an in-flight "load more".
            runsGeneration += 1
        }
        reloadTask?.cancel()
        reloadTask = Task { @MainActor in
            await self.load(ticket: ticket, resetRuns: resetRuns, quiet: quiet)
        }
    }

    private func load(ticket: Int, resetRuns: Bool, quiet: Bool) async {
        guard let api = workbench.host.api else {
            error = String(localized: "服务器未连接")
            loading = false
            refreshing = false
            runsLoading = false
            return
        }
        let query = filterPairs()
        if dashboard == nil { loading = true } else if !quiet { refreshing = true }
        let refreshRuns = resetRuns || pageCount <= 1
        if refreshRuns { runsLoading = true }
        let metric = self.metric
        let split = self.split
        let granularity = statsGranularity(preset: preset, customFrom: customFrom, customTo: customTo, now: Date())
        let customSeries = metric != .totalTokens || split != .backend
        seriesGeneration += 1
        let seriesTicket = seriesGeneration

        async let dash = capture { try await api.statsDashboard(query: query) }
        async let lat = capture { try await api.statsLatency(query: query + statsPairs([("dimension", "model")])) }
        async let page = refreshRuns
            ? captureOptional { try await api.statsRuns(query: query + statsPairs([("limit", Self.pageSize)])) }
            : emptyPage()
        async let extra = customSeries
            ? captureOptional { try await api.statsSeries(query: self.seriesQuery(query, metric: metric, split: split, granularity: granularity)) }
            : emptySeries()
        apply(
            ticket: ticket,
            seriesTicket: seriesTicket,
            dash: await dash,
            lat: await lat,
            runsPage: await page,
            seriesResult: await extra,
            refreshRuns: refreshRuns,
            metric: metric,
            split: split
        )
    }

    private func apply(
        ticket: Int,
        seriesTicket: Int,
        dash: Result<StatsDashboard, Error>,
        lat: Result<StatsLatency, Error>,
        runsPage: Result<StatsRunsPage, Error>?,
        seriesResult: Result<StatsSeries, Error>?,
        refreshRuns: Bool,
        metric: StatsSeriesMetric,
        split: StatsSplit
    ) {
        guard ticket == generation, !Task.isCancelled else { return }
        switch dash {
        case let .success(value):
            dashboard = value
            loadedAt = Date()
            error = nil
            if value.series.metric == metric, value.series.split == split, seriesTicket == seriesGeneration { series = nil }
        case let .failure(failure):
            error = failure.riffetMessage
        }
        switch lat {
        case let .success(value):
            latency = value
            latencyError = nil
        case .failure:
            if latency == nil { latencyError = String(localized: "无法加载延迟") }
        }
        if refreshRuns, let runsPage {
            switch runsPage {
            case let .success(page):
                runs = page.rows
                nextCursor = page.nextCursor
                runsHasMore = page.nextCursor?.isEmpty == false
                pageCount = 1
                runsError = nil
            case let .failure(failure):
                runsError = failure.riffetMessage
            }
            runsLoading = false
        }
        if seriesTicket == seriesGeneration, let seriesResult {
            if case let .success(value) = seriesResult, self.metric == metric, self.split == split {
                series = value
            }
        }
        seriesStale = displayedSeries.map { $0.metric != self.metric || $0.split != self.split } ?? false
        loading = false
        refreshing = false
    }

    private func refreshSeries() {
        seriesStale = displayedSeries.map { $0.metric != self.metric || $0.split != self.split } ?? true
        guard let api = workbench.host.api else { return }
        seriesGeneration += 1
        let ticket = seriesGeneration
        let metric = self.metric
        let split = self.split
        if dashboard?.series.metric == metric, dashboard?.series.split == split {
            series = nil
            seriesStale = false
            return
        }
        Task { @MainActor in
            await self.loadSeries(api: api, ticket: ticket, metric: metric, split: split)
        }
    }

    private func loadSeries(api: RiffetApi, ticket: Int, metric: StatsSeriesMetric, split: StatsSplit) async {
        let query = seriesQuery(filterPairs(), metric: metric, split: split, granularity: statsGranularity(preset: preset, customFrom: customFrom, customTo: customTo, now: Date()))
        do {
            let value = try await api.statsSeries(query: query)
            guard ticket == seriesGeneration, self.metric == metric, self.split == split else { return }
            series = value
            seriesStale = false
        } catch {
            guard ticket == seriesGeneration else { return }
            seriesStale = displayedSeries.map { $0.metric != self.metric || $0.split != self.split } ?? false
        }
    }

    private func filterItems() -> [(String, String)] {
        let window = statsWindow(preset: preset, customFrom: customFrom, customTo: customTo, now: Date())
        var items = [("from", window.from), ("to", window.to), ("tz", TimeZone.current.identifier)]
        items += backends.map { ("backend", $0) }
        items += models.map { ("model", $0) }
        items += projects.map { ("project", $0) }
        if !includeEstimated { items.append(("includeEstimated", "false")) }
        return items
    }

    private func filterPairs() -> [KotlinPair<NSString, NSString>] { statsPairs(filterItems()) }

    private func seriesQuery(_ query: [KotlinPair<NSString, NSString>], metric: StatsSeriesMetric, split: StatsSplit, granularity: StatsGranularity) -> [KotlinPair<NSString, NSString>] {
        query + statsPairs([("metric", metric.wire()), ("granularity", granularity.wire()), ("split", split.wire())])
    }

    // MARK: Derived chart data

    private func deriveUsage() {
        let shown = displayedSeries
        guard shown !== usageSource else { return }
        usageSource = shown
        usageData = shown.map(usageChartData)
    }

    private func deriveDashboard() {
        deriveUsage()
        calendarDays = dashboard?.heatmap.calendar.sorted { $0.date < $1.date } ?? []
        weekHours = dashboard.flatMap { weekGrid($0.heatmap) }
        toolRows = Array((dashboard?.tools.rows ?? []).sorted { $0.count > $1.count }.prefix(8))
        deriveRank()
    }

    private func deriveRank() {
        rankedModels = Array(sortedBreakdown(dashboard?.models.rows ?? [], rank: rank).prefix(8))
    }

    private func deriveLatency() {
        let rows = (latency?.rows ?? []).filter { latencySample($0, .speed) != nil }
        speedWindows = Array(Set(rows.flatMap { $0.windows.map(\.name) })).sorted()
    }

    private func inclusiveDay(_ exclusiveEnd: String) -> String {
        guard let date = StatsTime.date(exclusiveEnd) else { return statsDateInput(exclusiveEnd) }
        return StatsTime.dayString(date.addingTimeInterval(-0.001))
    }
}

private func capture<T>(_ work: () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await work()) }
    catch is CancellationError { return .failure(CancellationError()) }
    catch { return .failure(error) }
}

private func captureOptional<T>(_ work: () async throws -> T) async -> Result<T, Error>? {
    await capture(work)
}

private func emptyPage() async -> Result<StatsRunsPage, Error>? { nil }

private func emptySeries() async -> Result<StatsSeries, Error>? { nil }
