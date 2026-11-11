import Charts
import SwiftUI
import RiffetKit

/// 服务状态: the running service's load, requests and processes (`ServiceStatusSection.tsx` on the
/// web, `ServiceMonitorSettings.swift` on the Mac), laid out for a phone. Read every five seconds
/// while the page is on screen and the app is active; a failed read keeps the last picture.
struct ServiceStatusView: View {
    let workbench: Workbench
    @Environment(\.scenePhase) private var phase
    @Environment(\.palette) private var palette
    @State private var snapshot: ServiceMonitorSnapshot?
    @State private var error: String?
    @State private var confirming: ServiceProcess?
    @State private var refresh = 0
    @State private var savingReclaim = false
    @State private var reclaimError: String?

    var body: some View {
        RiffetList {
            if let snapshot { content(snapshot) }
            else if let error {
                SettingsMessage(text: error)
                Section { Button { refresh += 1 } label: { Text("重试").foregroundStyle(palette.accent) } }
            }
            if let settings = workbench.settings { reclaim(settings) }
        }
        .overlay { if snapshot == nil && error == nil { ProgressView() } }
        .navigationTitle(String(localized: "服务器状态", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .refreshable { await read() }
        .task(id: "\(phase == .active)|\(refresh)") {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await read()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .confirmationDialog("结束进程？", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible, presenting: confirming) { process in
            Button("结束 \(process.name)（PID \(process.pid)）", role: .destructive) {
                Task {
                    do { try await workbench.api?.terminateServiceProcess(pid: process.pid); await read() }
                    catch { self.error = error.riffetMessage }
                }
            }
        } message: { process in Text(process.command) }
    }

    /// 资源回收: when the server stops the CLIs of conversations nobody uses; the next message resumes them.
    @ViewBuilder
    private func reclaim(_ settings: AppSettings) -> some View {
        let idle = settings.idleReclaimMinutes?.int32Value ?? 360
        let maxLive = settings.maxLiveAgents?.int32Value ?? 24
        Section {
            Picker("空闲后停止 CLI", selection: Binding(get: { idle }, set: { next in
                guard next != idle else { return }
                Task { await saveReclaim(managementSettingsPatch(idleReclaimMinutes: next)) }
            })) {
                ForEach(withCurrent([0, 60, 360, 1440], idle), id: \.self) { Text(idleLabel($0)).tag($0) }
            }
            Picker("最多同时运行", selection: Binding(get: { maxLive }, set: { next in
                guard next != maxLive else { return }
                Task { await saveReclaim(managementSettingsPatch(maxLiveAgents: next)) }
            })) {
                ForEach(withCurrent([0, 12, 24, 48], maxLive), id: \.self) { Text($0 == 0 ? "不限" : "\($0) 个").tag($0) }
            }
        } header: {
            Text("资源回收")
        } footer: {
            if let reclaimError { Text(reclaimError).foregroundStyle(palette.danger) }
            else { Text("停止的会话在下一条消息时恢复") }
        }
        .tint(palette.fg3)
        .disabled(savingReclaim)
    }

    private func saveReclaim(_ patch: AppSettingsUpdate) async {
        guard !savingReclaim, let api = workbench.api else { return }
        savingReclaim = true
        defer { savingReclaim = false }
        do {
            let saved = try await api.updateSettings(body: patch)
            workbench.store.applySavedSettings(settings: saved)
            reclaimError = nil
        } catch { reclaimError = error.riffetMessage.isEmpty ? String(localized: "无法保存资源回收设置", bundle: .riffet) : error.riffetMessage }
    }

    private func read() async {
        guard let api = workbench.api else { error = String(localized: "服务器未连接", bundle: .riffet); return }
        do { snapshot = try await api.serviceMonitor(); error = nil }
        catch { self.error = error.riffetMessage }
    }

    @ViewBuilder
    private func content(_ data: ServiceMonitorSnapshot) -> some View {
        Section {
            if let error {
                Label("连接中断，显示上次数据", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(palette.warning)
                Text(error).font(.caption).foregroundStyle(palette.danger)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(tiles(data), id: \.title) { KpiTile(tile: $0) }
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
        }

        Section("请求与延迟 · 30 分钟") {
            let samples = data.series
            let slowest = max(samples.map(\.avgMs).max() ?? 0, 1e-9)
            let busiest = Double(max(samples.map(\.requests).max() ?? 0, 1))
            Chart {
                ForEach(samples, id: \.at) { sample in
                    BarMark(x: .value(String(localized: "时间", bundle: .riffet), date(sample.at)), y: .value(String(localized: "请求", bundle: .riffet), sample.requests - sample.errors)).foregroundStyle(palette.accent.opacity(0.7))
                    BarMark(x: .value(String(localized: "时间", bundle: .riffet), date(sample.at)), y: .value(String(localized: "请求", bundle: .riffet), sample.errors)).foregroundStyle(palette.danger)
                }
                // Latency shares the request axis, scaled so its peak meets the busiest bucket.
                ForEach(samples, id: \.at) { sample in
                    LineMark(x: .value(String(localized: "时间", bundle: .riffet), date(sample.at)), y: .value(String(localized: "延迟", bundle: .riffet), sample.avgMs / slowest * busiest)).foregroundStyle(palette.warning)
                }
            }
            .chartYAxis(.hidden)
            .frame(height: 150)
            legend([(String(localized: "请求", bundle: .riffet), palette.accent), ("5xx", palette.danger), (String(localized: "平均延迟 · 峰值 \(fixed(slowest)) ms", bundle: .riffet), palette.warning)])
        }

        Section("CPU 与内存 · 30 分钟") {
            let samples = data.series
            let topCpu = max(samples.map(\.cpuPercent).max() ?? 0, 1e-9)
            let topRss = Double(max(samples.map(\.rssBytes).max() ?? 0, 1))
            Chart {
                ForEach(samples, id: \.at) { sample in
                    AreaMark(x: .value(String(localized: "时间", bundle: .riffet), date(sample.at)), y: .value("CPU", sample.cpuPercent / topCpu)).foregroundStyle(palette.accent.opacity(0.18))
                    LineMark(x: .value(String(localized: "时间", bundle: .riffet), date(sample.at)), y: .value("CPU", sample.cpuPercent / topCpu), series: .value(String(localized: "指标", bundle: .riffet), "CPU")).foregroundStyle(palette.accent)
                    LineMark(x: .value(String(localized: "时间", bundle: .riffet), date(sample.at)), y: .value(String(localized: "内存", bundle: .riffet), Double(sample.rssBytes) / topRss), series: .value(String(localized: "指标", bundle: .riffet), String(localized: "内存", bundle: .riffet))).foregroundStyle(palette.success)
                }
            }
            .chartYAxis(.hidden)
            .frame(height: 150)
            legend([(String(localized: "CPU · 峰值 \(fixed(topCpu))%", bundle: .riffet), palette.accent), (String(localized: "内存 · 峰值 \(bytes(Int64(topRss)))", bundle: .riffet), palette.success)])
        }

        Section("状态码") {
            let status = data.requests.byStatus
            let parts: [(String, Int64, Color)] = [("2xx", status.status2xx, palette.success), ("3xx", status.status3xx, palette.fg3), ("4xx", status.status4xx, palette.warning), ("5xx", status.status5xx, palette.danger)]
            let total = max(parts.reduce(0) { $0 + $1.1 }, 1)
            HStack(spacing: 20) {
                Chart(parts, id: \.0) { part in
                    SectorMark(angle: .value(String(localized: "数量", bundle: .riffet), part.1), innerRadius: .ratio(0.62), angularInset: 1).foregroundStyle(part.2)
                }
                .frame(width: 96, height: 96)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(parts, id: \.0) { part in
                        HStack(spacing: 6) {
                            Circle().fill(part.2).frame(width: 8, height: 8)
                            Text("\(part.0)  \(part.1)").font(.caption.monospacedDigit())
                            Text("\(Int((Double(part.1) * 100 / Double(total)).rounded()))%").font(.caption).foregroundStyle(palette.fg3)
                        }
                    }
                }
            }
            .padding(.vertical, 4)
        }

        if !data.requests.topRoutes.isEmpty {
            Section("热门接口") {
                let top = Double(max(data.requests.topRoutes.map(\.count).max() ?? 1, 1))
                ForEach(data.requests.topRoutes, id: \.route) { route in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("\(route.method) \(route.route)").font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text("\(route.count) 次").font(.caption.monospacedDigit()).foregroundStyle(palette.fg3)
                        }
                        ProgressView(value: Double(route.count) / top).tint(route.errors > 0 ? palette.danger : palette.accent)
                        Text("平均 \(fixed(route.avgMs)) ms · P95 \(fixed(route.p95Ms)) ms\(route.errors > 0 ? " · 5xx \(route.errors)" : "")").font(.caption2).foregroundStyle(palette.fg3)
                    }
                }
            }
        }

        Section("服务器") {
            LabeledContent("版本", value: "\(data.process.version) · PID \(data.process.pid)")
            LabeledContent("已运行", value: duration(data.process.uptimeSec))
            LabeledContent("运行环境", value: "Node \(data.process.nodeVersion) · \(data.process.platform)/\(data.process.arch)")
            LabeledContent("主机", value: data.host.hostname)
            LabeledContent("连接", value: String(localized: "事件流 \(data.connections.eventStreams) · 终端 \(data.connections.terminalSockets)", bundle: .riffet))
            LabeledContent("终端", value: String(localized: "运行中 \(data.terminals.live) / 共 \(data.terminals.total)", bundle: .riffet))
            LabeledContent("会话", value: String(localized: "运行中 \(data.sessions.running) · 等待 \(data.sessions.waiting)", bundle: .riffet))
        }

        if !data.processes.isEmpty {
            Section("进程 · \(data.processes.count)") {
                let maxCpu = max(data.processes.map(\.cpuPercent).max() ?? 1, 1)
                let byPid = Dictionary(data.processes.map { ($0.pid, $0) }, uniquingKeysWith: { a, _ in a })
                ForEach(data.processes, id: \.pid) { process in
                    ProcessRow(process: process, maxCpu: maxCpu, depth: depth(process, byPid)) { confirming = process }
                }
            }
        }
    }

    private func tiles(_ data: ServiceMonitorSnapshot) -> [Tile] {
        let series = Array(data.series.suffix(60))
        let load = data.host.loadAvg.map(\.doubleValue)
        let used = data.host.totalMemBytes - data.host.freeMemBytes
        let errors = data.requests.byStatus.status5xx
        return [
            Tile(title: "CPU", value: "\(fixed(data.process.cpuPercent))%", detail: String(localized: "服务器进程", bundle: .riffet), values: series.map(\.cpuPercent), tint: palette.accent, meter: data.process.cpuPercent / 100),
            Tile(title: String(localized: "内存", bundle: .riffet), value: bytes(data.process.rssBytes), detail: String(localized: "堆 \(bytes(data.process.heapUsedBytes)) / \(bytes(data.process.heapTotalBytes))", bundle: .riffet), values: series.map { Double($0.rssBytes) }, tint: palette.success,
                 meter: Double(data.process.heapUsedBytes) / Double(max(data.process.heapTotalBytes, 1))),
            Tile(title: String(localized: "请求速率", bundle: .riffet), value: String(localized: "\(fixed(data.requests.perMinute))/分", bundle: .riffet), detail: String(localized: "进行中 \(data.requests.inFlight) · 共 \(data.requests.total)", bundle: .riffet), values: series.map { Double($0.requests) }, tint: palette.accent),
            Tile(title: String(localized: "延迟", bundle: .riffet), value: "\(fixed(data.requests.avgMs)) ms", detail: String(localized: "P95 \(fixed(data.requests.p95Ms)) ms · \(errors > 0 ? "5xx \(errors)" : String(localized: "无错误", bundle: .riffet))", bundle: .riffet), values: series.map(\.avgMs), tint: errors > 0 ? palette.danger : palette.warning),
            Tile(title: String(localized: "事件循环", bundle: .riffet), value: "\(fixed(data.eventLoop.recentLagMs)) ms", detail: String(localized: "P99 \(fixed(data.eventLoop.p99Ms)) ms · 卡顿 \(data.eventLoop.stalls)", bundle: .riffet), values: series.map(\.loopLagMs), tint: palette.warning, meter: data.eventLoop.utilization),
            Tile(title: String(localized: "系统负载", bundle: .riffet), value: fixed(load.first ?? 0), detail: String(localized: "\(data.host.cpuCount) 核 · 内存 \(bytes(used)) / \(bytes(data.host.totalMemBytes))", bundle: .riffet), values: series.map(\.load1), tint: palette.fg2,
                 meter: Double(used) / Double(max(data.host.totalMemBytes, 1))),
        ]
    }

    private func legend(_ items: [(String, Color)]) -> some View {
        HStack(spacing: 14) {
            ForEach(items, id: \.0) { item in
                HStack(spacing: 6) { Circle().fill(item.1).frame(width: 8, height: 8); Text(item.0).font(.caption).foregroundStyle(palette.fg3) }
            }
        }
    }

    private func depth(_ process: ServiceProcess, _ byPid: [Int32: ServiceProcess]) -> Int {
        var depth = 0
        var parent = byPid[process.ppid]
        while let next = parent, depth < 4 { depth += 1; parent = byPid[next.ppid] }
        return depth
    }

    private func date(_ millis: Int64) -> Date { Date(timeIntervalSince1970: Double(millis) / 1000) }
}

private struct Tile {
    let title: String
    let value: String
    let detail: String
    let values: [Double]
    let tint: Color
    var meter: Double?
}

private struct KpiTile: View {
    let tile: Tile
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(tile.title).font(.caption).foregroundStyle(palette.fg3)
            Text(tile.value).font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(palette.fg).lineLimit(1).minimumScaleFactor(0.7)
            Chart(Array(tile.values.enumerated()), id: \.offset) { point in
                AreaMark(x: .value("i", point.offset), y: .value("v", point.element)).foregroundStyle(tile.tint.opacity(0.15))
                LineMark(x: .value("i", point.offset), y: .value("v", point.element)).foregroundStyle(tile.tint)
            }
            .chartXAxis(.hidden).chartYAxis(.hidden)
            .frame(height: 28)
            if let meter = tile.meter { ProgressView(value: min(max(meter, 0), 1)).tint(tile.tint) }
            Text(tile.detail).font(.caption2).foregroundStyle(palette.fg3).lineLimit(2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.bg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct ProcessRow: View {
    let process: ServiceProcess
    let maxCpu: Double
    let depth: Int
    let stop: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(kind).font(.caption2.weight(.medium)).foregroundStyle(tint)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
                    Text(process.name).lineLimit(1)
                    Text("\(process.pid)").font(.caption.monospacedDigit()).foregroundStyle(palette.fg4)
                }
                if let title = process.sessionTitle { Text(title).font(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
                ProgressView(value: min(process.cpuPercent / maxCpu, 1)).tint(tint)
                Text("CPU \(fixed(process.cpuPercent))% · \(bytes(process.rssBytes)) · \(duration(process.elapsedSec))").font(.caption2).foregroundStyle(palette.fg3)
            }
            if process.canTerminate {
                Button("结束", role: .destructive, action: stop).buttonStyle(.bordered).controlSize(.small)
            }
        }
        .padding(.leading, CGFloat(depth) * 12)
        .contextMenu { Button("复制命令", systemImage: "doc.on.doc") { UIPasteboard.general.string = process.command } }
    }

    private var kind: String {
        switch process.kind { case "server": String(localized: "服务器", bundle: .riffet); case "tmux": "tmux"; case "agent": "Agent"; default: String(localized: "子进程", bundle: .riffet) }
    }

    private var tint: Color {
        switch process.kind { case "server": palette.accent; case "tmux": palette.success; case "agent": palette.warning; default: palette.fg3 }
    }
}

/// The presets, plus a value set elsewhere (another client, the API) so the picker still shows it.
private func withCurrent(_ presets: [Int32], _ current: Int32) -> [Int32] {
    presets.contains(current) ? presets : (presets + [current]).sorted()
}

private func idleLabel(_ minutes: Int32) -> String {
    minutes == 0 ? String(localized: "关闭", bundle: .riffet) : minutes % 60 == 0 ? String(localized: "\(minutes / 60) 小时", bundle: .riffet) : String(localized: "\(minutes) 分钟", bundle: .riffet)
}

private func fixed(_ value: Double) -> String {
    value >= 100 ? String(Int(value.rounded())) : String(format: "%.1f", value)
}

private func bytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .memory)
}

private func duration(_ seconds: Double) -> String {
    let total = Int(seconds)
    let (days, hours, minutes) = (total / 86_400, total % 86_400 / 3_600, total % 3_600 / 60)
    if days > 0 { return String(localized: "\(days) 天 \(hours) 小时", bundle: .riffet) }
    if hours > 0 { return String(localized: "\(hours) 小时 \(minutes) 分", bundle: .riffet) }
    return minutes > 0 ? String(localized: "\(minutes) 分", bundle: .riffet) : String(localized: "\(total) 秒", bundle: .riffet)
}
