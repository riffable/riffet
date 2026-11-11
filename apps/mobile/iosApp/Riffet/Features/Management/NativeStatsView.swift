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
    @State private var filterSheet: NativeStatsFilterKind?
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
            filters
            ManagementFeedback(error: error, notice: nil)
            if error != nil { Button { Task { await load() } } label: { Text("重新读取").foregroundStyle(palette.accent) } }
            if let dashboard {
                overview(dashboard)
                trendSection
                Section("每日活跃") { NativeStatsCalendarHeatmap(cells: calendarCells) }
                ranking(dashboard.models)
                latencySection
                Section("活跃时段") { NativeStatsWeekHeatmap(cells: hourCells) }
                reliability(dashboard.backends)
                breakdown(String(localized: "按 Agent", bundle: .riffet), dashboard.backends)
                breakdown(String(localized: "工具调用", bundle: .riffet), dashboard.tools)
                runsSection
                exportSection
                Section {
                    Text("当前包含的估算输出为 \(dashboard.summary.current.tokens.estimatedOutput.formatted()) Token。时区：\(dashboard.filter.tz)。更新于 \(displayDate(dashboard.generatedAt, time: true))。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        // A first read fills the empty page; a later one keeps the last figures and spins in the bar.
        .overlay { if loading && dashboard == nil { ProgressView() } }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { if loading && dashboard != nil { ProgressView() } } }
        .accessibilityIdentifier("statsList")
        .navigationTitle(String(localized: "使用统计", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task(id: filterKey) { await load() }
        .task(id: trendKey) { await loadTrend() }
        .refreshable { await load() }
        .sheet(item: $filterSheet) { kind in
            NativeStatsFilterSheet(title: kind.label, options: options(kind), selected: selected(kind))
        }
        .sheet(isPresented: $showShare) { if let exportURL { NativeShareSheet(items: [exportURL]) } }
    }

    private var filters: some View {
        Section {
            Picker("时间范围", selection: $selection.range) { ForEach(NativeStatsRange.allCases) { Text($0.label).tag($0) } }
                .accessibilityIdentifier("statsRange")
            if selection.range == .custom {
                DatePicker("开始日期", selection: $selection.from, in: ...selection.to, displayedComponents: .date).accessibilityIdentifier("statsCustomStart")
                DatePicker("结束日期", selection: $selection.to, in: selection.from...Date(), displayedComponents: .date).accessibilityIdentifier("statsCustomEnd")
            }
            DisclosureGroup {
                filterButton(.projects, values: selection.projects)
                filterButton(.backends, values: selection.backends)
                filterButton(.models, values: selection.models)
                Picker("调用类型", selection: $selection.agentKind) { Text("全部").tag("all"); Text("主 Agent").tag("main"); Text("子 Agent").tag("subagent") }
                Toggle("包含已归档会话", isOn: $selection.includeArchived)
                Toggle("包含估算 Token", isOn: $selection.includeEstimated)
                if selection.activeCount > 0 {
                    Button("清除筛选") { selection.projects = []; selection.backends = []; selection.models = []; selection.agentKind = "all"; selection.includeArchived = true; selection.includeEstimated = true }
                }
            } label: {
                Text(selection.activeCount == 0 ? "筛选" : "筛选 · \(selection.activeCount) 项")
                    .accessibilityIdentifier("statsFilters")
            }
        }
    }
    private func filterButton(_ kind: NativeStatsFilterKind, values: Set<String>) -> some View {
        Button { filterSheet = kind } label: {
            LabeledContent(kind.label, value: values.isEmpty ? String(localized: "全部", bundle: .riffet) : values.count == 1 ? options(kind).first(where: { values.contains($0.key) })?.label ?? values.first! : String(localized: "已选 \(values.count) 项", bundle: .riffet))
        }.foregroundStyle(.primary).accessibilityIdentifier("statsFilter.\(kind.rawValue)")
    }
    private func options(_ kind: NativeStatsFilterKind) -> [StatsKeyInfo] {
        switch kind { case .projects: return dashboard?.options.projects ?? []; case .backends: return dashboard?.options.backends ?? []; case .models: return dashboard?.options.models ?? [] }
    }
    private func selected(_ kind: NativeStatsFilterKind) -> Binding<Set<String>> {
        switch kind { case .projects: return $selection.projects; case .backends: return $selection.backends; case .models: return $selection.models }
    }
    private func overview(_ value: StatsDashboard) -> some View {
        let totals = value.summary.current, previous = value.summary.previous
        return Section("\(displayDate(value.filter.from)) 至 \(inclusiveEnd(value.filter.to))") {
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
                if selection.range != .all { Text(delta(current, previous)).font(.caption).foregroundStyle(.secondary) }
            }
        }.accessibilityElement(children: .combine)
    }
    private var trendSection: some View {
        Section("用量趋势") {
            Picker("指标", selection: $metric) { ForEach(NativeStatsMetric.allCases) { Text($0.label).tag($0) } }.accessibilityIdentifier("statsTrendMetric")
            Picker("分组", selection: $split) { ForEach(NativeStatsSplit.allCases) { Text($0.label).tag($0) } }.accessibilityIdentifier("statsTrendSplit")
            if trendLoading { ProgressView().frame(maxWidth: .infinity) }
            if appliedTrendKey == trendKey, let trend {
                if trendPoints.isEmpty { Text("此范围没有这项指标的报告。").foregroundStyle(.secondary) }
                else {
                    NativeStatsTrendChart(points: trendPoints, unit: metric.unit, granularity: trend.granularity.name)
                    Text("按\(granularityLabel(trend.granularity.name))汇总。")
                        .font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("每期数据 · \(trend.points.count) 个区间") {
                        ForEach(Array(trend.points.enumerated()), id: \.offset) { _, point in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(displayDate(point.start, time: trend.granularity.name == "HOUR")).font(.subheadline.weight(.medium))
                                ForEach(trend.keys, id: \.key) { key in
                                    if let amount = point.values[key.key] { LabeledContent(key.label, value: metric.formatted(amount.doubleValue)).font(.caption) }
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                }
            }
            if let trendError { Text(trendError).font(.caption).foregroundStyle(.red); Button("重试趋势") { Task { await loadTrend() } } }
        }
    }
    private func ranking(_ value: StatsBreakdown) -> some View {
        let ordered = value.rows.sorted { (rank.amount($0) ?? -1) > (rank.amount($1) ?? -1) }
        let maximum = ordered.compactMap { rank.amount($0) }.max() ?? 0
        return Section("模型排行") {
            Picker("排序指标", selection: $rank) { ForEach(NativeStatsRank.allCases) { Text($0.label).tag($0) } }
            if ordered.isEmpty { Text("暂无模型记录").foregroundStyle(.secondary) }
            ForEach(ordered.prefix(8), id: \.key) { row in
                VStack(alignment: .leading, spacing: 5) {
                    LabeledContent(row.label, value: rank.formatted(row))
                    if let amount = rank.amount(row), maximum > 0 { ProgressView(value: amount, total: maximum).tint(.accentColor) }
                }.padding(.vertical, 3)
            }
            if ordered.count > 8 { DisclosureGroup("全部 \(ordered.count) 个模型") { ForEach(ordered, id: \.key) { row in LabeledContent(row.label, value: rank.formatted(row)).font(.caption) } } }
        }
    }
    private var latencySection: some View {
        Section("延迟与速度 · 按模型") {
            Picker("指标", selection: $latencyMetric) { ForEach(NativeStatsLatencyMetric.allCases) { Text($0.label).tag($0) } }
            if let latency {
                let measured = latency.rows.filter { latencyMetric.sample($0) != nil }
                if measured.isEmpty { Text("这些模型没有此项测量；未报告不等于 0。").font(.subheadline).foregroundStyle(.secondary) }
                else { NativeStatsLatencyChart(rows: measured, metric: latencyMetric) }
                DisclosureGroup("查看分位数与样本") {
                    ForEach(measured, id: \.key) { row in
                        if let sample = latencyMetric.sample(row) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(row.label)
                                Text("p50 \(latencyMetric.format(sample.p50)) · p90 \(latencyMetric.format(sample.p90)) · p99 \(latencyMetric.format(sample.p99))")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text("\(sample.samples) 个测量样本").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else { Text(loading ? "正在读取测量…" : "暂无可用测量").foregroundStyle(.secondary) }
        }
    }
    private func reliability(_ value: StatsBreakdown) -> some View {
        Section("轮次结果") {
            NativeStatsReliabilityChart(rows: value.rows)
            ForEach(value.rows, id: \.key) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.label)
                    Text("完成 \(row.states.completed) · 失败 \(row.states.failed) · 取消 \(row.states.cancelled) · 中断 \(row.states.interrupted)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    private func breakdown(_ title: String, _ value: StatsBreakdown) -> some View {
        Section(title) {
            if value.rows.isEmpty { Text("暂无数据").foregroundStyle(.secondary) }
            ForEach(value.rows.prefix(12), id: \.key) { row in breakdownRow(row, tools: title == String(localized: "工具调用", bundle: .riffet)) }
            if value.rows.count > 12 { DisclosureGroup("全部 \(value.rows.count) 项") { ForEach(value.rows, id: \.key) { row in breakdownRow(row, tools: title == String(localized: "工具调用", bundle: .riffet)) } } }
        }
    }
    private func breakdownRow(_ row: StatsBreakdownRow, tools: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.label)
            Text("\(row.count) 次 · \(row.totalTokens.formatted()) Token · \(row.share.formatted(.percent.precision(.fractionLength(1))))").font(.caption).foregroundStyle(.secondary)
            if tools { Text(String(localized: "失败调用：\(row.failed.map { $0.int64Value.formatted() } ?? String(localized: "未报告", bundle: .riffet))", bundle: .riffet)).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var runsSection: some View {
        Section("最近轮次") {
            if currentData {
                ForEach(runs, id: \.runId) { run in
                    NavigationLink { ConversationView(workbench: workbench, sessionID: run.sessionId) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(run.sessionTitle).foregroundStyle(.primary)
                            Text("\(run.projectName) · \(run.backendId.name) · \(run.model ?? String(localized: "默认模型", bundle: .riffet))").font(.caption).foregroundStyle(.secondary)
                            Text("\(run.totalTokens.formatted()) Token · \(displayDate(run.createdAt, time: true))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if runs.isEmpty && !loading && runsError == nil { Text("此范围没有轮次").foregroundStyle(.secondary) }
            }
            if (nextCursor != nil || runsError != nil) && currentData {
                if let runsError { Text(runsError).font(.caption).foregroundStyle(.red).lineLimit(1) }
                Button { Task { await more() } } label: {
                    if loadingMore { ProgressView() } else { runsError != nil ? Text("读取失败 · 重试") : Text("载入更多") }
                }.disabled(loadingMore || loading).accessibilityIdentifier("statsRunsMore")
            }
        }
    }
    private var exportSection: some View {
        Section("导出") {
            Button("导出 CSV") { Task { await export("csv") } }.accessibilityIdentifier("statsExportCSV")
            Button("导出 JSON") { Task { await export("json") } }.accessibilityIdentifier("statsExportJSON")
            if exporting { ProgressView() }
        }.disabled(exporting || loading || !currentData || appliedItems.isEmpty)
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
    private func granularityLabel(_ name: String) -> String { ["HOUR": String(localized: "小时", bundle: .riffet), "DAY": String(localized: "天", bundle: .riffet), "WEEK": String(localized: "周", bundle: .riffet), "MONTH": String(localized: "月", bundle: .riffet)][name] ?? name }
}

private enum NativeStatsFilterKind: String, Identifiable {
    case projects, backends, models
    var id: String { rawValue }
    var label: String { self == .projects ? String(localized: "项目", bundle: .riffet) : self == .backends ? "Agent" : String(localized: "模型", bundle: .riffet) }
}
private struct NativeStatsFilterSheet: View {
    let title: String
    let options: [StatsKeyInfo]
    @Binding var selected: Set<String>
    @Environment(\.dismiss) private var dismiss
    @State private var pending: Set<String>
    @State private var search = ""
    init(title: String, options: [StatsKeyInfo], selected: Binding<Set<String>>) {
        self.title = title; self.options = options; _selected = selected; _pending = State(initialValue: selected.wrappedValue)
    }
    var body: some View {
        NavigationStack {
            RiffetList {
                Section { Button("不限\(title)") { pending = [] } } footer: { Text("最多选择 100 项。") }
                ForEach(options.filter { search.isEmpty || $0.label.localizedCaseInsensitiveContains(search) }, id: \.key) { item in
                    Button { if !pending.insert(item.key).inserted { pending.remove(item.key) } } label: {
                        HStack { Text(item.label).foregroundStyle(.primary); Spacer(); if pending.contains(item.key) { Image(systemName: "checkmark") } }.frame(minHeight: 44).contentShape(Rectangle())
                    }.disabled(!pending.contains(item.key) && pending.count >= NativeStatsSelection.maximumSelections)
                        .accessibilityValue(pending.contains(item.key) ? "已选择" : "未选择")
                        .accessibilityIdentifier("statsFilterChoice.\(item.key)")
                }
                if options.isEmpty { Text("暂无可筛选的记录").foregroundStyle(.secondary) }
            }
            .navigationTitle(String(localized: "选择\(title)", bundle: .riffet)).navigationBarTitleDisplayMode(.inline).searchable(text: $search, prompt: String(localized: "搜索\(title)", bundle: .riffet))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { selected = pending; dismiss() } }
            }
        }
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
    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func make(_ series: StatsSeries, metric: NativeStatsMetric) -> [Self] {
        var output: [Self] = []
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallback = ISO8601DateFormatter()
        for point in series.points {
            guard let date = formatter.date(from: point.start) ?? fallback.date(from: point.start) else { continue }
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
        .chartLegend(position: .bottom).chartXSelection(value: $selected).frame(height: 240).accessibilityIdentifier("statsTrendChart")
        if let selected, let nearest = points.min(by: { abs($0.start.timeIntervalSince(selected)) < abs($1.start.timeIntervalSince(selected)) }) {
            VStack(alignment: .leading, spacing: 4) {
                Text(nearest.start.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(AppLocalization.shared.locale))).font(.caption.weight(.medium))
                ForEach(points.filter { $0.start == nearest.start }) { point in
                    LabeledContent(point.series, value: point.amount.formatted(.number.precision(.fractionLength(unit == String(localized: "秒", bundle: .riffet) ? 2 : 0))) + " " + unit).font(.caption)
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
    let rows: [StatsLatencyRow]
    let metric: NativeStatsLatencyMetric
    var body: some View {
        Chart {
            ForEach(rows.prefix(12), id: \.key) { row in
                if let sample = metric.sample(row) {
                    BarMark(x: .value(metric.label, metric.plotted(sample.p50)), y: .value(String(localized: "模型", bundle: .riffet), row.label)).foregroundStyle(Color.accentColor.opacity(0.6))
                    PointMark(x: .value("p90", metric.plotted(sample.p90)), y: .value(String(localized: "模型", bundle: .riffet), row.label)).foregroundStyle(.primary)
                    PointMark(x: .value("p99", metric.plotted(sample.p99)), y: .value(String(localized: "模型", bundle: .riffet), row.label)).symbol(.diamond).foregroundStyle(.secondary)
                }
            }
        }.frame(height: CGFloat(max(1, min(rows.count, 12))) * 42 + 32)
        Text("柱形 p50 · 圆点 p90 · 菱形 p99。").font(.caption).foregroundStyle(.secondary)
    }
}
private struct NativeStatsReliabilityChart: View {
    let rows: [StatsBreakdownRow]
    var body: some View {
        Chart {
            ForEach(rows, id: \.key) { row in
                BarMark(x: .value(String(localized: "轮次", bundle: .riffet), row.states.completed), y: .value("Agent", row.label)).foregroundStyle(by: .value(String(localized: "结果", bundle: .riffet), String(localized: "完成", bundle: .riffet)))
                BarMark(x: .value(String(localized: "轮次", bundle: .riffet), row.states.failed), y: .value("Agent", row.label)).foregroundStyle(by: .value(String(localized: "结果", bundle: .riffet), String(localized: "失败", bundle: .riffet)))
                BarMark(x: .value(String(localized: "轮次", bundle: .riffet), row.states.cancelled), y: .value("Agent", row.label)).foregroundStyle(by: .value(String(localized: "结果", bundle: .riffet), String(localized: "取消", bundle: .riffet)))
                BarMark(x: .value(String(localized: "轮次", bundle: .riffet), row.states.interrupted), y: .value("Agent", row.label)).foregroundStyle(by: .value(String(localized: "结果", bundle: .riffet), String(localized: "中断", bundle: .riffet)))
            }
        }.chartLegend(position: .bottom).frame(height: CGFloat(max(1, rows.count)) * 38 + 48)
    }
}
private struct NativeStatsCalendarCell: Identifiable {
    let date: String
    let runs: Int64, tokens: Int64
    var id: String { date }
}
private struct NativeStatsCalendarHeatmap: View {
    let cells: [NativeStatsCalendarCell]
    @State private var selected: Int?
    private var maximum: Int64 { cells.map(\.runs).max() ?? 0 }
    var body: some View {
        let maximum = self.maximum
        if cells.isEmpty { Text("此范围没有每日记录").foregroundStyle(.secondary) }
        else {
            HStack { Text(cells.first?.date ?? ""); Spacer(); Text(cells.last?.date ?? "") }.font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                LazyHStack(spacing: 3) {
                    ForEach(cells.indices, id: \.self) { index in
                        let day = cells[index]
                        Button { selected = index } label: {
                            VStack(spacing: 5) {
                                RoundedRectangle(cornerRadius: 3).fill(heatColor(day.runs, maximum: maximum)).frame(width: 24, height: 24)
                                    .overlay { if selected == index { RoundedRectangle(cornerRadius: 3).stroke(Color.primary, lineWidth: 2) } }
                                Text(String(day.date.suffix(2))).font(.caption2).foregroundStyle(.secondary)
                            }.frame(minWidth: 32, minHeight: 48).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("\(day.date)，\(day.runs) 轮，\(day.tokens) Token")
                    }
                }.padding(.vertical, 3)
            }.defaultScrollAnchor(.trailing).accessibilityIdentifier("statsCalendarHeatmap")
            if let selected, cells.indices.contains(selected) {
                let day = cells[selected]
                Text("\(day.date) · \(day.runs.formatted()) 轮 · \(day.tokens.formatted()) Token").font(.caption).monospacedDigit()
            } else { Text("颜色越深，轮次越多。").font(.caption).foregroundStyle(.secondary) }
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
    let cells: [NativeStatsHourCell]
    @State private var day = 0
    @State private var hour: Int? = 12
    private var maximum: Int64 { cells.map(\.runs).max() ?? 0 }
    var body: some View {
        let maximum = self.maximum
        if cells.isEmpty { Text("没有时段分布").foregroundStyle(.secondary) }
        else {
            Chart(cells) { cell in
                RectangleMark(x: .value(String(localized: "小时", bundle: .riffet), cell.hour), y: .value(String(localized: "星期", bundle: .riffet), NativeStatsHourCell.weekdays[cell.weekday]), width: .ratio(0.9), height: .ratio(0.9))
                    .foregroundStyle(heatColor(cell.runs, maximum: maximum))
                    .accessibilityLabel("\(NativeStatsHourCell.weekdayLabel(cell.weekday))，\(cell.hour) 点，\(cell.runs) 轮")
            }.chartXAxis { AxisMarks(values: [0, 6, 12, 18, 23]) }.chartYScale(domain: NativeStatsHourCell.weekdays.reversed())
                .chartXSelection(value: $hour).frame(height: 190).accessibilityIdentifier("statsWeekHeatmap")
            Picker("查看星期", selection: $day) { ForEach(0..<7, id: \.self) { Text(NativeStatsHourCell.weekdayLabel($0)).tag($0) } }
            Stepper("\(hour ?? 12):00", value: Binding(get: { hour ?? 12 }, set: { hour = $0 }), in: 0...23)
            let selected = cells.first(where: { $0.weekday == day && $0.hour == min(23, max(0, hour ?? 12)) })
            Text("\(NativeStatsHourCell.weekdayLabel(day)) \(min(23, max(0, hour ?? 12))):00 · \(selected?.runs ?? 0) 轮").font(.caption).monospacedDigit()
            Text("按筛选时区汇总。").font(.caption).foregroundStyle(.secondary)
        }
    }
}
private func heatColor(_ value: Int64, maximum: Int64) -> Color {
    guard value > 0, maximum > 0 else { return Color(uiColor: .tertiarySystemFill) }
    let strength = log1p(Double(value)) / log1p(Double(maximum))
    return Color.accentColor.opacity(0.2 + strength * 0.8)
}
