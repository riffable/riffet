import Charts
import SwiftUI
import RiffetKit

/// Whether the stats page is scrolling. A plain reference, so flipping it redraws nothing; hover
/// handlers read it as they fire.
final class StatsScrollState {
    var scrolling = false
}

private struct StatsScrollKey: EnvironmentKey {
    static let defaultValue = StatsScrollState()
}

extension EnvironmentValues {
    var statsScroll: StatsScrollState {
        get { self[StatsScrollKey.self] }
        set { self[StatsScrollKey.self] = newValue }
    }
}

extension View {
    /// `onHover` that ignores the pointer while the page scrolls: content moving under a resting
    /// pointer would otherwise re-highlight, and redraw, every chart on each frame.
    func statsHover(_ action: @escaping (Bool) -> Void) -> some View { modifier(StatsHover(action: action)) }

    /// `onContinuousHover`, quiet while the page scrolls for the same reason.
    func statsContinuousHover(_ action: @escaping (HoverPhase) -> Void) -> some View { modifier(StatsContinuousHover(action: action)) }
}

private struct StatsHover: ViewModifier {
    let action: (Bool) -> Void
    @Environment(\.statsScroll) private var scroll

    func body(content: Content) -> some View {
        content.onHover { inside in if !scroll.scrolling { action(inside) } }
    }
}

private struct StatsContinuousHover: ViewModifier {
    let action: (HoverPhase) -> Void
    @Environment(\.statsScroll) private var scroll

    func body(content: Content) -> some View {
        content.onContinuousHover { phase in if !scroll.scrolling { action(phase) } }
    }
}

struct StatsCard<Content: View, Actions: View>: View {
    let title: String
    @ViewBuilder var actions: Actions
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .center, spacing: Space.sm) {
                Text(title)
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Spacer(minLength: Space.sm)
                actions
            }
            content
        }
        .padding(Space.lg)
        // Fills the height a row of cards gives it, its content at the top.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .card(radius: Radius.card, palette: palette)
    }
}

struct StatsEmptyNote: View {
    let text: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(RiffetFont.caption)
            .foregroundStyle(palette.fg3)
            .frame(maxWidth: .infinity, minHeight: 88, alignment: .center)
            .multilineTextAlignment(.center)
    }
}

/// Where the hover reading sits: right of the crosshair, or left of it when that would push the tip
/// out of the plot, and never past either edge of the plot area.
func usageTooltipX(anchor: CGFloat, width: CGFloat, frame: CGRect) -> CGFloat {
    let right = anchor + 12
    let left = anchor - 12 - width
    let preferred = right + width <= frame.maxX - 4 ? right : left
    return max(frame.minX + 4, min(preferred, frame.maxX - width - 4))
}

struct UsageChart: View {
    let series: StatsSeries
    /// `usageChartData(series)`, derived by the model when the series arrives.
    let data: UsageChartData
    let stale: Bool
    @Binding var metric: StatsSeriesMetric
    @Binding var split: StatsSplit
    @Binding var highlight: String?
    let onMetric: (StatsSeriesMetric) -> Void
    let onSplit: (StatsSplit) -> Void
    let onBrush: (Date, Date) -> Void
    @Environment(\.palette) private var palette
    /// The bucket under the pointer: it changes once per bucket, not on every pointer move.
    @State private var hover: Int?
    @State private var dragOrigin: CGFloat?
    @State private var dragCurrent: CGFloat?

    private static let metrics: [StatsSeriesMetric] = [.totalTokens, .inputTokens, .outputTokens, .cacheReadTokens, .runs]
    private static let splits: [StatsSplit] = [.backend, .model, .project]
    /// Wide enough for a label and a value on one line, narrow enough to leave the chart readable.
    private static let tooltipWidth: CGFloat = 208

    var body: some View {
        StatsCard(title: String(localized: "用量")) {
            HStack(spacing: Space.xxs) {
                chartMenu(String(localized: "指标"), selection: metricLabel(metric), options: Self.metrics.map { ($0, metricLabel($0)) }) { value in
                    if let next = Self.metrics.first(where: { metricLabel($0) == value }) { onMetric(next) }
                }
                chartMenu(String(localized: "拆分"), selection: splitLabel(split), options: Self.splits.map { ($0, splitLabel($0)) }) { value in
                    if let next = Self.splits.first(where: { splitLabel($0) == value }) { onSplit(next) }
                }
            }
        } content: {
            if !data.measured {
                StatsEmptyNote(text: String(localized: "这段时间没有测量。缺口不会画成 0。"))
            } else {
                chart(data)
                    .opacity(stale ? 0.45 : 1)
                legend(data)
            }
        }
    }

    private func chart(_ data: UsageChartData) -> some View {
        let colors = scaleColors(data)
        return Chart(data.marks) { mark in
            switch mark.kind {
            case .area:
                AreaMark(
                    x: .value("时间", mark.date),
                    yStart: .value("下", mark.y0),
                    yEnd: .value("上", mark.y1)
                )
                .foregroundStyle(by: .value("系列", mark.series))
                .interpolationMethod(.monotone)
                .opacity(dimmed(mark.layer) ? 0.16 : 0.38)
            case .line:
                LineMark(x: .value("时间", mark.date), y: .value("上", mark.y1))
                    .foregroundStyle(by: .value("系列", mark.series))
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .opacity(dimmed(mark.layer) ? 0.16 : 1)
            case .gap:
                LineMark(x: .value("时间", mark.date), y: .value("上", mark.y1))
                    .foregroundStyle(by: .value("系列", mark.series))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    .opacity(dimmed(mark.layer) ? 0.1 : 0.55)
            case .point:
                PointMark(x: .value("时间", mark.date), y: .value("上", mark.y1))
                    .foregroundStyle(by: .value("系列", mark.series))
                    .symbolSize(28)
                    .opacity(dimmed(mark.layer) ? 0.16 : 1)
            }
        }
        .chartForegroundStyleScale(domain: data.scaleDomain, range: colors)
        .chartLegend(.hidden)
        .chartYScale(domain: 0...data.yMax)
        .chartXScale(domain: xDomain(data))
        .chartXAxis {
            AxisMarks(values: axisDates(data)) { value in
                AxisValueLabel(anchor: value.index == 0 ? .leading : .trailing) {
                    if let date = value.as(Date.self) {
                        Text(formatBucket(date, granularity: series.granularity))
                            .font(.riffet(size: S(10)))
                            .foregroundStyle(palette.fg4)
                            .monospacedDigit()
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine().foregroundStyle(palette.lineSoft)
                AxisValueLabel {
                    if let number = value.as(Double.self) {
                        Text(axisLabel(number))
                            .font(.riffet(size: S(10)))
                            .foregroundStyle(palette.fg4)
                            .monospacedDigit()
                    }
                }
            }
        }
        .chartPlotStyle { plot in plot.frame(height: 220) }
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .statsContinuousHover { phase in
                        var bucket: Int?
                        if case let .active(location) = phase, let date = date(at: location, proxy: proxy, geo: geo) {
                            bucket = nearestBucket(data.dates, date)
                        }
                        if hover != bucket { hover = bucket }
                    }
                    .gesture(brush(proxy: proxy, geo: geo))
                if let dragOrigin, let dragCurrent, let frame = Optional(geo[proxy.plotAreaFrame]) {
                    let left = min(dragOrigin, dragCurrent)
                    let width = abs(dragCurrent - dragOrigin)
                    Rectangle()
                        .fill(palette.mark.opacity(0.12))
                        .overlay(Rectangle().stroke(palette.mark.opacity(0.45), lineWidth: 1))
                        .frame(width: width, height: frame.height)
                        .position(x: frame.minX + left + width / 2, y: frame.midY)
                        .allowsHitTesting(false)
                }
                // The reading for the hovered bucket floats over the plot, next to the crosshair: at
                // the bottom of the card it was a block that pushed the legend down on every move.
                if let hover, data.dates.indices.contains(hover) {
                    let frame = geo[proxy.plotAreaFrame]
                    let width = min(Self.tooltipWidth, max(120, frame.width - 8))
                    let anchor = frame.minX + (proxy.position(forX: data.dates[hover]) ?? frame.width / 2)
                    crosshair(at: anchor, frame: frame)
                    markers(data, index: hover, x: anchor, proxy: proxy, frame: frame)
                    tooltip(data, index: hover)
                        .frame(width: width, alignment: .leading)
                        .offset(x: usageTooltipX(anchor: anchor, width: width, frame: frame), y: frame.minY + 8)
                        .allowsHitTesting(false)
                }
            }
        }
        .accessibilityLabel("用量趋势")
    }

    private func crosshair(at x: CGFloat, frame: CGRect) -> some View {
        Path { path in
            path.move(to: CGPoint(x: x, y: frame.minY))
            path.addLine(to: CGPoint(x: x, y: frame.maxY))
        }
        .stroke(palette.fg4.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        .allowsHitTesting(false)
    }

    /// A dot per measured layer at the top of its band, so a floating tip and the shape it reads
    /// from are visibly the same bucket.
    private func markers(_ data: UsageChartData, index: Int, x: CGFloat, proxy: ChartProxy, frame: CGRect) -> some View {
        let colors = chartColors(palette)
        var stacked: [(slot: Int, top: Double)] = []
        var running = 0.0
        for layer in data.layers {
            let value = layer.reported.indices.contains(index) ? layer.reported[index] : nil
            running += value ?? 0
            if value != nil { stacked.append((layer.slot, running)) }
        }
        return ForEach(Array(stacked.enumerated()), id: \.offset) { _, point in
            Circle()
                .fill(colors[point.slot])
                .overlay(Circle().strokeBorder(palette.bgElevated, lineWidth: 1.5))
                .frame(width: 7, height: 7)
                .position(x: x, y: frame.minY + (proxy.position(forY: point.top) ?? frame.height))
                .allowsHitTesting(false)
        }
    }

    private func brush(proxy: ChartProxy, geo: GeometryProxy) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                let frame = geo[proxy.plotAreaFrame]
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                dragOrigin = min(max(value.startLocation.x, frame.minX), frame.maxX) - frame.minX
                dragCurrent = min(max(value.location.x, frame.minX), frame.maxX) - frame.minX
            }
            .onEnded { value in
                defer { dragOrigin = nil; dragCurrent = nil }
                guard abs(value.translation.width) > 4, abs(value.translation.width) > abs(value.translation.height) else { return }
                let frame = geo[proxy.plotAreaFrame]
                let startX = min(max(value.startLocation.x, frame.minX), frame.maxX) - frame.minX
                let endX = min(max(value.location.x, frame.minX), frame.maxX) - frame.minX
                guard let from: Date = proxy.value(atX: startX, as: Date.self), let to: Date = proxy.value(atX: endX, as: Date.self) else { return }
                onBrush(from, to)
            }
    }

    private func date(at location: CGPoint, proxy: ChartProxy, geo: GeometryProxy) -> Date? {
        let frame = geo[proxy.plotAreaFrame]
        let x = location.x - frame.minX
        guard x >= 0, x <= frame.width else { return nil }
        return proxy.value(atX: x, as: Date.self)
    }

    private func tooltip(_ data: UsageChartData, index: Int) -> some View {
        VStack(alignment: .leading, spacing: Space.xxs) {
            Text(formatBucket(data.dates[index], granularity: series.granularity))
                .font(.riffet(size: S(11), weight: .medium))
                .foregroundStyle(palette.fg)
                .monospacedDigit()
            ForEach(data.layers) { layer in
                HStack(spacing: Space.xs) {
                    Circle().fill(chartColors(palette)[layer.slot]).frame(width: 6, height: 6)
                    Text(layer.label).lineLimit(1).foregroundStyle(palette.fg2)
                    Spacer(minLength: Space.sm)
                    Text(layer.reported.indices.contains(index) ? formatMetric(layer.reported[index], metricFormat(series.metric)) : statsUnavailable)
                        .foregroundStyle(palette.fg)
                        .monospacedDigit()
                }
                .font(.riffet(size: S(11)))
            }
        }
        .padding(Space.sm)
        .background(palette.bgPopover, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
        .elevation(.pop)
    }

    private func legend(_ data: UsageChartData) -> some View {
        FlowRow(spacing: Space.md, lineSpacing: Space.xs) {
            ForEach(data.layers) { layer in
                Button {
                    highlight = highlight == layer.key ? nil : layer.key
                } label: {
                    HStack(spacing: 5) {
                        Circle().fill(chartColors(palette)[layer.slot]).frame(width: 6, height: 6)
                        Text(layer.label).lineLimit(1)
                    }
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(highlight == nil || highlight == layer.key ? palette.fg2 : palette.fg4)
                }
                .buttonStyle(.plain)
                .statsHover { inside in highlight = inside ? layer.key : (highlight == layer.key ? nil : highlight) }
            }
        }
    }

    private func dimmed(_ layer: String) -> Bool { highlight != nil && highlight != layer }

    private func xDomain(_ data: UsageChartData) -> ClosedRange<Date> {
        let start = data.dates.first ?? Date()
        let end = data.dates.last ?? start
        if end > start { return start...end }
        return start.addingTimeInterval(-1800)...start.addingTimeInterval(1800)
    }

    private func axisDates(_ data: UsageChartData) -> [Date] {
        guard let first = data.dates.first else { return [] }
        guard let last = data.dates.last, last != first else { return [first] }
        return [first, last]
    }

    private func axisLabel(_ value: Double) -> String {
        switch series.metric {
        case .runs, .sessions: formatCount(value)
        case .durationMs: formatDuration(value)
        default: formatTokens(value)
        }
    }

    private func scaleColors(_ data: UsageChartData) -> [Color] {
        let colors = chartColors(palette)
        let slot = Dictionary(uniqueKeysWithValues: data.layers.map { ($0.key, $0.slot) })
        var seen: [String: Color] = [:]
        for mark in data.marks where seen[mark.series] == nil {
            seen[mark.series] = colors[slot[mark.layer] ?? 0]
        }
        return data.scaleDomain.map { seen[$0] ?? colors[0] }
    }

    private func chartMenu<T>(_ title: String, selection: String, options: [(T, String)], choose: @escaping (String) -> Void) -> some View {
        Menu {
            Section(title) {
                ForEach(options, id: \.1) { _, label in
                    Button(label) { choose(label) }
                }
            }
        } label: {
            ChipLabel(text: selection)
        }
        .menuStyle(.button)
        .buttonStyle(ChipButtonStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help(title)
    }
}

struct DonutChart: View {
    let breakdown: StatsBreakdown
    @Binding var highlight: String?
    @Environment(\.palette) private var palette

    var body: some View {
        let built = donutSlices(breakdown.rows)
        StatsCard(title: "Agent") { EmptyView() } content: {
            if built.slices.isEmpty {
                StatsEmptyNote(text: String(localized: "还没有可分成的用量"))
            } else {
                Chart(built.slices) { slice in
                    SectorMark(angle: .value("值", slice.value), innerRadius: .ratio(0.64), angularInset: built.slices.count > 1 ? 1.5 : 0)
                        .cornerRadius(4)
                        .foregroundStyle(by: .value("项", slice.key))
                        .opacity(highlight == nil || highlight == slice.key ? 1 : 0.16)
                }
                .chartForegroundStyleScale(domain: built.slices.map(\.key), range: built.slices.map { chartColors(palette)[$0.slot] })
                .chartLegend(.hidden)
                .frame(height: 220)
                .overlay {
                    VStack(spacing: 2) {
                        Text(centerValue(built.slices, basis: built.basis)).font(.riffet(size: S(16), weight: .semibold)).foregroundStyle(palette.fg).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                        Text(centerCaption(built)).font(.riffet(size: S(11))).foregroundStyle(palette.fg4).lineLimit(1)
                    }
                    .allowsHitTesting(false)
                }
                legend(built.slices, basis: built.basis)
            }
        }
    }

    private func centerValue(_ slices: [DonutSlice], basis: String) -> String {
        if let highlight, let slice = slices.first(where: { $0.key == highlight }) {
            return formatPercent(slice.share)
        }
        let total = slices.reduce(0) { $0 + $1.value }
        return basis == "Token" ? formatTokens(total) : formatCount(total)
    }

    private func centerCaption(_ built: (slices: [DonutSlice], basis: String)) -> String {
        if let highlight, let slice = built.slices.first(where: { $0.key == highlight }) { return slice.label }
        return built.basis
    }

    private func legend(_ slices: [DonutSlice], basis: String) -> some View {
        FlowRow(spacing: Space.md, lineSpacing: Space.xs) {
            ForEach(slices) { slice in
                HStack(spacing: 5) {
                    Circle().fill(chartColors(palette)[slice.slot]).frame(width: 6, height: 6)
                    Text(slice.label).lineLimit(1)
                    Text(basis == "Token" ? formatTokens(slice.value) : formatCount(slice.value))
                        .foregroundStyle(palette.fg4)
                        .monospacedDigit()
                }
                .font(.riffet(size: S(11)))
                .foregroundStyle(highlight == nil || highlight == slice.key ? palette.fg2 : palette.fg4)
                .statsHover { inside in highlight = inside ? slice.key : (highlight == slice.key ? nil : highlight) }
            }
        }
    }
}

struct CalendarHeatmap: View {
    /// The heatmap's days in date order.
    let days: [StatsHeatmapDay]
    @Environment(\.palette) private var palette
    @State private var picked: String?

    var body: some View {
        let maxRuns = days.map(\.runs).max() ?? 0
        StatsCard(title: String(localized: "每日活跃")) { EmptyView() } content: {
            if days.isEmpty {
                StatsEmptyNote(text: String(localized: "这段时间没有每日记录"))
            } else {
                HStack {
                    Text(days[0].date).font(.riffet(size: S(11))).foregroundStyle(palette.fg4).monospacedDigit()
                    Spacer()
                    if days.count > 1 {
                        Text(days[days.count - 1].date).font(.riffet(size: S(11))).foregroundStyle(palette.fg4).monospacedDigit()
                    }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    // One canvas with one hover handler: a view per day, each tracking the pointer,
                    // made the page stutter while it scrolled.
                    let pickedIndex = days.firstIndex { $0.date == picked }
                    let mark = palette.mark
                    Canvas { context, size in
                        for (index, day) in days.enumerated() {
                            let rect = CGRect(x: CGFloat(index) * Self.pitch, y: 0, width: Self.cell.width, height: Self.cell.height)
                            drawHeatCell(context, rect: rect, level: heatLevel(Double(day.runs), max: Double(maxRuns)), corner: 3, picked: index == pickedIndex, palette: palette, mark: mark)
                        }
                    }
                    .frame(width: CGFloat(days.count) * Self.pitch - (Self.pitch - Self.cell.width), height: Self.cell.height)
                    .contentShape(Rectangle())
                    .statsContinuousHover { phase in
                        if case let .active(location) = phase, let day = day(at: location, days), picked != day.date { picked = day.date }
                    }
                    .onTapGesture { location in if let day = day(at: location, days) { picked = day.date } }
                    .accessibilityElement()
                    .accessibilityLabel("每日活跃，\(days.count) 天")
                    .padding(.vertical, 2)
                }
                Text(caption(days))
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .monospacedDigit()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(1)
            }
        }
    }

    private static let cell = CGSize(width: 11, height: 18)
    private static let pitch: CGFloat = 14

    private func day(at location: CGPoint, _ days: [StatsHeatmapDay]) -> StatsHeatmapDay? {
        let index = Int(location.x / Self.pitch)
        guard days.indices.contains(index), location.x - CGFloat(index) * Self.pitch <= Self.cell.width else { return nil }
        return days[index]
    }

    private func caption(_ days: [StatsHeatmapDay]) -> String {
        // A blank line until a day is picked, so the card keeps its height.
        guard let picked, let day = days.first(where: { $0.date == picked }) else { return " " }
        return String(localized: "\(day.date) · \(formatCount(Double(day.runs))) 轮 · \(formatTokens(Double(day.totalTokens)))")
    }

}

struct WeekHeatmap: View {
    /// `weekGrid(heatmap)`: runs by weekday and hour.
    let grid: [[Int64]]?
    @Environment(\.palette) private var palette
    @State private var picked: (Int, Int)?
    @State private var width: CGFloat = 480

    /// A weekday label column and an hour label row around 24 × 7 square cells, 2pt apart.
    private struct WeekLayout {
        let origin = CGPoint(x: 16, y: 14)
        let pitch: CGFloat
        let cell: CGFloat

        init(width: CGFloat) {
            cell = max(4, (width - 16 - 23 * 2) / 24)
            pitch = cell + 2
        }

        var height: CGFloat { origin.y + 7 * pitch - 2 }

        func cell(at point: CGPoint) -> (Int, Int)? {
            let hour = Int((point.x - origin.x) / pitch)
            let weekday = Int((point.y - origin.y) / pitch)
            guard point.x >= origin.x, point.y >= origin.y, (0..<24).contains(hour), (0..<7).contains(weekday) else { return nil }
            return (weekday, hour)
        }
    }

    var body: some View {
        StatsCard(title: String(localized: "活跃时段")) { EmptyView() } content: {
            if let grid {
                let maxRuns = grid.flatMap { $0 }.max() ?? 0
                VStack(alignment: .leading, spacing: Space.xs) {
                    // 168 cells drawn on one canvas, with one hover handler (see `CalendarHeatmap`).
                    let layout = WeekLayout(width: width)
                    let mark = palette.mark
                    Canvas { context, _ in
                        for hour in stride(from: 0, to: 24, by: 6) {
                            let x = layout.origin.x + CGFloat(hour) * layout.pitch + layout.cell / 2
                            context.draw(Text("\(hour)").font(.riffet(size: S(9))).foregroundStyle(palette.fg4).monospacedDigit(), at: CGPoint(x: x, y: 6))
                        }
                        for weekday in 0..<7 {
                            let y = layout.origin.y + CGFloat(weekday) * layout.pitch
                            context.draw(Text(statsWeekdays[weekday]).font(.riffet(size: S(10))).foregroundStyle(palette.fg4), at: CGPoint(x: 7, y: y + layout.cell / 2))
                            for hour in 0..<24 {
                                let rect = CGRect(x: layout.origin.x + CGFloat(hour) * layout.pitch, y: y, width: layout.cell, height: layout.cell)
                                let isPicked = picked?.0 == weekday && picked?.1 == hour
                                drawHeatCell(context, rect: rect, level: heatLevel(Double(grid[weekday][hour]), max: Double(maxRuns)), corner: 2, picked: isPicked, palette: palette, mark: mark)
                            }
                        }
                    }
                    .frame(height: layout.height)
                    .frame(maxWidth: .infinity)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
                    .contentShape(Rectangle())
                    .statsContinuousHover { phase in
                        if case let .active(location) = phase, let cell = layout.cell(at: location), picked?.0 != cell.0 || picked?.1 != cell.1 { picked = cell }
                    }
                    .accessibilityElement()
                    .accessibilityLabel("活跃时段，按星期和小时")
                    if let picked {
                        Text("周\(statsWeekdays[picked.0]) \(picked.1):00 · \(formatCount(Double(grid[picked.0][picked.1]))) 轮")
                            .font(.riffet(size: S(12)))
                            .foregroundStyle(palette.fg3)
                            .monospacedDigit()
                    }
                }
            } else {
                StatsEmptyNote(text: String(localized: "没有时段分布"))
            }
        }
    }
}

struct RankChart: View {
    /// The first eight models by [rank].
    let rows: [StatsBreakdownRow]
    @Binding var rank: RankMetric
    @Binding var highlight: String?
    @Environment(\.palette) private var palette

    var body: some View {
        let maxValue = rows.map { rankValue($0, rank) }.filter(\.isFinite).max() ?? 0
        StatsCard(title: String(localized: "模型排行")) {
            segmented(RankMetric.allCases.map(\.label), selected: rank.label) { label in
                if let next = RankMetric.allCases.first(where: { $0.label == label }) { rank = next }
            }
        } content: {
            if rows.isEmpty {
                StatsEmptyNote(text: String(localized: "还没有模型数据"))
            } else {
                VStack(spacing: Space.sm) {
                    ForEach(rows, id: \.key) { row in
                        barRow(title: row.label, value: rankText(row), width: barWidth(rankValue(row, rank), max: maxValue), dimmed: highlight != nil && highlight != row.key, failed: nil)
                            .statsHover { inside in highlight = inside ? row.key : (highlight == row.key ? nil : highlight) }
                    }
                }
            }
        }
    }

    private func rankText(_ row: StatsBreakdownRow) -> String {
        switch rank {
        case .runs: formatCount(Double(row.count))
        case .speed: row.outputTokensPerSecond.map { formatSpeed($0.p50) } ?? statsUnavailable
        case .tokens: formatTokens(Double(row.totalTokens))
        }
    }
}

struct LatencyChart: View {
    let latency: StatsLatency?
    let error: String?
    /// The speed windows of the models that report a speed.
    let speedWindows: [String]
    @Binding var kind: LatencyMetric
    @Binding var highlight: String?
    @Environment(\.palette) private var palette
    @State private var showAll = false

    private static let shown = 8

    var body: some View {
        let rows = (latency?.rows ?? []).filter { latencySample($0, kind) != nil }
        let maxValue = niceUpper(rows.compactMap { latencySample($0, kind)?.p99 }.max() ?? 0)
        StatsCard(title: String(localized: "延迟与速度")) {
            segmented(LatencyMetric.allCases.map(\.label), selected: kind.label) { label in
                if let next = LatencyMetric.allCases.first(where: { $0.label == label }) { kind = next }
            }
        } content: {
            if latency == nil {
                StatsEmptyNote(text: error ?? String(localized: "延迟还在加载"))
            } else if rows.isEmpty {
                StatsEmptyNote(text: String(localized: "这些模型没有这项测量"))
            } else {
                VStack(alignment: .leading, spacing: Space.sm) {
                    // The busiest models first, as many as the ranking beside it shows.
                    ForEach(showAll ? rows : Array(rows.prefix(Self.shown)), id: \.key) { row in
                        if let sample = latencySample(row, kind) {
                            latencyRow(row, sample: sample, max: maxValue)
                                .statsHover { inside in highlight = inside ? row.key : (highlight == row.key ? nil : highlight) }
                        }
                    }
                    if rows.count > Self.shown {
                        Button(showAll ? "收起" : "显示全部 \(rows.count) 个模型") { showAll.toggle() }
                            .buttonStyle(.plain)
                            .font(.riffet(size: S(11.5)))
                            .foregroundStyle(palette.fg3)
                    }
                    HStack {
                        Text("数字为 p50，条为 p50–p90，刻度为 p99")
                            .font(.riffet(size: S(11)))
                            .foregroundStyle(palette.fg4)
                        Spacer()
                        Text("\(axis(0)) – \(axis(maxValue))")
                            .font(.riffet(size: S(11)))
                            .foregroundStyle(palette.fg4)
                            .monospacedDigit()
                    }
                    if kind == .speed {
                        let windows = speedWindows
                        if !windows.isEmpty {
                            Text("速度窗口 \(windows.count) 种")
                                .font(.riffet(size: S(11)))
                                .foregroundStyle(palette.fg4)
                                .help("速度窗口：\(windows.joined(separator: " · "))")
                        }
                    }
                    if let latency, latency.rows.count > rows.count {
                        Text("另有 \(latency.rows.count - rows.count) 个模型未测量")
                            .font(.riffet(size: S(11)))
                            .foregroundStyle(palette.fg4)
                            .help("这些模型没有这项测量。缺失不按 0 计入。")
                    }
                }
            }
        }
    }

    /// One line like the ranking's rows: the name, the p50–p90 bar with a p99 tick, then p50.
    private func latencyRow(_ row: StatsLatencyRow, sample: StatsPercentiles, max maxValue: Double) -> some View {
        HStack(spacing: Space.sm) {
            Text(row.label)
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg2)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: statsNameWidth, alignment: .leading)
                .help(row.label)
            GeometryReader { geo in
                let start = position(min(sample.p50, sample.p90), max: maxValue, width: geo.size.width)
                let end = position(max(sample.p50, sample.p90), max: maxValue, width: geo.size.width)
                let p99 = position(sample.p99, max: maxValue, width: geo.size.width)
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.bgMuted).frame(height: 6)
                    Capsule().fill(palette.mark).frame(width: max(end - start, 3), height: 6).offset(x: start)
                    Rectangle().fill(palette.fg3).frame(width: 1, height: 10).offset(x: min(p99, geo.size.width - 1))
                }
                .frame(maxHeight: .infinity)
            }
            .frame(height: 10)
            Text(axis(sample.p50))
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg)
                .monospacedDigit()
                .lineLimit(1)
                .frame(minWidth: 64, alignment: .trailing)
                .help("p50 \(axis(sample.p50)) · p90 \(axis(sample.p90)) · p99 \(axis(sample.p99))")
        }
        .opacity(highlight == nil || highlight == row.key ? 1 : 0.4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.label)，p50 \(axis(sample.p50))，p90 \(axis(sample.p90))，p99 \(axis(sample.p99))")
    }

    private func position(_ value: Double, max maxValue: Double, width: CGFloat) -> CGFloat {
        guard maxValue > 0 else { return 0 }
        return CGFloat(min(max(value, 0), maxValue) / maxValue) * width
    }

    private func axis(_ value: Double) -> String { kind == .speed ? formatSpeed(value) : formatDuration(value) }
}

struct ReliabilityChart: View {
    let breakdown: StatsBreakdown
    @Binding var highlight: String?
    @Environment(\.palette) private var palette

    var body: some View {
        let rows = breakdown.rows.filter { reliabilityTotal($0) > 0 }
        StatsCard(title: String(localized: "结束状态")) { EmptyView() } content: {
            if rows.isEmpty {
                StatsEmptyNote(text: String(localized: "还没有已结束的轮次"))
            } else {
                VStack(alignment: .leading, spacing: Space.sm) {
                    ForEach(rows, id: \.key) { row in
                        reliabilityRow(row)
                            .statsHover { inside in highlight = inside ? row.key : (highlight == row.key ? nil : highlight) }
                    }
                    FlowRow(spacing: Space.md, lineSpacing: Space.xs) {
                        legendDot(palette.success, String(localized: "完成"))
                        legendDot(palette.danger, String(localized: "失败"))
                        legendDot(palette.fg4, String(localized: "取消"))
                        legendDot(palette.warning, String(localized: "中断"))
                    }
                }
            }
        }
    }

    private func reliabilityRow(_ row: StatsBreakdownRow) -> some View {
        let total = Double(reliabilityTotal(row))
        return HStack(spacing: Space.sm) {
            Text(row.label).font(.riffet(size: S(12))).foregroundStyle(palette.fg2).lineLimit(1).frame(width: 88, alignment: .leading)
            GeometryReader { geo in
                HStack(spacing: 0) {
                    segment(palette.success, Double(row.states.completed) / total, geo.size.width)
                    segment(palette.danger, Double(row.states.failed) / total, geo.size.width)
                    segment(palette.fg4, Double(row.states.cancelled) / total, geo.size.width)
                    segment(palette.warning, Double(row.states.interrupted) / total, geo.size.width)
                }
                .clipShape(Capsule())
            }
            .frame(height: 6)
            Text(formatCount(total)).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).monospacedDigit().frame(width: 48, alignment: .trailing)
        }
        .opacity(highlight == nil || highlight == row.key ? 1 : 0.4)
    }

    private func segment(_ color: Color, _ share: Double, _ width: CGFloat) -> some View {
        color.frame(width: max(0, share) * width)
    }
}

struct ToolChart: View {
    /// The first eight tools by calls.
    let rows: [StatsBreakdownRow]
    @Binding var highlight: String?
    @Environment(\.palette) private var palette

    var body: some View {
        let maxCount = rows.map(\.count).max() ?? 0
        StatsCard(title: String(localized: "工具")) { EmptyView() } content: {
            if rows.isEmpty {
                StatsEmptyNote(text: String(localized: "还没有工具调用"))
            } else {
                VStack(alignment: .leading, spacing: Space.sm) {
                    ForEach(rows, id: \.key) { row in
                        let failed = row.failed?.int64Value ?? 0
                        barRow(
                            title: row.label,
                            value: failed > 0 ? "\(formatCount(Double(row.count))) · \(formatCount(Double(failed)))" : formatCount(Double(row.count)),
                            width: barWidth(Double(row.count), max: Double(maxCount)),
                            dimmed: highlight != nil && highlight != row.key,
                            failed: row.count > 0 ? Double(failed) / Double(row.count) : nil
                        )
                        .statsHover { inside in highlight = inside ? row.key : (highlight == row.key ? nil : highlight) }
                    }
                    if rows.contains(where: { ($0.failed?.int64Value ?? 0) > 0 }) {
                        HStack(spacing: 5) {
                            Circle().fill(palette.danger).frame(width: 6, height: 6)
                            Text("失败调用").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                        }
                    }
                }
            }
        }
    }
}

struct FlowRow: Layout {
    var spacing: CGFloat = Space.sm
    var lineSpacing: CGFloat = Space.xs

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let limit = proposal.width ?? 420
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > limit {
                x = 0
                y += line + lineSpacing
                line = 0
            }
            line = max(line, size.height)
            x += size.width + spacing
        }
        return CGSize(width: limit, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += line + lineSpacing
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            line = max(line, size.height)
            x += size.width + spacing
        }
    }
}

private func reliabilityTotal(_ row: StatsBreakdownRow) -> Int64 {
    row.states.completed + row.states.failed + row.states.cancelled + row.states.interrupted
}

private func barWidth(_ value: Double, max maxValue: Double) -> Double {
    guard value.isFinite, value > 0, maxValue > 0 else { return 0 }
    return max(value / maxValue, 0.02)
}

/// The name column of every bar list, so the bars of cards side by side start at one edge.
private let statsNameWidth: CGFloat = 132

@ViewBuilder
private func barRow(title: String, value: String, width: Double, dimmed: Bool, failed: Double?) -> some View {
    BarRow(title: title, value: value, width: width, dimmed: dimmed, failed: failed)
}

private struct BarRow: View {
    let title: String
    let value: String
    let width: Double
    let dimmed: Bool
    let failed: Double?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            Text(title).font(.riffet(size: S(12))).foregroundStyle(palette.fg2).lineLimit(1).truncationMode(.middle).frame(width: statsNameWidth, alignment: .leading).help(title)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.bgMuted)
                    Capsule().fill(palette.mark).frame(width: max(0, geo.size.width * width))
                    if let failed, failed > 0 {
                        Rectangle()
                            .fill(palette.danger)
                            .frame(width: max(0, geo.size.width * width * min(failed, 1)))
                    }
                }
                .clipShape(Capsule())
            }
            .frame(height: 6)
            Text(value).font(.riffet(size: S(12))).foregroundStyle(palette.fg).monospacedDigit().lineLimit(1).frame(minWidth: 64, alignment: .trailing)
        }
        .opacity(dimmed ? 0.4 : 1)
    }
}

private extension View {
    func segmented(_ options: [String], selected: String, choose: @escaping (String) -> Void) -> some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button(option) { choose(option) }
            }
        } label: {
            ChipLabel(text: selected)
        }
        .menuStyle(.button)
        .buttonStyle(ChipButtonStyle())
        .menuIndicator(.hidden)
        .fixedSize()
    }

    func legendDot(_ color: Color, _ title: String) -> some View {
        LegendDot(color: color, title: title)
    }
}

private struct LegendDot: View {
    let color: Color
    let title: String
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(title).font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
        }
    }
}

private func metricLabel(_ metric: StatsSeriesMetric) -> String {
    switch metric {
    case .totalTokens: String(localized: "总 token")
    case .inputTokens: String(localized: "输入")
    case .outputTokens: String(localized: "输出")
    case .cacheReadTokens: String(localized: "缓存读")
    case .runs: String(localized: "轮次")
    case .sessions: String(localized: "会话")
    case .durationMs: String(localized: "耗时")
    }
}

private func metricFormat(_ metric: StatsSeriesMetric) -> KpiFormat {
    switch metric {
    case .runs, .sessions: .count
    case .durationMs: .duration
    default: .tokens
    }
}

private func splitLabel(_ split: StatsSplit) -> String {
    switch split {
    case .backend: "Agent"
    case .model: String(localized: "模型")
    case .project: String(localized: "项目")
    }
}

private func drawHeatCell(_ context: GraphicsContext, rect: CGRect, level: Int, corner: CGFloat, picked: Bool, palette: Palette, mark: Color) {
    let shape = Path(roundedRect: rect, cornerRadius: corner, style: .continuous)
    context.fill(shape, with: .color(palette.bgMuted))
    context.fill(shape, with: .color(mark.opacity(statsHeatAlpha[min(max(level, 0), statsHeatAlpha.count - 1)])))
    if picked { context.stroke(Path(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: corner, style: .continuous), with: .color(palette.fg), lineWidth: 1) }
}
