import SwiftUI
import Charts
import RiffetKit

struct NativeStatsView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var selection = NativeStatsSelection()
    @State private var metric = NativeStatsMetric.totalTokens
    @State private var split = NativeStatsSplit.backend
    @State private var rank = NativeStatsRank.tokens
    @State private var latencyMetric = NativeStatsLatencyMetric.ttft
    @State private var rangeOpen = false
    @State private var metricOpen = false
    @State private var filtersOpen = false
    @State private var dashboard: StatsDashboard?
    @State private var latency: StatsLatency?
    @State private var trend: StatsSeries?
    @State private var trendPoints: [NativeStatsPlotPoint] = []
    @State private var calendarCells: [NativeStatsCalendarCell] = []
    @State private var hourCells: [NativeStatsHourCell] = []
    @State private var runs: [StatsRunRow] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var loadingMore = false
    @State private var trendLoading = false
    @State private var error: String?
    @State private var runsError: String?
    @State private var trendError: String?
    @State private var exporting = false
    @State private var exportURL: URL?
    @State private var showShare = false
    @State private var gate = NativeStatsRequestGate()
    @State private var appliedStamp: NativeStatsRequestStamp?
    @State private var appliedItems: [URLQueryItem] = []
    @State private var appliedTrendKey = ""
    @State private var pageRequest = UUID()
    private var filterKey: String { selection.key }
    private var trendKey: String { "\(filterKey)|\(appliedStamp?.id.uuidString ?? "")|\(metric.rawValue)|\(split.rawValue)" }
    private var currentData: Bool { appliedStamp?.filterKey == filterKey }

    var body: some View {
        RiffetList {
            SettingsChipRow {
                RiffetChipButton(title: selection.range.label) { rangeOpen = true }.accessibilityIdentifier("statsRange")
                RiffetChipButton(title: metric.label) { metricOpen = true }.accessibilityIdentifier("statsTrendMetric")
            }
            RiffetNotice.section(.error, error, actionTitle: String(localized: "重新读取", bundle: .riffet)) { Task { await load() } }
            if let dashboard, !isEmpty(dashboard) {
                overview(dashboard)
                trendSection
                statsSection(String(localized: "每日活跃", bundle: .riffet)) { NativeStatsCalendarHeatmap(cells: calendarCells) }
                ranking(dashboard.models)
                latencySection
                statsSection(String(localized: "活跃时段", bundle: .riffet)) { NativeStatsWeekHeatmap(cells: hourCells) }
                reliability(dashboard.backends)
                breakdown(String(localized: "按 Agent", bundle: .riffet), dashboard.backends)
                breakdown(String(localized: "工具调用", bundle: .riffet), dashboard.tools)
                runsSection
                Section {
                    Text("当前包含的估算输出为 \(dashboard.summary.current.tokens.estimatedOutput.formatted()) Token。时区：\(dashboard.filter.tz)。更新于 \(displayDate(dashboard.generatedAt, time: true))。")
                        .riffetFont(.caption).foregroundStyle(palette.fg3)
                }
            }
        }
        // A first read fills the empty page; a later one keeps the last figures and spins in the bar.
        .overlay {
            if loading && dashboard == nil { ProgressView() }
            else if let dashboard, isEmpty(dashboard), !loading { ContentUnavailableView(String(localized: "没有用量记录", bundle: .riffet), systemImage: "chart.bar") }
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if (loading && dashboard != nil) || exporting { ProgressView() }
                Button { filtersOpen = true } label: {
                    Image(systemName: selection.activeCount == 0 ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel(selection.activeCount == 0 ? String(localized: "筛选", bundle: .riffet) : String(localized: "筛选 · \(selection.activeCount) 项", bundle: .riffet))
                .accessibilityIdentifier("statsFilters")
                Menu {
                    Button("导出 CSV", systemImage: "square.and.arrow.up") { Task { await export("csv") } }.accessibilityIdentifier("statsExportCSV")
                    Button("导出 JSON", systemImage: "square.and.arrow.up") { Task { await export("json") } }.accessibilityIdentifier("statsExportJSON")
                } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel(String(localized: "更多", bundle: .riffet))
                .disabled(exporting || loading || !currentData || appliedItems.isEmpty)
            }
        }
        .accessibilityIdentifier("statsList")
        .navigationTitle(String(localized: "使用统计", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task(id: filterKey) { await load() }
        .task(id: trendKey) { await loadTrend() }
        .refreshable { await load() }
        .onChange(of: selection.range) { _, range in if range == .custom { filtersOpen = true } }
        .sheet(isPresented: $rangeOpen) {
            RiffetPickerSheet(title: String(localized: "时间范围", bundle: .riffet), options: NativeStatsRange.allCases.map { .init(id: $0, title: $0.label) }, selection: $selection.range)
        }
        .sheet(isPresented: $metricOpen) {
            RiffetPickerSheet(title: String(localized: "指标", bundle: .riffet), options: NativeStatsMetric.allCases.map { .init(id: $0, title: $0.label) }, selection: $metric)
        }
        .sheet(isPresented: $filtersOpen) {
            NativeStatsFiltersSheet(selection: $selection, projects: dashboard?.options.projects ?? [], backends: dashboard?.options.backends ?? [], models: dashboard?.options.models ?? [])
        }
        .sheet(isPresented: $showShare) { if let exportURL { NativeShareSheet(items: [exportURL]) } }
    }

    /// Nothing happened in the range: one empty state instead of a page of zeros.
    private func isEmpty(_ value: StatsDashboard) -> Bool {
        let totals = value.summary.current
        return totals.runs == 0 && totals.sessions == 0 && totals.totalTokens == 0
    }
    private func overview(_ value: StatsDashboard) -> some View {
        let totals = value.summary.current, previous = value.summary.previous
        return statsSection(String(localized: "\(displayDate(value.filter.from)) 至 \(inclusiveEnd(value.filter.to))", bundle: .riffet)) {
            kpi(String(localized: "Token 总量", bundle: .riffet), value: totals.totalTokens.formatted(), current: Double(totals.totalTokens), previous: Double(previous.totalTokens))
                .accessibilityIdentifier("statsOverview")
            kpi(String(localized: "轮次", bundle: .riffet), value: totals.runs.formatted(), current: Double(totals.runs), previous: Double(previous.runs))
            kpi(String(localized: "会话", bundle: .riffet), value: totals.sessions.formatted(), current: Double(totals.sessions), previous: Double(previous.sessions))
            kpi(String(localized: "活跃天数", bundle: .riffet), value: totals.activeDays.formatted(), current: Double(totals.activeDays), previous: Double(previous.activeDays))
            LabeledContent("输入 Token", value: totals.tokens.input.map { $0.int64Value.formatted() } ?? String(localized: "未报告", bundle: .riffet))
            LabeledContent("输出 Token", value: totals.tokens.output.map { $0.int64Value.formatted() } ?? String(localized: "未报告", bundle: .riffet))
            LabeledContent("缓存读取", value: totals.tokens.cacheRead.map { $0.int64Value.formatted() } ?? String(localized: "未报告", bundle: .riffet))
            LabeledContent("缓存写入", value: totals.tokens.cacheWrite.map { $0.int64Value.formatted() } ?? String(localized: "未报告", bundle: .riffet))
            LabeledContent("缓存命中率", value: totals.cacheHitRate.map { $0.doubleValue.formatted(.percent.precision(.fractionLength(1))) } ?? String(localized: "未报告", bundle: .riffet))
            LabeledContent("连续活跃", value: String(localized: "\(value.summary.streakDays) 天", bundle: .riffet))
            LabeledContent("工具调用 / 子 Agent", value: "\(totals.toolCalls) / \(totals.subagents)")
            if let duration = totals.durationMs { LabeledContent("整轮耗时 p50", value: seconds(duration.p50)) }
            if let speed = totals.outputTokensPerSecond { LabeledContent("输出速度 p50", value: speed.p50.formatted(.number.precision(.fractionLength(1))) + " Token/s") }
        }
    }
    private func kpi(_ title: String, value: String, current: Double, previous: Double) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title); Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(value).monospacedDigit()
                if selection.range != .all { Text(delta(current, previous)).riffetFont(.caption).foregroundStyle(palette.fg3) }
            }
        }.accessibilityElement(children: .combine)
    }
    private var trendSection: some View {
        statsSection(String(localized: "用量趋势", bundle: .riffet)) {
            Picker("分组", selection: $split) { ForEach(NativeStatsSplit.allCases) { Text($0.label).tag($0) } }.accessibilityIdentifier("statsTrendSplit")
            if trendLoading { ProgressView().frame(maxWidth: .infinity) }
            if appliedTrendKey == trendKey, let trend {
                if trendPoints.isEmpty { Text("此范围没有这项指标的报告。").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
                else {
                    NativeStatsTrendChart(points: trendPoints, unit: metric.unit, granularity: trend.granularity.name)
                    DisclosureGroup("每期数据 · \(trend.points.count) 个区间") {
                        ForEach(Array(trend.points.enumerated()), id: \.offset) { _, point in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(displayDate(point.start, time: trend.granularity.name == "HOUR")).riffetFont(.label)
                                ForEach(trend.keys, id: \.key) { key in
                                    if let amount = point.values[key.key] { LabeledContent(key.label, value: metric.formatted(amount.doubleValue)).riffetFont(.caption) }
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                }
            }
            if let trendError { RiffetNotice(kind: .error, message: trendError, actionTitle: String(localized: "重试", bundle: .riffet)) { Task { await loadTrend() } } }
        }
    }
    private func ranking(_ value: StatsBreakdown) -> some View {
        let ordered = value.rows.sorted { (rank.amount($0) ?? -1) > (rank.amount($1) ?? -1) }
        let maximum = ordered.compactMap { rank.amount($0) }.max() ?? 0
        return statsSection(String(localized: "模型排行", bundle: .riffet)) {
            Picker("排序指标", selection: $rank) { ForEach(NativeStatsRank.allCases) { Text($0.label).tag($0) } }
            if ordered.isEmpty { Text("没有模型记录").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
            ForEach(ordered.prefix(8), id: \.key) { row in
                VStack(alignment: .leading, spacing: 5) {
                    LabeledContent(row.label, value: rank.formatted(row))
                    if let amount = rank.amount(row), maximum > 0 { ProgressView(value: amount, total: maximum).tint(palette.accent) }
                }.padding(.vertical, 3)
            }
            if ordered.count > 8 { DisclosureGroup("全部 \(ordered.count) 个模型") { ForEach(ordered, id: \.key) { row in LabeledContent(row.label, value: rank.formatted(row)).riffetFont(.caption) } } }
        }
    }
    private var latencySection: some View {
        statsSection(String(localized: "延迟与速度 · 按模型", bundle: .riffet)) {
            Picker("指标", selection: $latencyMetric) { ForEach(NativeStatsLatencyMetric.allCases) { Text($0.label).tag($0) } }
            if let latency {
                let measured = latency.rows.filter { latencyMetric.sample($0) != nil }
                if measured.isEmpty { Text("这些模型没有此项测量；未报告不等于 0。").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
                else { NativeStatsLatencyChart(rows: measured, metric: latencyMetric) }
                DisclosureGroup("查看分位数与样本") {
                    ForEach(measured, id: \.key) { row in
                        if let sample = latencyMetric.sample(row) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(row.label)
                                Text("p50 \(latencyMetric.format(sample.p50)) · p90 \(latencyMetric.format(sample.p90)) · p99 \(latencyMetric.format(sample.p99))")
                                    .riffetFont(.caption).foregroundStyle(palette.fg3)
                                Text("\(sample.samples) 个测量样本").riffetFont(.caption).foregroundStyle(palette.fg3)
                            }
                        }
                    }
                }
            } else if loading { ProgressView().frame(maxWidth: .infinity) }
            else { Text("没有可用测量").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
        }
    }
    private func reliability(_ value: StatsBreakdown) -> some View {
        statsSection(String(localized: "轮次结果", bundle: .riffet)) {
            NativeStatsReliabilityChart(rows: value.rows)
            ForEach(value.rows, id: \.key) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.label)
                    Text("完成 \(row.states.completed) · 失败 \(row.states.failed) · 取消 \(row.states.cancelled) · 中断 \(row.states.interrupted)")
                        .riffetFont(.caption).foregroundStyle(palette.fg3)
                }
            }
        }
    }
    private func breakdown(_ title: String, _ value: StatsBreakdown) -> some View {
        statsSection(title) {
            if value.rows.isEmpty { Text("没有数据").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
            ForEach(value.rows.prefix(12), id: \.key) { row in breakdownRow(row, tools: title == String(localized: "工具调用", bundle: .riffet)) }
            if value.rows.count > 12 { DisclosureGroup("全部 \(value.rows.count) 项") { ForEach(value.rows, id: \.key) { row in breakdownRow(row, tools: title == String(localized: "工具调用", bundle: .riffet)) } } }
        }
    }
    private func breakdownRow(_ row: StatsBreakdownRow, tools: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.label)
            Text("\(row.count) 次 · \(row.totalTokens.formatted()) Token · \(row.share.formatted(.percent.precision(.fractionLength(1))))").riffetFont(.caption).foregroundStyle(palette.fg3)
            if tools { Text(String(localized: "失败调用：\(row.failed.map { $0.int64Value.formatted() } ?? String(localized: "未报告", bundle: .riffet))", bundle: .riffet)).riffetFont(.caption).foregroundStyle(palette.fg3) }
        }
    }
    private var runsSection: some View {
        statsSection(String(localized: "最近轮次", bundle: .riffet)) {
            if currentData {
                ForEach(runs, id: \.runId) { run in
                    NavigationLink { ConversationView(workbench: workbench, sessionID: run.sessionId) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(run.sessionTitle).foregroundStyle(palette.fg)
                            Text("\(run.projectName) · \(run.backendId.name) · \(run.model ?? String(localized: "默认模型", bundle: .riffet))").riffetFont(.caption).foregroundStyle(palette.fg3)
                            Text("\(run.totalTokens.formatted()) Token · \(displayDate(run.createdAt, time: true))").riffetFont(.caption).foregroundStyle(palette.fg3)
                        }
                    }
                }
                if runs.isEmpty && !loading && runsError == nil { Text("此范围没有轮次").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
            }
            if (nextCursor != nil || runsError != nil) && currentData {
                if let runsError {
                    RiffetNotice(kind: .error, message: runsError, actionTitle: String(localized: "重试", bundle: .riffet)) { Task { await more() } }
                } else {
                    // Reaching the end of the list reads the next page.
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowBackground(Color.clear)
                        // Asked again whenever the first page finishes or a page moves the cursor, while the row stays in view.
                        .task(id: "\(loading)|\(nextCursor ?? "")") { await more() }
                        .accessibilityIdentifier("statsRunsMore")
                }
            }
        }
    }

    private func load() async {
        guard let api = workbench.api else { error = String(localized: "未连接服务器", bundle: .riffet); return }
        let stamp = gate.begin(filterKey)
        loading = true; error = nil; runsError = nil
        pageRequest = UUID(); loadingMore = false
        defer { if gate.accepts(stamp, key: filterKey) { loading = false } }
        do {
            let filter = try selection.query()
            let value = try await api.statsDashboard(query: pairs(filter))
            guard gate.accepts(stamp, key: filterKey), !Task.isCancelled else { return }
            dashboard = value; appliedItems = filter; appliedStamp = stamp; runs = []; nextCursor = nil; latency = nil
            calendarCells = value.heatmap.calendar.sorted { $0.date < $1.date }.map { NativeStatsCalendarCell(date: $0.date, runs: $0.runs, tokens: $0.totalTokens) }
            hourCells = NativeStatsHourCell.make(value.heatmap.weekHour)
            do {
                let page = try await api.statsRuns(query: pairs(filter + [URLQueryItem(name: "limit", value: "30")]))
                guard gate.accepts(stamp, key: filterKey), !Task.isCancelled else { return }
                runs = page.rows; nextCursor = page.nextCursor
            } catch { if gate.accepts(stamp, key: filterKey), !Task.isCancelled { runsError = error.riffetMessage } }
            do {
                let value = try await api.statsLatency(query: pairs(filter + [URLQueryItem(name: "dimension", value: "model")]))
                guard gate.accepts(stamp, key: filterKey), !Task.isCancelled else { return }
                latency = value
            } catch { if gate.accepts(stamp, key: filterKey), !Task.isCancelled { self.error = String(localized: "延迟统计：\(error.riffetMessage)", bundle: .riffet) } }
        } catch {
            if gate.accepts(stamp, key: filterKey), !Task.isCancelled { self.error = error.riffetMessage }
        }
    }
    private func loadTrend() async {
        guard let api = workbench.api, let stamp = appliedStamp, stamp.filterKey == filterKey, !appliedItems.isEmpty else { trendLoading = false; return }
        let requested = trendKey, filter = appliedItems, chosenMetric = metric
        trendLoading = true; trendError = nil
        defer { if requested == trendKey { trendLoading = false } }
        do {
            let granularity = try selection.granularity()
            let query = filter + [URLQueryItem(name: "metric", value: metric.rawValue), URLQueryItem(name: "split", value: split.rawValue), URLQueryItem(name: "granularity", value: granularity)]
            let value = try await api.statsSeries(query: pairs(query))
            guard requested == trendKey, appliedStamp == stamp, stamp.filterKey == filterKey, !Task.isCancelled else { return }
            trend = value; trendPoints = NativeStatsPlotPoint.make(value, metric: chosenMetric); appliedTrendKey = requested
        } catch { if requested == trendKey, !Task.isCancelled { trendError = error.riffetMessage } }
    }
    private func more() async {
        guard !loading, !loadingMore, let api = workbench.api, let stamp = appliedStamp, stamp.filterKey == filterKey else { return }
        let request = UUID(); pageRequest = request; loadingMore = true
        defer { if pageRequest == request { loadingMore = false } }
        var query = appliedItems + [URLQueryItem(name: "limit", value: "30")]
        if let nextCursor { query.append(URLQueryItem(name: "cursor", value: nextCursor)) }
        do {
            let page = try await api.statsRuns(query: pairs(query))
            guard pageRequest == request, appliedStamp == stamp, stamp.filterKey == filterKey, !Task.isCancelled else { return }
            let known = Set(runs.map(\.runId)); runs += page.rows.filter { !known.contains($0.runId) }; nextCursor = page.nextCursor; runsError = nil
        } catch { if pageRequest == request, appliedStamp == stamp, stamp.filterKey == filterKey, !Task.isCancelled { runsError = error.riffetMessage } }
    }
    private func export(_ format: String) async {
        guard !exporting, !loading, currentData, let stamp = appliedStamp else { return }
        let filter = appliedItems
        guard let url = workbench.resources.endpoint("/api/stats/export", query: filter + [URLQueryItem(name: "format", value: format)]) else { return }
        exporting = true; defer { exporting = false }
        do {
            let file = try await workbench.resources.file(for: url, name: "riffet-stats.\(format)")
            guard appliedStamp == stamp, stamp.filterKey == filterKey, !Task.isCancelled else { return }
            exportURL = file; showShare = true; error = nil
        } catch { if appliedStamp == stamp, stamp.filterKey == filterKey { self.error = error.riffetMessage } }
    }
    private func pairs(_ items: [URLQueryItem]) -> [KotlinPair<NSString, NSString>] { items.map { KotlinPair(first: $0.name as NSString, second: ($0.value ?? "") as NSString) } }
    private func seconds(_ value: Double) -> String { (value / 1000).formatted(.number.precision(.fractionLength(2))) + " " + String(localized: "秒", bundle: .riffet) }
    private func displayDate(_ value: String, time: Bool = false) -> String {
        guard let date = NativeStatsPlotPoint.date(value) else { return value }
        return time ? date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale)) : date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted).locale(AppLocalization.shared.locale))
    }
    private func inclusiveEnd(_ value: String) -> String { NativeStatsPlotPoint.date(value).map { $0.addingTimeInterval(-1).formatted(Date.FormatStyle(date: .abbreviated, time: .omitted).locale(AppLocalization.shared.locale)) } ?? value }
    private func delta(_ current: Double, _ previous: Double) -> String {
        if previous == 0 { return current == 0 ? String(localized: "较上期持平", bundle: .riffet) : String(localized: "较上期新增", bundle: .riffet) }
        let change = (current - previous) / previous
        return String(localized: "较上期 \((change > 0 ? "+" : "") + change.formatted(.percent.precision(.fractionLength(1))))", bundle: .riffet)
    }
}

/// A section with the app's title style; the dashboard has a dozen.
private func statsSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    Section { content() } header: { RiffetSectionTitle(title) }
}

private enum NativeStatsFilterKind: String, Identifiable {
    case projects, backends, models
    var id: String { rawValue }
    var label: String { self == .projects ? String(localized: "项目", bundle: .riffet) : self == .backends ? "Agent" : String(localized: "模型", bundle: .riffet) }
}

/// The detailed filters (project, agent, model, call kind, archived, estimated, a custom range). Done
/// applies them together; Cancel keeps what was set.
private struct NativeStatsFiltersSheet: View {
    @Binding var selection: NativeStatsSelection
    let projects: [StatsKeyInfo]
    let backends: [StatsKeyInfo]
    let models: [StatsKeyInfo]
    @Environment(\.dismiss) private var dismiss
    @State private var draft: NativeStatsSelection

    init(selection: Binding<NativeStatsSelection>, projects: [StatsKeyInfo], backends: [StatsKeyInfo], models: [StatsKeyInfo]) {
        _selection = selection; self.projects = projects; self.backends = backends; self.models = models
        _draft = State(initialValue: selection.wrappedValue)
    }

    var body: some View {
        NavigationStack {
            RiffetList {
                if draft.range == .custom {
                    Section {
                        DatePicker("开始日期", selection: $draft.from, in: ...draft.to, displayedComponents: .date).accessibilityIdentifier("statsCustomStart")
                        DatePicker("结束日期", selection: $draft.to, in: draft.from...Date(), displayedComponents: .date).accessibilityIdentifier("statsCustomEnd")
                    }
                }
                Section {
                    filterRow(.projects, options: projects, values: $draft.projects)
                    filterRow(.backends, options: backends, values: $draft.backends)
                    filterRow(.models, options: models, values: $draft.models)
                    Picker("调用类型", selection: $draft.agentKind) { Text("全部").tag("all"); Text("主 Agent").tag("main"); Text("子 Agent").tag("subagent") }
                    Toggle("包含已归档会话", isOn: $draft.includeArchived)
                    Toggle("包含估算 Token", isOn: $draft.includeEstimated)
                }
                if draft.activeCount > 0 {
                    Section {
                        RiffetActionRow("清除筛选") {
                            draft.projects = []; draft.backends = []; draft.models = []; draft.agentKind = "all"; draft.includeArchived = true; draft.includeEstimated = true
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "筛选", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { selection = draft; dismiss() } }
            }
        }
        .presentationDetents([.large])
    }

    private func filterRow(_ kind: NativeStatsFilterKind, options: [StatsKeyInfo], values: Binding<Set<String>>) -> some View {
        let chosen = values.wrappedValue
        let value = chosen.isEmpty ? String(localized: "全部", bundle: .riffet) : chosen.count == 1 ? options.first(where: { chosen.contains($0.key) })?.label ?? chosen.first! : String(localized: "已选 \(chosen.count) 项", bundle: .riffet)
        return NavigationLink { NativeStatsFilterPage(title: kind.label, options: options, selected: values) } label: {
            SettingsRowLabel(title: kind.label, value: value)
        }
        .accessibilityIdentifier("statsFilter.\(kind.rawValue)")
    }
}

private struct NativeStatsFilterPage: View {
    let title: String
    let options: [StatsKeyInfo]
    @Binding var selected: Set<String>
    @State private var search = ""
    var body: some View {
        RiffetList {
            Section { Button("不限\(title)") { selected = [] } } footer: { Text("最多选择 100 项。") }
            ForEach(options.filter { search.isEmpty || $0.label.localizedCaseInsensitiveContains(search) }, id: \.key) { item in
                SettingsCheckRow(title: item.label, selected: selected.contains(item.key)) {
                    if !selected.insert(item.key).inserted { selected.remove(item.key) }
                }
                .disabled(!selected.contains(item.key) && selected.count >= NativeStatsSelection.maximumSelections)
                .accessibilityIdentifier("statsFilterChoice.\(item.key)")
            }
        }
        .overlay { if options.isEmpty { ContentUnavailableView("没有可筛选的记录", systemImage: "line.3.horizontal.decrease") } }
        .navigationTitle(String(localized: "选择\(title)", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: String(localized: "搜索\(title)", bundle: .riffet))
    }
}
private enum NativeStatsRank: String, CaseIterable, Identifiable {
    case tokens, runs, speed
    var id: String { rawValue }
    var label: String { self == .tokens ? "Token" : self == .runs ? String(localized: "轮次", bundle: .riffet) : String(localized: "输出速度", bundle: .riffet) }
    func amount(_ row: StatsBreakdownRow) -> Double? { self == .tokens ? Double(row.totalTokens) : self == .runs ? Double(row.count) : row.outputTokensPerSecond?.p50 }
    func formatted(_ row: StatsBreakdownRow) -> String { amount(row).map { $0.formatted(.number.precision(.fractionLength(self == .speed ? 1 : 0))) + (self == .speed ? " Token/s" : "") } ?? String(localized: "未报告", bundle: .riffet) }
}
private enum NativeStatsLatencyMetric: String, CaseIterable, Identifiable {
    case ttft, duration, speed
    var id: String { rawValue }
    var label: String { self == .ttft ? String(localized: "首字延迟", bundle: .riffet) : self == .duration ? String(localized: "整轮耗时", bundle: .riffet) : String(localized: "输出速度", bundle: .riffet) }
    func sample(_ row: StatsLatencyRow) -> StatsPercentiles? { self == .ttft ? row.ttftMs : self == .duration ? row.durationMs : row.outputTokensPerSecond }
    func plotted(_ value: Double) -> Double { self == .speed ? value : value / 1000 }
    func format(_ value: Double) -> String { plotted(value).formatted(.number.precision(.fractionLength(self == .speed ? 1 : 2))) + (self == .speed ? " Token/s" : " " + String(localized: "秒", bundle: .riffet)) }
}
private struct NativeStatsPlotPoint: Identifiable {
    let id: String, start: Date, series: String
    let amount: Double
    static func date(_ value: String) -> Date? { ServerTime.date(value) }
    static func make(_ series: StatsSeries, metric: NativeStatsMetric) -> [Self] {
        var output: [Self] = []
        for point in series.points {
            guard let date = ServerTime.date(point.start) else { continue }
            for key in series.keys {
                if let value = point.values[key.key], value.doubleValue.isFinite {
                    output.append(Self(id: point.start + "|" + key.key, start: date, series: key.label, amount: metric.plotted(value.doubleValue)))
                }
            }
        }
        return output
    }
}
private struct NativeStatsTrendChart: View {
    @Environment(\.palette) private var palette
    let points: [NativeStatsPlotPoint]
    let unit: String
    let granularity: String
    @State private var selected: Date?
    var body: some View {
        Chart(points) { point in
            BarMark(x: .value(String(localized: "时间", bundle: .riffet), point.start), y: .value(unit, point.amount)).foregroundStyle(by: .value(String(localized: "分组", bundle: .riffet), point.series))
                .accessibilityLabel(String(localized: "\(point.start.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale)))，\(point.series)", bundle: .riffet))
                .accessibilityValue(point.amount.formatted(.number.precision(.fractionLength(2))) + " " + unit)
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let date = value.as(Date.self) { Text(axisDate(date)) }
                }
            }
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let amount = value.as(Double.self) {
                        Text(amount.formatted(.number.notation(.compactName).precision(.fractionLength(0...1))))
                    }
                }
            }
        }
        .chartForegroundStyleScale(range: [palette.chart1, palette.chart2, palette.chart3, palette.chart4, palette.chart5, palette.chart6, palette.chart7, palette.chart8])
        .chartLegend(position: .bottom).chartXSelection(value: $selected).frame(height: 240).accessibilityIdentifier("statsTrendChart")
        if let selected, let nearest = points.min(by: { abs($0.start.timeIntervalSince(selected)) < abs($1.start.timeIntervalSince(selected)) }) {
            VStack(alignment: .leading, spacing: 4) {
                Text(nearest.start.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale))).riffetFont(.caption, weight: .medium)
                ForEach(points.filter { $0.start == nearest.start }) { point in
                    LabeledContent(point.series, value: point.amount.formatted(.number.precision(.fractionLength(unit == String(localized: "秒", bundle: .riffet) ? 2 : 0))) + " " + unit).riffetFont(.caption)
                }
            }.accessibilityElement(children: .combine)
        }
    }
    private func axisDate(_ date: Date) -> String {
        let calendar = NativeStatsSelection.calendar
        if granularity == "HOUR" {
            return String(format: "%02d:%02d", calendar.component(.hour, from: date), calendar.component(.minute, from: date))
        }
        let month = calendar.component(.month, from: date)
        if granularity == "MONTH" { return "\(calendar.component(.year, from: date))/\(month)" }
        return "\(month)/\(calendar.component(.day, from: date))"
    }
}
private struct NativeStatsLatencyChart: View {
    @Environment(\.palette) private var palette
    let rows: [StatsLatencyRow]
    let metric: NativeStatsLatencyMetric
    var body: some View {
        Chart {
            ForEach(rows.prefix(12), id: \.key) { row in
                if let sample = metric.sample(row) {
                    BarMark(x: .value(metric.label, metric.plotted(sample.p50)), y: .value(String(localized: "模型", bundle: .riffet), row.label)).foregroundStyle(palette.accent.opacity(0.6))
                    PointMark(x: .value("p90", metric.plotted(sample.p90)), y: .value(String(localized: "模型", bundle: .riffet), row.label)).foregroundStyle(palette.fg)
                    PointMark(x: .value("p99", metric.plotted(sample.p99)), y: .value(String(localized: "模型", bundle: .riffet), row.label)).symbol(.diamond).foregroundStyle(palette.fg2)
                }
            }
        }.frame(height: CGFloat(max(1, min(rows.count, 12))) * 42 + 32)
        Text("柱形 p50 · 圆点 p90 · 菱形 p99。").riffetFont(.caption).foregroundStyle(palette.fg3)
    }
}
private struct NativeStatsReliabilityChart: View {
    @Environment(\.palette) private var palette
    let rows: [StatsBreakdownRow]
    var body: some View {
        Chart {
            ForEach(rows, id: \.key) { row in
                BarMark(x: .value(String(localized: "轮次", bundle: .riffet), row.states.completed), y: .value("Agent", row.label)).foregroundStyle(by: .value(String(localized: "结果", bundle: .riffet), String(localized: "完成", bundle: .riffet)))
                BarMark(x: .value(String(localized: "轮次", bundle: .riffet), row.states.failed), y: .value("Agent", row.label)).foregroundStyle(by: .value(String(localized: "结果", bundle: .riffet), String(localized: "失败", bundle: .riffet)))
                BarMark(x: .value(String(localized: "轮次", bundle: .riffet), row.states.cancelled), y: .value("Agent", row.label)).foregroundStyle(by: .value(String(localized: "结果", bundle: .riffet), String(localized: "取消", bundle: .riffet)))
                BarMark(x: .value(String(localized: "轮次", bundle: .riffet), row.states.interrupted), y: .value("Agent", row.label)).foregroundStyle(by: .value(String(localized: "结果", bundle: .riffet), String(localized: "中断", bundle: .riffet)))
            }
        }.chartForegroundStyleScale([
            String(localized: "完成", bundle: .riffet): palette.success, String(localized: "失败", bundle: .riffet): palette.danger,
            String(localized: "取消", bundle: .riffet): palette.fg3, String(localized: "中断", bundle: .riffet): palette.warning,
        ])
        .chartLegend(position: .bottom).frame(height: CGFloat(max(1, rows.count)) * 38 + 48)
    }
}
private struct NativeStatsCalendarCell: Identifiable {
    let date: String
    let runs: Int64, tokens: Int64
    var id: String { date }
}
private struct NativeStatsCalendarHeatmap: View {
    @Environment(\.palette) private var palette
    let cells: [NativeStatsCalendarCell]
    @State private var selected: Int?
    private var maximum: Int64 { cells.map(\.runs).max() ?? 0 }
    var body: some View {
        let maximum = self.maximum
        if cells.isEmpty { Text("此范围没有每日记录").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
        else {
            HStack { Text(cells.first?.date ?? ""); Spacer(); Text(cells.last?.date ?? "") }.riffetFont(.caption).foregroundStyle(palette.fg3)
            ScrollView(.horizontal) {
                LazyHStack(spacing: 3) {
                    ForEach(cells.indices, id: \.self) { index in
                        let day = cells[index]
                        Button { selected = index } label: {
                            VStack(spacing: 5) {
                                RoundedRectangle(cornerRadius: 3).fill(heatColor(day.runs, maximum: maximum, palette)).frame(width: 24, height: 24)
                                    .overlay { if selected == index { RoundedRectangle(cornerRadius: 3).stroke(palette.fg, lineWidth: 2) } }
                                Text(String(day.date.suffix(2))).riffetFont(.caption).foregroundStyle(palette.fg3)
                            }.frame(minWidth: RiffetMetrics.hitTarget, minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("\(day.date)，\(day.runs) 轮，\(day.tokens) Token")
                    }
                }.padding(.vertical, 3)
            }.defaultScrollAnchor(.trailing).accessibilityIdentifier("statsCalendarHeatmap")
            if let selected, cells.indices.contains(selected) {
                let day = cells[selected]
                Text("\(day.date) · \(day.runs.formatted()) 轮 · \(day.tokens.formatted()) Token").riffetFont(.caption).monospacedDigit()
            }
        }
    }
}
private struct NativeStatsHourCell: Identifiable {
    let weekday: Int, hour: Int
    let runs: Int64
    var id: Int { weekday * 24 + hour }
    static var weekdays: [String] { [String(localized: "一", bundle: .riffet), String(localized: "二", bundle: .riffet), String(localized: "三", bundle: .riffet), String(localized: "四", bundle: .riffet), String(localized: "五", bundle: .riffet), String(localized: "六", bundle: .riffet), String(localized: "日", bundle: .riffet)] }
    static func weekdayLabel(_ index: Int) -> String {
        [String(localized: "周一", bundle: .riffet), String(localized: "周二", bundle: .riffet), String(localized: "周三", bundle: .riffet), String(localized: "周四", bundle: .riffet), String(localized: "周五", bundle: .riffet), String(localized: "周六", bundle: .riffet), String(localized: "周日", bundle: .riffet)][index]
    }
    static func make(_ rows: [[KotlinLong]]) -> [Self] {
        guard rows.count == 7, rows.allSatisfy({ $0.count == 24 }) else { return [] }
        return (0..<7).flatMap { day in (0..<24).map { hour in Self(weekday: day, hour: hour, runs: rows[day][hour].int64Value) } }
    }
}
private struct NativeStatsWeekHeatmap: View {
    @Environment(\.palette) private var palette
    let cells: [NativeStatsHourCell]
    @State private var day = 0
    @State private var hour: Int? = 12
    private var maximum: Int64 { cells.map(\.runs).max() ?? 0 }
    var body: some View {
        let maximum = self.maximum
        if cells.isEmpty { Text("没有时段分布").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
        else {
            Chart(cells) { cell in
                RectangleMark(x: .value(String(localized: "小时", bundle: .riffet), cell.hour), y: .value(String(localized: "星期", bundle: .riffet), NativeStatsHourCell.weekdays[cell.weekday]), width: .ratio(0.9), height: .ratio(0.9))
                    .foregroundStyle(heatColor(cell.runs, maximum: maximum, palette))
                    .accessibilityLabel("\(NativeStatsHourCell.weekdayLabel(cell.weekday))，\(cell.hour) 点，\(cell.runs) 轮")
            }.chartXAxis { AxisMarks(values: [0, 6, 12, 18, 23]) }.chartYScale(domain: NativeStatsHourCell.weekdays.reversed())
                .chartXSelection(value: $hour).frame(height: 190).accessibilityIdentifier("statsWeekHeatmap")
            Picker("查看星期", selection: $day) { ForEach(0..<7, id: \.self) { Text(NativeStatsHourCell.weekdayLabel($0)).tag($0) } }
            Stepper("\(hour ?? 12):00", value: Binding(get: { hour ?? 12 }, set: { hour = $0 }), in: 0...23)
            let selected = cells.first(where: { $0.weekday == day && $0.hour == min(23, max(0, hour ?? 12)) })
            Text("\(NativeStatsHourCell.weekdayLabel(day)) \(min(23, max(0, hour ?? 12))):00 · \(selected?.runs ?? 0) 轮").riffetFont(.caption).monospacedDigit()
        }
    }
}
private func heatColor(_ value: Int64, maximum: Int64, _ palette: Palette) -> Color {
    guard value > 0, maximum > 0 else { return palette.press }
    let strength = log1p(Double(value)) / log1p(Double(maximum))
    return palette.accent.opacity(0.2 + strength * 0.8)
}
