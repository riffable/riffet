import AppKit
import Charts
import SwiftUI
import RiffetKit

/// The connected service's load, requests and process tree, read every 5 seconds while it is on
/// screen and `active`. A failed read keeps the last snapshot and says so in the status line.
/// Hosted by the workbench's 活动 page; 本机服务器 in settings links there.
struct ServiceMonitorDashboard: View {
    /// A host that keeps the view alive while showing something else turns polling off with this.
    var active = true
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var snapshot: ServiceMonitorSnapshot?
    /// The last read's failure; the status line says the numbers are stale while it is set.
    @State private var error: String?
    /// A failed stop, kept until the next one: a successful read must not hide it.
    @State private var actionError: String?
    @State private var pendingStop: ServiceProcess?
    @State private var stopping: Int32?
    @State private var visibility = PaneVisibility()

    private static let interval: Duration = .seconds(5)

    var body: some View {
        ZStack {
            if model.workbench == nil {
                DisconnectedSettings(detail: String(localized: "连接服务器后可查看。"))
            } else if let snapshot {
                form(snapshot)
            } else if let error {
                ContentUnavailableView {
                    Label("无法读取服务器状态", icon: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("重试") { Task { await load() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(PaneVisibilityProbe(visibility: visibility))
        .task(id: active) {
            guard active else { return }
            while !Task.isCancelled {
                if snapshot == nil || visibility.onScreen { await load() }
                try? await Task.sleep(for: Self.interval)
            }
        }
        .confirmationDialog("结束这个进程？", isPresented: Binding(get: { pendingStop != nil }, set: { if !$0 { pendingStop = nil } }), titleVisibility: .visible, presenting: pendingStop) { process in
            Button("结束进程", role: .destructive) {
                pendingStop = nil
                Task { await terminate(process.pid) }
            }
            Button("取消", role: .cancel) { pendingStop = nil }
        } message: { process in
            Text("\(process.name)（PID \(String(process.pid))）正在执行的工作会中断。")
        }
    }

    private func form(_ snapshot: ServiceMonitorSnapshot) -> some View {
        let samples = snapshot.series
        return Form {
            // The status line leads: it is the answer to "is this service healthy" before any chart.
            Section {
                VStack(alignment: .leading, spacing: Space.sm) {
                    header(snapshot)
                    SettingsErrorText(message: actionError ?? error)
                }
                .padding(.vertical, Space.xs)
            }
            SettingsBlock("概览") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: Space.md)], spacing: Space.md) {
                    tiles(snapshot, samples)
                }
                .padding(.vertical, Space.xs)
            }
            SettingsBlock("最近 30 分钟") {
                if samples.count < 2 {
                    Text("采样还不够，稍后再看。")
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.fg3)
                } else {
                    // The series gains a point every 10 seconds; the 5-second polls in between leave
                    // the charts as they are.
                    MonitorRequestChart(samples: samples).equatable()
                    MonitorLoadChart(samples: samples).equatable()
                }
            }
            SettingsBlock("请求分布", detail: "自启动以来。") {
                MonitorStatusSplit(counts: snapshot.requests.byStatus).equatable()
                if !snapshot.requests.topRoutes.isEmpty {
                    MonitorRoutes(routes: snapshot.requests.topRoutes).equatable()
                }
            }
            SettingsBlock("进程") {
                processes(snapshot.processes)
            }
            SettingsBlock("服务器信息") {
                info(snapshot)
            }
        }
        .riffetForm()
    }

    // MARK: - Header and tiles

    private func header(_ snapshot: ServiceMonitorSnapshot) -> some View {
        HStack(spacing: Space.sm) {
            if error != nil {
                Circle().fill(palette.warning).frame(width: 8, height: 8)
                Text("读取失败，显示上次结果")
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
            }
            Text("已运行 \(monitorUptime(snapshot.process.uptimeSec)) · v\(snapshot.process.version)")
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg3)
            Spacer(minLength: Space.sm)
            Text("更新于 \(monitorClock(snapshot.generatedAt))")
                .font(.riffet(size: S(11)))
                .foregroundStyle(palette.fg4)
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private func tiles(_ snapshot: ServiceMonitorSnapshot, _ samples: [ServiceMonitorSample]) -> some View {
        let process = snapshot.process
        let requests = snapshot.requests
        let host = snapshot.host
        let loop = snapshot.eventLoop
        let load = host.loadAvg.map(\.doubleValue)
        let cores = Double(max(host.cpuCount, 1))
        let usedMem = Double(host.totalMemBytes - host.freeMemBytes)
        let errors = requests.byStatus.status5xx
        MonitorTile(
            title: "CPU", symbol: "cpu", value: monitorPercent(process.cpuPercent),
            detail: String(localized: "单核占比"), tint: palette.chart1, spark: samples.map(\.cpuPercent)
        )
        .equatable()
        MonitorTile(
            title: String(localized: "内存"), symbol: "memorychip", value: monitorBytes(process.rssBytes),
            detail: String(localized: "堆 \(monitorBytes(process.heapUsedBytes)) / \(monitorBytes(process.heapTotalBytes))"),
            tint: palette.chart2, spark: samples.map { Double($0.rssBytes) }
        )
        .equatable()
        MonitorTile(
            title: String(localized: "请求/分钟"), symbol: "arrow.left.arrow.right", value: formatCount(requests.perMinute),
            detail: String(localized: "进行中 \(requests.inFlight) · 共 \(formatCount(Double(requests.total)))"),
            tint: palette.accent, spark: samples.map { Double($0.requests) }
        )
        .equatable()
        MonitorTile(
            title: String(localized: "延迟"), symbol: "timer", value: formatDuration(requests.avgMs),
            detail: String(localized: "平均 · P95 \(formatDuration(requests.p95Ms))"),
            tint: palette.chart3, spark: samples.filter { $0.requests > 0 }.map(\.avgMs)
        )
        .equatable()
        MonitorTile(
            title: String(localized: "错误"), symbol: "exclamationmark.triangle", value: formatCount(Double(errors)),
            detail: "5xx · 4xx \(formatCount(Double(requests.byStatus.status4xx)))",
            tint: errors > 0 ? palette.danger : palette.fg3, spark: samples.map { Double($0.errors) }
        )
        .equatable()
        MonitorTile(
            title: String(localized: "事件循环延迟"), symbol: "arrow.trianglehead.2.clockwise", value: formatDuration(loop.recentLagMs),
            detail: String(localized: "P99 \(formatDuration(loop.p99Ms)) · 占用 \(formatPercent(loop.utilization))"),
            tint: loop.stalls > 0 ? palette.warning : palette.chart4, spark: samples.map(\.loopLagMs)
        )
        .equatable()
        MonitorTile(
            title: String(localized: "系统负载"), symbol: "gauge.with.dots.needle.33percent",
            value: load.first.map { String(format: "%.2f", $0) } ?? statsUnavailable,
            detail: load.count == 3 ? String(format: String(localized: "5/15 分钟 %.2f / %.2f · %d 核"), load[1], load[2], host.cpuCount) : String(localized: "\(host.cpuCount) 核"),
            tint: (load.first ?? 0) > cores ? palette.warning : palette.chart5,
            meter: (load.first ?? 0) / cores
        )
        .equatable()
        MonitorTile(
            title: String(localized: "系统内存"), symbol: "square.stack.3d.up",
            value: formatPercent(host.totalMemBytes > 0 ? usedMem / Double(host.totalMemBytes) : nil),
            detail: "\(monitorBytes(Int64(usedMem))) / \(monitorBytes(host.totalMemBytes))",
            tint: palette.chart6,
            meter: host.totalMemBytes > 0 ? usedMem / Double(host.totalMemBytes) : 0
        )
        .equatable()
    }

    // MARK: - Processes

    private struct ProcessRow: Identifiable {
        let process: ServiceProcess
        let depth: Int
        var id: Int32 { process.pid }
    }

    /// Server first, then each process under its parent; anything whose parent is not listed is a root.
    private func processRows(_ list: [ServiceProcess]) -> [ProcessRow] {
        let pids = Set(list.map(\.pid))
        let children = Dictionary(grouping: list, by: \.ppid)
        func order(_ a: ServiceProcess, _ b: ServiceProcess) -> Bool {
            let ra = monitorKindRank(a.kind), rb = monitorKindRank(b.kind)
            return ra != rb ? ra < rb : a.pid < b.pid
        }
        var rows: [ProcessRow] = []
        var seen = Set<Int32>()
        func visit(_ process: ServiceProcess, _ depth: Int) {
            guard seen.insert(process.pid).inserted else { return }
            rows.append(ProcessRow(process: process, depth: depth))
            for child in (children[process.pid] ?? []).sorted(by: order) { visit(child, depth + 1) }
        }
        for root in list.filter({ !pids.contains($0.ppid) || $0.ppid == $0.pid }).sorted(by: order) { visit(root, 0) }
        // A parent loop would hide its members; show them flat rather than not at all.
        for process in list.sorted(by: order) where !seen.contains(process.pid) { visit(process, 0) }
        return rows
    }

    @ViewBuilder
    private func processes(_ list: [ServiceProcess]) -> some View {
        if list.isEmpty {
            Text("没有读到进程信息。")
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg3)
        } else {
            HStack(spacing: Space.sm) {
                Text("进程").frame(maxWidth: .infinity, alignment: .leading)
                Text("CPU").frame(width: 72, alignment: .trailing)
                Text("内存").frame(width: 64, alignment: .trailing)
                Text("运行").frame(width: 64, alignment: .trailing)
                MonitorStopButton(process: nil, stopping: nil) { _ in }.hidden()
            }
            .font(.riffet(size: S(11)))
            .foregroundStyle(palette.fg4)
            // A row redraws only when what it shows changes, not on every poll.
            ForEach(processRows(list)) { row in
                MonitorProcessRow(process: row.process, depth: row.depth, stopping: stopping) { pendingStop = $0 }
                    .equatable()
            }
        }
    }

    // MARK: - Service info

    @ViewBuilder
    private func info(_ snapshot: ServiceMonitorSnapshot) -> some View {
        let process = snapshot.process
        let host = snapshot.host
        LabeledContent("PID") { Text(String(process.pid)).monospacedDigit().textSelection(.enabled) }
        LabeledContent("版本") { Text(process.version).textSelection(.enabled) }
        LabeledContent("Node") { Text(process.nodeVersion) }
        LabeledContent("平台") { Text("\(process.platform) · \(process.arch)") }
        LabeledContent("启动于") { Text(formatExactTimestamp(process.startedAt)).monospacedDigit() }
        LabeledContent("运行时长") { Text(monitorUptime(process.uptimeSec)) }
        LabeledContent("电脑") {
            VStack(alignment: .trailing, spacing: 2) {
                Text(host.hostname).textSelection(.enabled)
                Text("\(host.cpuModel) · \(host.cpuCount) 核 · 已开机 \(monitorUptime(host.uptimeSec))")
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        LabeledContent("连接") {
            Text("事件流 \(snapshot.connections.eventStreams) · 终端 \(snapshot.connections.terminalSockets)")
        }
        LabeledContent("终端") { Text("在线 \(snapshot.terminals.live) / 共 \(snapshot.terminals.total)") }
        LabeledContent("会话") {
            Text("运行中 \(snapshot.sessions.running) · 等待 \(snapshot.sessions.waiting) · 共 \(snapshot.sessions.total)")
        }
        LabeledContent("事件循环卡顿") {
            Text(stallText(snapshot.eventLoop))
                .foregroundStyle(snapshot.eventLoop.stalls == 0 ? palette.fg2 : palette.warning)
        }
    }

    private func stallText(_ loop: ServiceEventLoop) -> String {
        guard loop.stalls > 0 else { return String(localized: "无") }
        var text = String(localized: "\(loop.stalls) 次 · 最长 \(formatDuration(loop.maxMs))")
        if let last = loop.lastStallAt { text += String(localized: " · 最近 \(formatExactTimestamp(last))") }
        return text
    }

    // MARK: - Actions

    private func load() async {
        guard let api = model.workbench?.host.api else { return }
        do {
            snapshot = try await api.serviceMonitor()
            error = nil
        } catch is CancellationError {
            return
        } catch {
            if !Task.isCancelled { self.error = error.riffetMessage }
        }
    }

    private func terminate(_ pid: Int32) async {
        guard let api = model.workbench?.host.api else { return }
        stopping = pid
        actionError = nil
        do {
            try await api.terminateServiceProcess(pid: pid)
        } catch {
            actionError = error.riffetMessage
        }
        stopping = nil
        await load()
    }
}

// MARK: - Reclaim

/// When the server stops the CLIs of conversations nobody uses; the next message resumes them.
/// A setting of 本机服务器, next to the service it governs.
struct ServiceReclaimSection: View {
    let workbench: Workbench
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let idle = workbench.settings?.idleReclaimMinutes?.intValue ?? defaultIdleReclaimMinutes
        let maxLive = workbench.settings?.maxLiveAgents?.intValue ?? defaultMaxLiveAgents
        SettingsBlock("资源回收", scope: .server, detail: "停止后发消息即可恢复；CLI 后台任务会结束。") {
            Picker("空闲后停止 CLI", selection: binding(current: idle) { SettingsPatch.make(idleReclaimMinutes: $0) }) {
                ForEach(presetsWithCurrent(idleReclaimPresets, idle), id: \.self) { Text(idleReclaimLabel($0)).tag($0) }
            }
            .formPicker()
            .disabled(busy)
            Picker("最多同时运行", selection: binding(current: maxLive) { SettingsPatch.make(maxLiveAgents: $0) }) {
                ForEach(presetsWithCurrent(maxLiveAgentsPresets, maxLive), id: \.self) { Text($0 == 0 ? "不限" : "\($0) 个").tag($0) }
            }
            .formPicker()
            .disabled(busy)
            SettingsErrorText(message: error)
        }
    }

    private func binding(current: Int, patch: @escaping (Int) -> AppSettingsUpdate) -> Binding<Int> {
        Binding(get: { current }, set: { next in
            guard next != current, !busy else { return }
            Task { await save(patch(next)) }
        })
    }

    private func save(_ body: AppSettingsUpdate) async {
        busy = true
        error = nil
        do { try await SettingsStore.save(workbench, body) } catch { self.error = String(localized: "无法保存资源回收设置：\(error.riffetMessage)") }
        busy = false
    }
}

// MARK: - Pieces

/// Whether the pane is on screen, read before each poll: the settings window can keep this view,
/// hidden or in a closed window, after the reader has moved on.
private final class PaneVisibility {
    weak var view: NSView?

    @MainActor var onScreen: Bool {
        guard let view, let window = view.window else { return false }
        return window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible) && !view.isHiddenOrHasHiddenAncestor
    }
}

private struct PaneVisibilityProbe: NSViewRepresentable {
    let visibility: PaneVisibility

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        visibility.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) { visibility.view = view }
}

/// One process in the tree. Compared by what it shows: the raw numbers move on every poll, the
/// rounded text mostly does not.
private struct MonitorProcessRow: View, Equatable {
    let process: ServiceProcess
    let depth: Int
    let stopping: Int32?
    let onStop: (ServiceProcess) -> Void
    private let cpu: String
    private let memory: String
    private let uptime: String
    @Environment(\.palette) private var palette

    init(process: ServiceProcess, depth: Int, stopping: Int32?, onStop: @escaping (ServiceProcess) -> Void) {
        self.process = process
        self.depth = depth
        self.stopping = stopping
        self.onStop = onStop
        cpu = monitorPercent(process.cpuPercent)
        memory = monitorBytes(process.rssBytes)
        uptime = monitorUptime(process.elapsedSec, short: true)
    }

    static func == (a: Self, b: Self) -> Bool {
        a.depth == b.depth && a.stopping == b.stopping && a.cpu == b.cpu && a.memory == b.memory && a.uptime == b.uptime
            && (a.process.cpuPercent >= 80) == (b.process.cpuPercent >= 80)
            && a.process.pid == b.process.pid && a.process.name == b.process.name && a.process.kind == b.process.kind
            && a.process.backendId == b.process.backendId && a.process.sessionTitle == b.process.sessionTitle
            && a.process.command == b.process.command && a.process.canTerminate == b.process.canTerminate
    }

    var body: some View {
        HStack(spacing: Space.sm) {
            HStack(spacing: Space.xs) {
                if depth > 0 {
                    Image(icon: "arrow.turn.down.right")
                        .font(.riffet(size: S(10)))
                        .foregroundStyle(palette.fg4)
                }
                Image(icon: monitorKindSymbol(process.kind))
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(kindTint(process.kind))
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(process.name)
                            .font(.riffet(size: S(13), weight: .medium))
                            .foregroundStyle(palette.fg)
                            .lineLimit(1)
                        if let backend = process.backendId {
                            Text(backendTitle(backend))
                                .font(.riffet(size: S(10.5)))
                                .foregroundStyle(palette.fg2)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control))
                        }
                        Text(String(process.pid))
                            .font(.riffet(size: S(11), design: .monospaced))
                            .foregroundStyle(palette.fg4)
                    }
                    Text(process.sessionTitle ?? process.command)
                        .font(.riffet(size: S(11), design: process.sessionTitle == nil ? .monospaced : .default))
                        .foregroundStyle(palette.fg3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .padding(.leading, CGFloat(depth) * 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .help(process.command)
            VStack(alignment: .trailing, spacing: 3) {
                Text(cpu)
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg2)
                    .monospacedDigit()
                MonitorMeter(ratio: process.cpuPercent / 100, tint: process.cpuPercent >= 80 ? palette.warning : palette.chart1)
                    .frame(width: 56)
            }
            .frame(width: 72, alignment: .trailing)
            Text(memory)
                .frame(width: 64, alignment: .trailing)
            Text(uptime)
                .frame(width: 64, alignment: .trailing)
            MonitorStopButton(process: process, stopping: stopping, onStop: onStop)
                .opacity(process.canTerminate ? 1 : 0)
                .allowsHitTesting(process.canTerminate)
        }
        .font(.riffet(size: S(11)))
        .foregroundStyle(palette.fg2)
        .monospacedDigit()
    }

    private func kindTint(_ kind: String) -> Color {
        switch kind {
        case "server": palette.success
        case "tmux": palette.chart2
        case "agent": palette.accent
        default: palette.fg3
        }
    }
}

private struct MonitorStopButton: View {
    let process: ServiceProcess?
    let stopping: Int32?
    let onStop: (ServiceProcess) -> Void

    var body: some View {
        ZStack {
            Button("结束进程", role: .destructive) { if let process { onStop(process) } }
                .controlSize(.small)
                .disabled(process == nil || stopping != nil)
                .opacity(stopping != nil && stopping == process?.pid ? 0 : 1)
            if let process, stopping == process.pid { Spinner(size: .mini) }
        }
    }
}

private struct MonitorTile: View, Equatable {
    let title: String
    let symbol: String
    let value: String
    var detail: String?
    let tint: Color
    var spark: [Double] = []
    var meter: Double?
    @Environment(\.palette) private var palette

    static func == (a: Self, b: Self) -> Bool {
        a.title == b.title && a.symbol == b.symbol && a.value == b.value && a.detail == b.detail
            && a.tint == b.tint && a.spark == b.spark && a.meter == b.meter
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: 5) {
                Image(icon: symbol).foregroundStyle(tint)
                Text(title).foregroundStyle(palette.fg3).lineLimit(1)
            }
            .font(.riffet(size: S(11)))
            Text(value)
                .font(.riffet(size: S(18), weight: .semibold))
                .foregroundStyle(palette.fg)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let detail {
                Text(detail)
                    .font(.riffet(size: S(10.5)))
                    .foregroundStyle(palette.fg4)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            // The same height whichever is drawn, so the grid's rows line up.
            Group {
                if let meter {
                    MonitorMeter(ratio: meter, tint: tint)
                } else if spark.count > 1 {
                    MonitorSparkline(values: spark, tint: tint)
                } else {
                    Color.clear
                }
            }
            .frame(height: 24, alignment: .bottom)
        }
        .padding(Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.lineSoft, lineWidth: 1))
    }
}

private struct MonitorSparkline: View {
    let values: [Double]
    let tint: Color

    var body: some View {
        let top = max(values.max() ?? 0, 0.0001)
        Chart(Array(values.enumerated()), id: \.offset) { point in
            AreaMark(x: .value("序号", point.offset), y: .value("值", point.element))
                .foregroundStyle(LinearGradient(colors: [tint.opacity(0.28), tint.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                .interpolationMethod(.monotone)
            LineMark(x: .value("序号", point.offset), y: .value("值", point.element))
                .foregroundStyle(tint)
                .lineStyle(StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartXScale(domain: 0...max(values.count - 1, 1))
        .chartYScale(domain: 0...top)
        .accessibilityHidden(true)
    }
}

private struct MonitorMeter: View {
    let ratio: Double
    let tint: Color
    @Environment(\.palette) private var palette

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(palette.bgMuted)
                Capsule().fill(tint).frame(width: geo.size.width * min(max(ratio.isFinite ? ratio : 0, 0), 1))
            }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}

/// Requests per 10-second bucket as bars (rectangles spanning the bucket), 5xx stacked on top in red, and the bucket's mean latency
/// as a line read against the right-hand axis.
private struct MonitorRequestChart: View, Equatable {
    let samples: [ServiceMonitorSample]
    @Environment(\.palette) private var palette

    static func == (a: Self, b: Self) -> Bool { a.samples == b.samples }

    var body: some View {
        let countTop = niceUpper(Double(samples.map(\.requests).max() ?? 0))
        let msTop = niceUpper(samples.map(\.avgMs).max() ?? 0)
        VStack(alignment: .leading, spacing: Space.sm) {
            MonitorLegend(items: [(String(localized: "请求"), palette.accent), ("5xx", palette.danger), (String(localized: "平均延迟（右轴）"), palette.warning)])
            Chart {
                ForEach(bars(samples)) { bar in
                    RectangleMark(
                        xStart: .value("开始", bar.start),
                        xEnd: .value("结束", bar.start.addingTimeInterval(8)),
                        yStart: .value("请求", bar.from),
                        yEnd: .value("请求", bar.to)
                    )
                    .foregroundStyle(bar.failed ? palette.danger : palette.accent.opacity(0.6))
                }
                ForEach(latency(countTop: countTop, msTop: msTop)) { point in
                    LineMark(x: .value("时间", point.date), y: .value("请求", point.value), series: .value("系列", String(localized: "延迟")))
                        .foregroundStyle(palette.warning)
                        .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.monotone)
                }
            }
            .chartYScale(domain: 0...countTop)
            .chartXScale(domain: monitorTimeDomain(samples))
            .chartXAxis { monitorTimeAxis(palette) }
            .chartYAxis {
                monitorValueAxis(.leading, top: countTop, grid: true, palette) { formatCount($0) }
                monitorValueAxis(.trailing, top: countTop, grid: false, palette) { formatDuration($0 / countTop * msTop) }
            }
            .frame(height: 150)
        }
        .padding(.vertical, Space.xs)
    }

    /// Mean latency scaled onto the request axis; buckets without requests have none and are skipped.
    private func latency(countTop: Double, msTop: Double) -> [MonitorPoint] {
        samples.filter { $0.requests > 0 }.map { sample in
            MonitorPoint(id: sample.at, date: monitorDate(sample.at).addingTimeInterval(4), value: sample.avgMs / msTop * countTop)
        }
    }
}

private struct MonitorPoint: Identifiable {
    let id: Int64
    let date: Date
    let value: Double
}

private struct RequestBar: Identifiable {
    let id: String
    let start: Date
    let from: Double
    let to: Double
    let failed: Bool
}

/// Each bucket's successful part from zero, its 5xx part stacked on top.
private func bars(_ samples: [ServiceMonitorSample]) -> [RequestBar] {
    samples.flatMap { sample -> [RequestBar] in
        let start = monitorDate(sample.at)
        let ok = Double(max(sample.requests - sample.errors, 0))
        var bars = [RequestBar(id: "\(sample.at)", start: start, from: 0, to: ok, failed: false)]
        if sample.errors > 0 {
            bars.append(RequestBar(id: "\(sample.at)-5xx", start: start, from: ok, to: Double(sample.requests), failed: true))
        }
        return bars
    }
}

/// CPU as a filled area against the left axis, resident memory and JS heap as lines against the right.
private struct MonitorLoadChart: View, Equatable {
    let samples: [ServiceMonitorSample]
    @Environment(\.palette) private var palette

    static func == (a: Self, b: Self) -> Bool { a.samples == b.samples }

    var body: some View {
        let cpuTop = niceUpper(max(samples.map(\.cpuPercent).max() ?? 0, 10))
        let memTop = niceUpper(Double(samples.map(\.rssBytes).max() ?? 0))
        VStack(alignment: .leading, spacing: Space.sm) {
            MonitorLegend(items: [("CPU", palette.chart1), (String(localized: "内存 RSS（右轴）"), palette.chart2), (String(localized: "JS 堆（右轴）"), palette.chart3)])
            Chart {
                ForEach(samples, id: \.at) { sample in
                    AreaMark(x: .value("时间", monitorDate(sample.at)), y: .value("值", sample.cpuPercent))
                        .foregroundStyle(LinearGradient(colors: [palette.chart1.opacity(0.32), palette.chart1.opacity(0.03)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("时间", monitorDate(sample.at)), y: .value("值", sample.cpuPercent), series: .value("系列", "CPU"))
                        .foregroundStyle(palette.chart1)
                        .lineStyle(StrokeStyle(lineWidth: 1.2))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("时间", monitorDate(sample.at)), y: .value("值", Double(sample.rssBytes) / memTop * cpuTop), series: .value("系列", "RSS"))
                        .foregroundStyle(palette.chart2)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("时间", monitorDate(sample.at)), y: .value("值", Double(sample.heapUsedBytes) / memTop * cpuTop), series: .value("系列", String(localized: "堆")))
                        .foregroundStyle(palette.chart3)
                        .lineStyle(StrokeStyle(lineWidth: 1.2, dash: [3, 3]))
                        .interpolationMethod(.monotone)
                }
            }
            .chartYScale(domain: 0...cpuTop)
            .chartXScale(domain: monitorTimeDomain(samples))
            .chartXAxis { monitorTimeAxis(palette) }
            .chartYAxis {
                AxisMarks(position: .leading, values: [0, cpuTop / 2, cpuTop]) { value in
                    AxisGridLine().foregroundStyle(palette.lineSoft)
                    AxisValueLabel {
                        if let number = value.as(Double.self) { monitorAxisText(monitorPercent(number), palette) }
                    }
                }
                AxisMarks(position: .trailing, values: [0, cpuTop / 2, cpuTop]) { value in
                    AxisValueLabel {
                        if let number = value.as(Double.self) { monitorAxisText(monitorBytes(Int64(number / cpuTop * memTop)), palette) }
                    }
                }
            }
            .frame(height: 130)
        }
        .padding(.vertical, Space.xs)
    }
}

private struct MonitorLegend: View {
    let items: [(String, Color)]
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.md) {
            ForEach(items.indices, id: \.self) { index in
                HStack(spacing: 5) {
                    Circle().fill(items[index].1).frame(width: 6, height: 6)
                    Text(items[index].0)
                }
            }
        }
        .font(.riffet(size: S(11)))
        .foregroundStyle(palette.fg3)
    }
}

/// Status classes since the service started, as a donut beside its legend.
private struct MonitorStatusSplit: View, Equatable {
    let counts: ServiceStatusCounts
    @Environment(\.palette) private var palette

    static func == (a: Self, b: Self) -> Bool { a.counts == b.counts }

    private struct Slice: Identifiable {
        let id: String
        let caption: String
        let value: Double
        let color: Color
    }

    var body: some View {
        let slices = [
            Slice(id: "2xx", caption: String(localized: "成功"), value: Double(counts.status2xx), color: palette.success),
            Slice(id: "3xx", caption: String(localized: "重定向 / 未修改"), value: Double(counts.status3xx), color: palette.chart2),
            Slice(id: "4xx", caption: String(localized: "客户端错误"), value: Double(counts.status4xx), color: palette.warning),
            Slice(id: "5xx", caption: String(localized: "服务器错误"), value: Double(counts.status5xx), color: palette.danger),
        ]
        let total = slices.reduce(0) { $0 + $1.value }
        if total == 0 {
            Text("还没有完成的请求。")
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg3)
        } else {
            HStack(spacing: Space.xl) {
                Chart(slices.filter { $0.value > 0 }) { slice in
                    SectorMark(angle: .value("数量", slice.value), innerRadius: .ratio(0.64), angularInset: 1.5)
                        .cornerRadius(3)
                        .foregroundStyle(slice.color)
                }
                .chartLegend(.hidden)
                .frame(width: 112, height: 112)
                .overlay {
                    VStack(spacing: 1) {
                        Text(formatTokens(total)).font(.riffet(size: S(15), weight: .semibold)).foregroundStyle(palette.fg).monospacedDigit()
                        Text("请求").font(.riffet(size: S(10.5))).foregroundStyle(palette.fg4)
                    }
                }
                VStack(alignment: .leading, spacing: Space.xs) {
                    ForEach(slices) { slice in
                        HStack(spacing: Space.sm) {
                            Circle().fill(slice.color).frame(width: 7, height: 7)
                            Text(slice.id).font(.riffet(size: S(12), weight: .medium, design: .monospaced)).foregroundStyle(palette.fg)
                            Text(slice.caption).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                            Spacer(minLength: Space.md)
                            Text(formatCount(slice.value)).font(.riffet(size: S(12))).foregroundStyle(palette.fg2).monospacedDigit()
                            Text(formatPercent(slice.value / total))
                                .font(.riffet(size: S(11)))
                                .foregroundStyle(palette.fg4)
                                .monospacedDigit()
                                .frame(width: 44, alignment: .trailing)
                        }
                    }
                }
                .frame(maxWidth: 320)
            }
            .padding(.vertical, Space.xs)
        }
    }
}

/// The busiest routes, each with a bar for its share of the busiest one.
private struct MonitorRoutes: View, Equatable {
    let routes: [ServiceRouteStat]
    @Environment(\.palette) private var palette

    static func == (a: Self, b: Self) -> Bool { a.routes == b.routes }

    var body: some View {
        let top = Double(routes.map(\.count).max() ?? 1)
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("最常访问的接口").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
            ForEach(Array(routes.enumerated()), id: \.offset) { _, route in
                HStack(spacing: Space.sm) {
                    Text(route.method)
                        .font(.riffet(size: S(10), weight: .semibold, design: .monospaced))
                        .foregroundStyle(palette.fg3)
                        .frame(width: 48, alignment: .leading)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(route.route)
                            .font(.riffet(size: S(11.5), design: .monospaced))
                            .foregroundStyle(palette.fg)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(route.route)
                        MonitorMeter(ratio: top > 0 ? Double(route.count) / top : 0, tint: route.errors > 0 ? palette.danger.opacity(0.8) : palette.accent)
                    }
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(formatCount(Double(route.count)) + (route.errors > 0 ? String(localized: " · 错误 \(route.errors)") : ""))
                            .foregroundStyle(route.errors > 0 ? palette.danger : palette.fg2)
                        Text("均 \(formatDuration(route.avgMs)) · P95 \(formatDuration(route.p95Ms))")
                            .foregroundStyle(palette.fg4)
                    }
                    .font(.riffet(size: S(11)))
                    .monospacedDigit()
                    .frame(width: 150, alignment: .trailing)
                }
            }
        }
        .padding(.vertical, Space.xs)
    }
}

// MARK: - Formatting

/// The server's defaults when a setting is unset (`DEFAULT_IDLE_RECLAIM_MINUTES`, `DEFAULT_MAX_LIVE_AGENTS`).
private let defaultIdleReclaimMinutes = 360
private let defaultMaxLiveAgents = 24
private let idleReclaimPresets = [0, 60, 360, 1440]
private let maxLiveAgentsPresets = [0, 12, 24, 48]

/// The presets, plus a value set elsewhere (another client, the API) so the control still shows it.
private func presetsWithCurrent(_ presets: [Int], _ current: Int) -> [Int] {
    presets.contains(current) ? presets : (presets + [current]).sorted()
}

private func idleReclaimLabel(_ minutes: Int) -> String {
    if minutes == 0 { return String(localized: "关闭") }
    return minutes % 60 == 0 ? String(localized: "\(minutes / 60) 小时") : String(localized: "\(minutes) 分钟")
}

private func monitorDate(_ millis: Int64) -> Date { Date(timeIntervalSince1970: Double(millis) / 1000) }

/// The samples' span, ending one bucket after the newest so its bar is not clipped.
private func monitorTimeDomain(_ samples: [ServiceMonitorSample]) -> ClosedRange<Date> {
    let first = monitorDate(samples.first?.at ?? 0)
    let last = monitorDate(samples.last?.at ?? 0).addingTimeInterval(10)
    return first < last ? first...last : first...first.addingTimeInterval(60)
}

@MainActor @AxisContentBuilder
private func monitorTimeAxis(_ palette: Palette) -> some AxisContent {
    AxisMarks(values: .stride(by: .minute, count: 5)) { value in
        AxisValueLabel {
            if let date = value.as(Date.self) {
                monitorAxisText(date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)), palette)
            }
        }
    }
}

/// Three ticks on one side of a value axis; [label] turns a tick into the text that side reads.
@MainActor @AxisContentBuilder
private func monitorValueAxis(_ position: AxisMarkPosition, top: Double, grid: Bool, _ palette: Palette, label: @escaping (Double) -> String) -> some AxisContent {
    AxisMarks(position: position, values: [0, top / 2, top]) { value in
        if grid { AxisGridLine().foregroundStyle(palette.lineSoft) }
        AxisValueLabel {
            if let number = value.as(Double.self) { monitorAxisText(label(number), palette) }
        }
    }
}

@MainActor
private func monitorAxisText(_ text: String, _ palette: Palette) -> some View {
    Text(text).font(.riffet(size: S(10))).foregroundStyle(palette.fg4).monospacedDigit()
}

private func monitorBytes(_ bytes: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: bytes, countStyle: .memory)
}

/// `ps`-style CPU: a share of one core, so it can pass 100%.
private func monitorPercent(_ value: Double) -> String {
    guard value.isFinite else { return statsUnavailable }
    return value >= 10 ? String(format: "%.0f%%", value) : String(format: "%.1f%%", value)
}

private func monitorUptime(_ seconds: Double, short: Bool = false) -> String {
    let total = Int(max(0, seconds.isFinite ? seconds : 0))
    let days = total / 86_400, hours = total % 86_400 / 3600, minutes = total % 3600 / 60
    if days > 0 { return short ? String(localized: "\(days)天\(hours)时") : String(localized: "\(days) 天 \(hours) 小时") }
    if hours > 0 { return short ? String(localized: "\(hours)时\(minutes)分") : String(localized: "\(hours) 小时 \(minutes) 分") }
    if minutes > 0 { return short ? String(localized: "\(minutes)分\(total % 60)秒") : String(localized: "\(minutes) 分 \(total % 60) 秒") }
    return String(localized: "\(total) 秒")
}

private func monitorClock(_ iso: String) -> String {
    guard let date = ServerTime.date(iso) else { return statsUnavailable }
    return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits))
}

private func monitorKindRank(_ kind: String) -> Int {
    switch kind {
    case "server": 0
    case "tmux": 1
    case "agent": 2
    default: 3
    }
}

private func monitorKindSymbol(_ kind: String) -> String {
    switch kind {
    case "server": "server.rack"
    case "tmux": "rectangle.split.3x1"
    case "agent": "sparkles"
    default: "gearshape"
    }
}
