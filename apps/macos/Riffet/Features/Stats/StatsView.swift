import SwiftUI
import RiffetKit

/// Usage statistics (docs/STATS.md): filters, KPIs, charts, the runs table and live refresh.
struct StatsView: View {
    let workbench: Workbench
    /// Kept by the workbench, so a later visit shows the last answer and the same range and filters.
    private let model: StatsModel
    @Environment(\.palette) private var palette

    init(workbench: Workbench) {
        self.workbench = workbench
        model = workbench.pageModels.stats
    }

    @State private var scroll = StatsScrollState()
    /// The content column's width, which picks side-by-side or stacked charts.
    @State private var width: CGFloat = 1100

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    StatsScopeRow(model: model)
                    if let exportError = model.exportError {
                        Text(exportError).font(.riffet(size: S(12))).foregroundStyle(palette.danger).lineLimit(2)
                    }
                    StatsBody(model: model, width: width)
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.md)
                .padding(.bottom, Space.xxl)
                .frame(maxWidth: 1180)
                .onGeometryChange(for: CGFloat.self) { $0.size.width - Space.lg * 2 } action: { if abs(width - $0) > 0.5 { width = $0 } }
                .frame(maxWidth: .infinity)
            }
            .onScrollPhaseChange { _, phase in scroll.scrolling = phase.isScrolling }
            .environment(\.statsScroll, scroll)
        }
        .navigationTitle(WorkbenchPage.stats.title)
        .pageChrome(.stats, workbench: workbench) { StatsToolbarActions(model: model) }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }
}

/// The filters and export in the window toolbar. The time the data was generated is the export
/// button's help, not a line of its own.
private struct StatsToolbarActions: View {
    let model: StatsModel

    var body: some View {
        PageMenuButton(symbol: model.activeFilterCount > 0 ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease", help: String(localized: "筛选"), build: filterMenu)
        PageMenuButton(symbol: "square.and.arrow.up", help: exportHelp) {
            .choices([
                ChoiceOption(title: String(localized: "导出 CSV"), selected: false) { model.export(format: "csv") },
                ChoiceOption(title: String(localized: "导出 JSON"), selected: false) { model.export(format: "json") },
            ])
        }
        .disabled(model.exporting || model.dashboard == nil)
    }

    /// One submenu a dimension, checked values kept; the estimate switch and a reset below.
    private func filterMenu() -> NSMenu {
        let menu = NSMenu()
        // A dimension with nothing to pick is shown dimmed, not as an empty submenu.
        menu.autoenablesItems = false
        func dimension(_ title: String, _ options: [(key: String, label: String)], _ selected: [String], _ toggle: @escaping (String) -> Void) {
            let item = NSMenuItem(title: selected.isEmpty ? title : "\(title) · \(selected.count)", action: nil, keyEquivalent: "")
            let sub = NSMenu()
            for option in options {
                let choice = MenuAction.item(option.label) { toggle(option.key) }
                choice.state = selected.contains(option.key) ? .on : .off
                sub.addItem(choice)
            }
            item.submenu = sub
            item.isEnabled = !options.isEmpty
            menu.addItem(item)
        }
        dimension("Agent", model.agentOptions, model.backends, model.toggleBackend)
        dimension(String(localized: "模型"), model.modelOptions, model.models, model.toggleModel)
        dimension(String(localized: "项目"), model.projectOptions, model.projects, model.toggleProject)
        menu.addItem(.separator())
        let estimated = MenuAction.item(String(localized: "包含估算的 token")) { model.toggleEstimated() }
        estimated.state = model.includeEstimated ? .on : .off
        menu.addItem(estimated)
        if model.activeFilterCount > 0 {
            menu.addItem(.separator())
            menu.addItem(MenuAction.item(String(localized: "清除筛选")) { model.clearFilters() })
        }
        return menu
    }

    private var exportHelp: String {
        if model.exporting { return String(localized: "导出中") }
        guard model.dashboard != nil else { return String(localized: "导出") }
        return String(localized: "导出 · 数据生成于 \(formatTimestamp(model.dashboard?.generatedAt))")
    }
}

/// What the numbers cover, above them: the range as a menu, its dates when custom, and each active
/// filter as a token that removes itself.
private struct StatsScopeRow: View {
    let model: StatsModel
    @Environment(\.palette) private var palette

    var body: some View {
        FlowRow(spacing: Space.xs, lineSpacing: Space.xs) {
            MenuLabelButton(label: AnyView(
                HStack(spacing: 4) {
                    Text(model.preset.windowName ?? model.preset.label).font(.riffet(size: S(13), weight: .semibold)).foregroundStyle(palette.fg)
                    Image(icon: "chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg3)
                }
                .padding(.horizontal, 6)
                .frame(height: 26)
            )) {
                .choices(StatsRangePreset.allCases.map { preset in
                    ChoiceOption(title: preset.label, selected: model.preset == preset) { model.setPreset(preset) }
                })
            }
            .fixedSize()
            .help("时间范围")
            if model.preset == .custom {
                HStack(spacing: Space.xs) {
                    dateField(String(localized: "开始日期"), date: model.customFrom) { model.setCustom(from: $0, to: nil) }
                    Text("–").font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                    dateField(String(localized: "结束日期"), date: model.customTo) { model.setCustom(from: nil, to: $0) }
                }
            }
            ForEach(tokens, id: \.id) { token in
                Button(action: token.remove) {
                    HStack(spacing: 4) {
                        Text(token.label).lineLimit(1)
                        Image(icon: "xmark").font(.riffet(size: S(8), weight: .bold)).foregroundStyle(palette.fg3)
                    }
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg2)
                    .padding(.horizontal, 8)
                    .frame(height: 22)
                    .background(palette.bgMuted, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .help("移除筛选")
                .padding(.vertical, 2)
            }
            if model.refreshing { Spinner(size: .mini).help("更新中").frame(height: 26) }
        }
        .padding(.leading, -6)
    }

    private struct Token {
        let id: String
        let label: String
        let remove: () -> Void
    }

    private var tokens: [Token] {
        func label(_ key: String, in options: [(key: String, label: String)]) -> String { options.first { $0.key == key }?.label ?? key }
        var tokens = model.backends.map { key in Token(id: "a:" + key, label: label(key, in: model.agentOptions)) { model.toggleBackend(key) } }
        tokens += model.models.map { key in Token(id: "m:" + key, label: label(key, in: model.modelOptions)) { model.toggleModel(key) } }
        tokens += model.projects.map { key in Token(id: "p:" + key, label: label(key, in: model.projectOptions)) { model.toggleProject(key) } }
        if !model.includeEstimated { tokens.append(Token(id: "e", label: String(localized: "不含估算")) { model.toggleEstimated() }) }
        return tokens
    }

    private func dateField(_ label: String, date: String?, set: @escaping (Date) -> Void) -> some View {
        DatePicker(label, selection: Binding(get: { StatsTime.day(statsDateInput(date)) ?? Date() }, set: set), displayedComponents: .date)
            .datePickerStyle(.field)
            .labelsHidden()
            .font(.riffet(size: S(12)))
            .frame(width: 118)
            .help(label)
    }
}

private struct StatsBody: View {
    let model: StatsModel
    let width: CGFloat
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            if model.loading, model.dashboard == nil {
                StatsSkeleton()
            } else if model.dashboard == nil {
                VStack(spacing: Space.md) {
                    Text(model.error ?? String(localized: "无法加载统计"))
                        .font(.riffet(size: S(13)))
                        .foregroundStyle(palette.fg2)
                        .multilineTextAlignment(.center)
                    Button("重试") { model.reload() }
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.xxl)
            } else {
                if let error = model.error {
                    Text("\(error)，仍显示上次的数据。")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let dashboard = model.dashboard, dashboard.summary.current.runs == 0, dashboard.summary.current.sessions == 0, dashboard.series.points.isEmpty {
                    Text("还没有可统计的会话。")
                        .font(.riffet(size: S(13)))
                        .foregroundStyle(palette.fg3)
                        .padding(Space.lg)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(palette.line))
                }
                StatsKpiSection(model: model, width: width)
                StatsChartsColumn(model: model, width: width)
                StatsRunsSection(model: model, width: width)
            }
        }
    }
}

private struct StatsKpiSection: View {
    let model: StatsModel
    let width: CGFloat
    @Environment(\.palette) private var palette

    var body: some View {
        if let summary = model.dashboard?.summary {
            let cards = buildKpis(summary: summary)
            // One card like every other section: the headline four over the rest, each cell's label
            // on one top line however tall its neighbours are.
            let columns = width >= 560 ? 4 : 2
            VStack(alignment: .leading, spacing: Space.lg) {
                kpiGrid(Array(cards.prefix(4)), columns: columns, primary: true)
                if cards.count > 4 {
                    Rectangle().fill(palette.lineSoft).frame(height: 1)
                    kpiGrid(Array(cards.dropFirst(4)), columns: columns, primary: false)
                }
            }
            .padding(Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(radius: Radius.card, palette: palette)
        }
    }

    private func kpiGrid(_ cards: [KpiModel], columns: Int, primary: Bool) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Space.lg, alignment: .topLeading), count: columns), alignment: .leading, spacing: Space.lg) {
            ForEach(cards) { card in
                KpiCard(card: card, compare: model.compareLabel, primary: primary)
            }
        }
    }
}

private struct KpiCard: View {
    let card: KpiModel
    let compare: String
    var primary = true
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: 4) {
                Text(card.label)
                if card.format == .speed { Text("· token/s") }
                if card.format == .duration { Text("· ms") }
            }
            .font(RiffetFont.caption)
            .foregroundStyle(palette.fg3)
            .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
                Text(card.value == nil ? statsUnavailable : formatMetric(card.value, card.format))
                    .font(.riffet(size: S(primary ? 22 : 16), weight: primary ? .semibold : .medium))
                    .foregroundStyle(card.value == nil ? palette.fg4 : palette.fg)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .help(card.value == nil ? String(localized: "该数据源不提供") : card.label)
                if card.estimated {
                    Text("*")
                        .font(.riffet(size: S(12), weight: .medium))
                        .foregroundStyle(palette.warning)
                        .help("部分数字由文本长度估算，不是提供商上报")
                }
            }
            if card.previous != nil {
                DeltaLabel(current: card.value, previous: card.previous, lowerIsBetter: card.lowerIsBetter, compare: compare)
            }
            if let note = card.note {
                Text(note).font(.riffet(size: S(11))).foregroundStyle(palette.fg4).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DeltaLabel: View {
    let current: Double?
    let previous: Double?
    let lowerIsBetter: Bool
    let compare: String
    @Environment(\.palette) private var palette

    var body: some View {
        let delta = metricDelta(current: current, previous: previous, lowerIsBetter: lowerIsBetter)
        switch delta.kind {
        case .none, .fresh:
            EmptyView()
        case .flat:
            Text("持平").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
        case .ratio:
            let up = (delta.ratio ?? 0) > 0
            Text("\(up ? "↑" : "↓") \(formatRatio(delta.ratio ?? 0))")
                .font(.riffet(size: S(11)))
                .foregroundStyle(delta.improved == true ? palette.success : palette.danger)
                .monospacedDigit()
                .lineLimit(1)
                .help(compare.isEmpty ? "对比上一等长周期" : "对比 \(compare)")
        }
    }
}

/// Pairs of charts sit side by side when the column holds both at their minimum widths, else
/// stacked. Decided from the measured width: `ViewThatFits` laid every chart out twice, once per
/// arrangement, on each pass.
private struct StatsChartsColumn: View {
    let model: StatsModel
    let width: CGFloat
    @State private var highlight: String?

    /// The gap between cards is one size both ways, side by side or stacked.
    private func pair(fits minimum: CGFloat) -> AnyLayout {
        width >= minimum + Space.lg
            ? AnyLayout(HStackLayout(alignment: .top, spacing: Space.lg))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: Space.lg))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            if let dashboard = model.dashboard, let series = model.displayedSeries {
                let usageWide = width >= 340 + 280 + Space.lg
                let usageRow = pair(fits: 340 + 280)
                let pairRow = pair(fits: 240 * 2)
                usageRow {
                    UsageChart(
                        series: series,
                        data: model.usageData ?? usageChartData(series),
                        stale: model.seriesStale,
                        metric: .constant(model.metric),
                        split: .constant(model.split),
                        highlight: $highlight,
                        onMetric: model.setMetric,
                        onSplit: model.setSplit,
                        onBrush: model.applyBrush
                    )
                    .frame(maxWidth: .infinity)
                    DonutChart(breakdown: dashboard.backends, highlight: $highlight)
                        .frame(width: usageWide ? 280 : nil)
                        .frame(maxWidth: usageWide ? nil : .infinity)
                }
                // Cards side by side share the taller one's height, so their bottoms line up.
                .fixedSize(horizontal: false, vertical: true)
                CalendarHeatmap(days: model.calendarDays)
                pairRow {
                    RankChart(rows: model.rankedModels, rank: Binding(get: { model.rank }, set: { model.rank = $0 }), highlight: $highlight)
                        .frame(maxWidth: .infinity)
                    LatencyChart(latency: model.latency, error: model.latencyError, speedWindows: model.speedWindows, kind: Binding(get: { model.latencyKind }, set: { model.latencyKind = $0 }), highlight: $highlight)
                        .frame(maxWidth: .infinity)
                }
                // Cards side by side share the taller one's height, so their bottoms line up.
                .fixedSize(horizontal: false, vertical: true)
                pairRow {
                    WeekHeatmap(grid: model.weekHours)
                        .frame(maxWidth: .infinity)
                    ReliabilityChart(breakdown: dashboard.backends, highlight: $highlight)
                        .frame(maxWidth: .infinity)
                }
                // Cards side by side share the taller one's height, so their bottoms line up.
                .fixedSize(horizontal: false, vertical: true)
                ToolChart(rows: model.toolRows, highlight: $highlight)
            }
        }
    }
}

private struct StatsRunsSection: View {
    let model: StatsModel
    let width: CGFloat
    @Environment(\.palette) private var palette
    /// Sessions whose turns are shown. The table is read per session, so this is one flag per row.
    @State private var openSessions: Set<String> = []

    private static let tableWidth: CGFloat = 960

    /// Column widths in one place: the header, the session rows and the expanded turn rows all lay
    /// out from these numbers, which is the only reason the three line up vertically.
    private enum Column {
        static let time: CGFloat = 88
        static let project: CGFloat = 104
        static let agent: CGFloat = 104
        static let model: CGFloat = 112
        static let state: CGFloat = 84
        static let turns: CGFloat = 40
        static let tokens: CGFloat = 72
        static let duration: CGFloat = 72
        static let ttft: CGFloat = 68
    }

    var body: some View {
        let sessions = statsSessionRows(model.runs)
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Text("明细").font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
                Spacer()
                Text(loadedLabel(sessions))
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .monospacedDigit()
                    .help("一行一个会话；展开可以看到这一会话加载到的每一轮")
            }
            .padding(.horizontal, Space.lg)
            .padding(.top, Space.md)
            if sessions.isEmpty {
                StatsEmptyNote(text: model.runsLoading ? String(localized: "正在读取轮次") : (model.runsError == nil ? String(localized: "这个范围里没有轮次") : String(localized: "明细暂时无法读取")))
                    .padding(.bottom, Space.sm)
            } else if width >= Self.tableWidth {
                // Rows are built as they scroll into view; a page of loaded runs is hundreds of rows.
                LazyVStack(spacing: 0) {
                    runHeader
                    runRows(sessions)
                }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(spacing: 0) {
                        runHeader
                        runRows(sessions)
                    }
                    .frame(minWidth: Self.tableWidth, alignment: .leading)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            if let runsError = model.runsError {
                HStack(spacing: Space.sm) {
                    Text(runsError).font(.riffet(size: S(12))).foregroundStyle(palette.danger).lineLimit(2)
                    Button("重试") { model.retryRuns() }
                        .buttonStyle(ChipButtonStyle())
                        .disabled(model.runsLoading)
                }
                .padding(.horizontal, Space.lg)
            }
            HStack {
                Spacer()
                Button(model.runsLoading ? "加载中…" : "加载更多") { model.loadMore() }
                    .buttonStyle(SolidButtonStyle(kind: .secondary))
                    .disabled(model.runsLoading || !model.runsHasMore)
            }
            .padding(.horizontal, Space.lg)
            .padding(.bottom, Space.md)
        }
        .card(radius: Radius.card, palette: palette)
    }

    private func loadedLabel(_ sessions: [StatsSessionRow]) -> String {
        if model.runsLoading, model.runs.isEmpty { return String(localized: "正在读取…") }
        return String(localized: "已加载 \(sessions.count) 个会话 · \(model.runs.count) 轮")
    }

    @ViewBuilder
    private func runRows(_ sessions: [StatsSessionRow]) -> some View {
        ForEach(sessions) { session in
            Button { model.workbench.open(sessionId: session.sessionId) } label: { sessionCells(session) }
                .buttonStyle(HoverRowStyle(radius: 0))
            if openSessions.contains(session.id) {
                ForEach(session.runs, id: \.runId) { run in
                    Button { model.workbench.open(sessionId: run.sessionId) } label: { turnCells(run) }
                        .buttonStyle(HoverRowStyle(radius: 0))
                }
            }
        }
    }

    private var runHeader: some View {
        HStack(spacing: 0) {
            header(String(localized: "时间"), width: Column.time)
            header(String(localized: "会话"), width: 180, flexible: true)
            header(String(localized: "项目"), width: Column.project)
            header("Agent", width: Column.agent)
            header(String(localized: "模型"), width: Column.model)
            header(String(localized: "状态"), width: Column.state)
            header(String(localized: "轮次"), width: Column.turns, trailing: true).help("这一会话加载到的轮次数")
            header("Token", width: Column.tokens, trailing: true)
            header(String(localized: "耗时"), width: Column.duration, trailing: true).help("每一轮整轮耗时的合计，只计测量到的轮次")
            header(String(localized: "首字延迟"), width: Column.ttft, trailing: true).help("每一轮首字延迟的中位数，只计测量到的轮次")
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(palette.bgSubtle)
    }

    /// One session: the newest turn's time and state, the turns' totals, and the disclosure of them.
    private func sessionCells(_ session: StatsSessionRow) -> some View {
        let now = Date()
        return HStack(spacing: 0) {
            cell(formatRowTime(session.createdAt, now: now), width: Column.time, color: palette.fg3)
                .help("最近一轮：\(formatExactTimestamp(session.createdAt))")
            HStack(spacing: 5) {
                Text(session.title.isEmpty ? String(localized: "未命名会话") : session.title).lineLimit(1)
                if session.turnCount > 1 { turnToggle(session) }
            }
            .font(.riffet(size: S(12)))
            .foregroundStyle(palette.fg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, Space.sm)
            cell(session.projectName, width: Column.project, color: palette.fg2)
            backendCell(session)
            cell(session.models.first ?? statsUnavailable, width: Column.model, color: session.models.isEmpty ? palette.fg4 : palette.fg2)
                .help(session.models.isEmpty ? String(localized: "这一轮没有记录模型") : session.models.joined(separator: " · "))
            cell(runStateLabel(session.state), width: Column.state, color: palette.fg2)
                .help("最近一轮 \(runStateLabel(session.state))；已加载的轮次：\(session.states.summary)")
            cell(formatCount(Double(session.turnCount)), width: Column.turns, trailing: true, color: palette.fg2)
            tokensCell(session.tokens, help: session.unmeasured > 0 ? String(localized: "有 \(session.unmeasured) 轮没有测量，合计只含测量到的轮次") : String(localized: "已加载轮次的 token 合计"))
                .frame(width: Column.tokens, alignment: .trailing)
            cell(formatDuration(session.durationMs), width: Column.duration, trailing: true)
            cell(formatDuration(session.ttftMs), width: Column.ttft, trailing: true, color: palette.fg2)
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .overlay(alignment: .top) { Rectangle().fill(palette.lineSoft).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(formatExactTimestamp(session.createdAt)) \(session.title.isEmpty ? String(localized: "未命名会话") : session.title)，\(session.turnCount) 轮，\(runStateLabel(session.state))")
    }

    /// The token column, shared by both kinds of row so the number, the estimated mark and the
    /// right-aligned edge are the same in each.
    private func tokensCell(_ tokens: TokenDisplay, help: String) -> some View {
        HStack(spacing: 2) {
            Text(tokens.text).monospacedDigit()
            if tokens.estimated { Text("*").foregroundStyle(palette.warning) }
        }
        .font(.riffet(size: S(12)))
        .foregroundStyle(tokens.unavailable ? palette.fg4 : palette.fg)
        .help(help)
    }

    private func turnToggle(_ session: StatsSessionRow) -> some View {
        let open = openSessions.contains(session.id)
        return Button {
            if open { openSessions.remove(session.id) } else { openSessions.insert(session.id) }
        } label: {
            Image(icon: "chevron.right")
                .font(.riffet(size: S(9), weight: .semibold))
                .rotationEffect(.degrees(open ? 90 : 0))
                .foregroundStyle(palette.fg4)
        }
        .buttonStyle(IconButtonStyle(size: 18))
        .help(open ? "收起这一会话的轮次" : "展开这一会话的 \(session.turnCount) 轮")
    }

    private func backendCell(_ session: StatsSessionRow) -> some View {
        let wire = session.agents[0]
        let extra = session.agents.count - 1
        return HStack(spacing: 5) {
            Circle()
                .fill(chartColors(palette)[seriesColorSlots(session.agents.map { ($0, $0) })[wire] ?? 0])
                .frame(width: 6, height: 6)
            Text(backendLabel(wire)).lineLimit(1)
            if extra > 0 {
                Text("+\(extra)").foregroundStyle(palette.fg4)
            }
        }
        .font(.riffet(size: S(12)))
        .foregroundStyle(palette.fg)
        .frame(width: 104, alignment: .leading)
        .help(session.agents.map(backendLabel).joined(separator: " · "))
    }

    /// One turn of an expanded session, laid out as a row of the same table: its time, state, tokens,
    /// duration and first-output latency sit under the headers above them, so a column can be read
    /// straight down. The model takes the width of 会话 / 项目 / Agent, which a turn inherits from its
    /// session, and keeps the parameters (`context=…`, `effort=…`) readable there.
    private func turnCells(_ run: StatsRunRow) -> some View {
        return HStack(spacing: 0) {
            cell(formatRowTime(run.createdAt, now: Date()), width: Column.time, color: palette.fg3)
                .help(formatExactTimestamp(run.createdAt))
            HStack(spacing: Space.xs) {
                Image(icon: "arrow.turn.down.right")
                    .font(.riffet(size: S(9), weight: .semibold))
                    .foregroundStyle(palette.fg4)
                Text(run.model ?? String(localized: "未记录模型"))
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(run.model == nil ? palette.fg4 : palette.fg2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(run.model ?? String(localized: "这一轮没有记录模型"))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, Space.sm)
            cell(runStateLabel(run.state), width: Column.state, color: palette.fg2)
            Color.clear.frame(width: Column.turns)
            tokensCell(tokensDisplay(run.tokens, total: run.totalTokens), help: String(localized: "这一轮的 token"))
                .frame(width: Column.tokens, alignment: .trailing)
            cell(formatDuration(optionalLong(run.durationMs)), width: Column.duration, trailing: true)
            cell(formatDuration(optionalLong(run.ttftMs)), width: Column.ttft, trailing: true, color: palette.fg2)
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.xs)
        .overlay(alignment: .top) { Rectangle().fill(palette.lineSoft).frame(height: 1).opacity(0.6) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(formatExactTimestamp(run.createdAt))，\(runStateLabel(run.state))")
    }

    private func header(_ title: String, width: CGFloat, flexible: Bool = false, trailing: Bool = false) -> some View {
        Text(title)
            .font(.riffet(size: S(12), weight: .medium))
            .foregroundStyle(palette.fg3)
            .frame(width: flexible ? nil : width, alignment: trailing ? .trailing : .leading)
            .frame(maxWidth: flexible ? .infinity : nil, alignment: trailing ? .trailing : .leading)
    }

    private func cell(_ text: String, width: CGFloat, flexible: Bool = false, trailing: Bool = false, color: Color? = nil) -> some View {
        Text(text)
            .font(.riffet(size: S(12)))
            .foregroundStyle(color ?? palette.fg)
            .monospacedDigit()
            .lineLimit(1)
            .frame(width: flexible ? nil : width, alignment: trailing ? .trailing : .leading)
            .frame(maxWidth: flexible ? .infinity : nil, alignment: trailing ? .trailing : .leading)
    }
}

private struct StatsSkeleton: View {
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            block(height: 132)
            block(height: 280)
            block(height: 120)
            HStack(spacing: Space.md) { block(height: 220); block(height: 220) }
        }
        .accessibilityLabel("正在加载统计")
    }

    private func block(height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
            .fill(palette.bgMuted)
            .frame(maxWidth: .infinity)
            .frame(height: height)
    }
}

