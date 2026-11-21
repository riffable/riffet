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
    private static let inlineProcesses = 5

    var body: some View {
        RiffetList {
            if let snapshot { content(snapshot) }
            else if let error {
                RiffetNotice.section(.error, error, actionTitle: String(localized: "重试", bundle: .riffet)) { refresh += 1 }
            }
            if let settings = workbench.settings { reclaim(settings) }
        }
        .overlay { if snapshot == nil && error == nil { ProgressView() } }
        .navigationTitle(String(localized: "服务器状态", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .refreshable { await read() }
        .task(id: "\(phase == .active)|\(refresh)") {
            guard phase == .active else { return }
            // Every 5 s while it answers; an unreachable server is asked less and less often, up to once a minute.
            var delay = 5.0
            while !Task.isCancelled {
                await read()
                delay = error == nil ? 5 : min(delay * 2, 60)
                try? await Task.sleep(for: .seconds(delay))
            }
        }
        .modifier(EndProcessDialog(workbench: workbench, target: $confirming) { await read() })
    }

    /// 资源回收: when the server stops the CLIs of conversations nobody uses; the next message resumes them.
    @ViewBuilder
    private func reclaim(_ settings: AppSettings) -> some View {
        let idle = settings.idleReclaimMinutes?.int32Value ?? Int32(BudgetsKt.AGENT_PROCESS_BUDGET_IDLE_MINUTES)
        let memoryMb = settings.maxAgentMemoryMb?.int32Value ?? Int32(BudgetsKt.AGENT_PROCESS_BUDGET_MEMORY_BYTES / (1024 * 1024))
        Section {
            reclaimPicker(String(localized: "空闲后停止 CLI", bundle: .riffet), values: withCurrent([0, 60, 360, 1440], idle), current: idle, label: idleLabel) { next in
                Task { await saveReclaim(managementSettingsPatch(idleReclaimMinutes: next)) }
            }
            reclaimPicker(String(localized: "CLI 内存上限", bundle: .riffet), values: withCurrent([0, 2048, 4096, 8192, 16384], memoryMb), current: memoryMb, label: memoryLabel) { next in
                Task { await saveReclaim(managementSettingsPatch(maxAgentMemoryMb: next)) }
            }
        } header: {
            RiffetSectionTitle(String(localized: "资源回收", bundle: .riffet))
        } footer: {
            Text("停止的会话在下一条消息时恢复")
        }
        .tint(palette.fg3)
        .disabled(savingReclaim)
        RiffetNotice.section(.error, reclaimError)
    }

    /// Four or fewer values are a menu on the row; five or more open a picker sheet.
    @ViewBuilder
    private func reclaimPicker(_ title: String, values: [Int32], current: Int32, label: @escaping (Int32) -> String, save: @escaping (Int32) -> Void) -> some View {
        let choice = Binding(get: { current }, set: { next in if next != current { save(next) } })
        if values.count >= 5 {
            RiffetPickerRow(title: title, options: values.map { .init(id: $0, title: label($0)) }, selection: choice)
        } else {
            Picker(selection: choice) { ForEach(values, id: \.self) { Text(label($0)).tag($0) } } label: { Text(title) }
        }
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
        if let error {
            RiffetNotice.section(.warning, title: String(localized: "连接中断，显示上次数据", bundle: .riffet), error)
        }
        let used = data.host.totalMemBytes - data.host.freeMemBytes
        Section {
            RiffetValueRow(label: String(localized: "已运行", bundle: .riffet), value: duration(data.process.uptimeSec))
            RiffetValueRow(label: "CPU", value: "\(fixed(data.process.cpuPercent))%")
            RiffetValueRow(label: String(localized: "内存", bundle: .riffet), value: bytes(data.process.rssBytes))
            RiffetValueRow(label: String(localized: "请求速率", bundle: .riffet), value: String(localized: "\(fixed(data.requests.perMinute))/分", bundle: .riffet))
            RiffetValueRow(label: String(localized: "延迟", bundle: .riffet), value: "\(fixed(data.requests.avgMs)) ms")
            RiffetValueRow(label: String(localized: "事件循环", bundle: .riffet), value: "\(fixed(data.eventLoop.recentLagMs)) ms")
            RiffetValueRow(label: String(localized: "系统负载", bundle: .riffet), value: fixed(data.host.loadAvg.first?.doubleValue ?? 0))
        } footer: {
            Text(String(localized: "\(data.host.cpuCount) 核 · 内存 \(bytes(used)) / \(bytes(data.host.totalMemBytes))", bundle: .riffet))
        }

        if !data.processes.isEmpty {
            monitorSection(String(localized: "进程 · \(data.processes.count)", bundle: .riffet)) {
                ForEach(data.processes.prefix(Self.inlineProcesses), id: \.pid) { process in
                    ServiceProcessRow(workbench: workbench, snapshot: $snapshot, process: process, end: { confirming = $0 }) { await read() }
                }
                if data.processes.count > Self.inlineProcesses {
                    NavigationLink { ServiceProcessesPage(workbench: workbench, snapshot: $snapshot) { await read() } } label: {
                        Text("全部 \(data.processes.count) 个").riffetFont(.body).foregroundStyle(palette.accent)
                    }
                }
            }
        }

        monitorSection(String(localized: "请求与延迟 · 30 分钟", bundle: .riffet)) {
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

        monitorSection(String(localized: "CPU 与内存 · 30 分钟", bundle: .riffet)) {
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

        monitorSection(String(localized: "状态码", bundle: .riffet)) {
            let status = data.requests.byStatus
            let parts: [(String, Int64)] = [("2xx", status.status2xx), ("3xx", status.status3xx), ("4xx", status.status4xx), ("5xx", status.status5xx)]
            let total = max(parts.reduce(0) { $0 + $1.1 }, 1)
            ForEach(parts, id: \.0) { part in
                RiffetValueRow(label: part.0, value: "\(part.1) · \(Int((Double(part.1) * 100 / Double(total)).rounded()))%")
            }
        }

        if !data.requests.topRoutes.isEmpty {
            monitorSection(String(localized: "热门接口", bundle: .riffet)) {
                ForEach(data.requests.topRoutes, id: \.route) { route in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(route.method) \(route.route)").riffetFont(.monoSmall).foregroundStyle(route.errors > 0 ? palette.danger : palette.fg).lineLimit(1).truncationMode(.middle)
                        Text("\(route.count) 次 · 平均 \(fixed(route.avgMs)) ms · P95 \(fixed(route.p95Ms)) ms\(route.errors > 0 ? " · 5xx \(route.errors)" : "")")
                            .riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                    }
                }
            }
        }

        monitorSection(String(localized: "服务器", bundle: .riffet)) {
            RiffetValueRow(label: String(localized: "版本", bundle: .riffet), value: "\(data.process.version) · PID \(data.process.pid)")
            RiffetValueRow(label: String(localized: "运行环境", bundle: .riffet), value: "Node \(data.process.nodeVersion) · \(data.process.platform)/\(data.process.arch)")
            RiffetValueRow(label: String(localized: "主机", bundle: .riffet), value: data.host.hostname)
            RiffetValueRow(label: String(localized: "连接", bundle: .riffet), value: String(localized: "事件流 \(data.connections.eventStreams) · 终端 \(data.connections.terminalSockets)", bundle: .riffet))
            RiffetValueRow(label: String(localized: "终端", bundle: .riffet), value: String(localized: "运行中 \(data.terminals.live) / 共 \(data.terminals.total)", bundle: .riffet))
            RiffetValueRow(label: String(localized: "会话", bundle: .riffet), value: String(localized: "运行中 \(data.sessions.running) · 等待 \(data.sessions.waiting)", bundle: .riffet))
        }
    }

    private func legend(_ items: [(String, Color)]) -> some View {
        HStack(spacing: 14) {
            ForEach(items, id: \.0) { item in
                HStack(spacing: 6) { Circle().fill(item.1).frame(width: 8, height: 8); Text(item.0).riffetFont(.caption).foregroundStyle(palette.fg3) }
            }
        }
    }

    private func date(_ millis: Int64) -> Date { Date(timeIntervalSince1970: Double(millis) / 1000) }
}

/// A section with the app's title style.
private func monitorSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    Section { content() } header: { RiffetSectionTitle(title) }
}

private func processKind(_ process: ServiceProcess) -> String {
    switch process.kind { case "server": String(localized: "服务器", bundle: .riffet); case "tmux": "tmux"; case "agent": "Agent"; default: String(localized: "子进程", bundle: .riffet) }
}

/// Confirms ending a process, then ends it and reads again.
private struct EndProcessDialog: ViewModifier {
    let workbench: Workbench
    @Binding var target: ServiceProcess?
    let done: () async -> Void
    func body(content: Content) -> some View {
        content.confirmationDialog(target.map { String(localized: "结束进程 \($0.pid)？", bundle: .riffet) } ?? "", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), titleVisibility: .visible, presenting: target) { process in
            Button("结束", role: .destructive) {
                Task {
                    do { try await workbench.api?.terminateServiceProcess(pid: process.pid); await done() }
                    catch { RiffetToastCenter.shared.error(error.riffetMessage) }
                }
            }
        } message: { process in Text(process.command) }
    }
}

/// A process on one line: its name over `pid · memory`. A press opens it; the context menu and a swipe end it.
private struct ServiceProcessRow: View {
    let workbench: Workbench
    @Binding var snapshot: ServiceMonitorSnapshot?
    let process: ServiceProcess
    let end: (ServiceProcess) -> Void
    let refresh: () async -> Void
    @Environment(\.palette) private var palette
    private var agentUsage: AgentProcessUsage? {
        guard process.kind == "agent", let id = process.sessionId else { return nil }
        return snapshot?.agentProcesses?.agents.first { $0.sessionId == id }
    }

    var body: some View {
        NavigationLink { ServiceProcessDetail(workbench: workbench, pid: process.pid, snapshot: $snapshot, refresh: refresh) } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(process.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                Text(([ "\(process.pid) · \(bytes(process.rssBytes))" ] + [agentUsage.flatMap(agentStatus)].compactMap { $0 }).joined(separator: " · ")).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1).monospacedDigit()
            }
        }
        .swipeActions {
            if process.canTerminate { Button("结束", role: .destructive) { end(process) } }
        }
        .contextMenu {
            Button("复制命令", systemImage: "doc.on.doc") { UIPasteboard.general.string = process.command }
            if process.canTerminate { Button("结束", systemImage: "xmark.circle", role: .destructive) { end(process) } }
        }
    }
}

private struct ServiceProcessesPage: View {
    let workbench: Workbench
    @Binding var snapshot: ServiceMonitorSnapshot?
    let refresh: () async -> Void
    @State private var confirming: ServiceProcess?

    var body: some View {
        RiffetList {
            Section {
                ForEach(snapshot?.processes ?? [], id: \.pid) { process in
                    ServiceProcessRow(workbench: workbench, snapshot: $snapshot, process: process, end: { confirming = $0 }, refresh: refresh)
                }
            }
        }
        .navigationTitle(String(localized: "进程", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }
        .modifier(EndProcessDialog(workbench: workbench, target: $confirming, done: refresh))
    }
}

private struct ServiceProcessDetail: View {
    let workbench: Workbench
    let pid: Int32
    @Binding var snapshot: ServiceMonitorSnapshot?
    let refresh: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var confirming: ServiceProcess?
    private var process: ServiceProcess? { snapshot?.processes.first { $0.pid == pid } }

    var body: some View {
        RiffetList {
            if let process {
                Section {
                    RiffetValueRow(label: String(localized: "类型", bundle: .riffet), value: processKind(process))
                    RiffetValueRow(label: "PID", value: "\(process.pid)")
                    RiffetValueRow(label: String(localized: "上级进程", bundle: .riffet), value: "\(process.ppid)")
                    RiffetValueRow(label: "CPU", value: "\(fixed(process.cpuPercent))%")
                    RiffetValueRow(label: String(localized: "内存", bundle: .riffet), value: bytes(process.rssBytes))
                    RiffetValueRow(label: String(localized: "已运行", bundle: .riffet), value: duration(process.elapsedSec))
                    if let title = process.sessionTitle { RiffetValueRow(label: String(localized: "会话", bundle: .riffet), value: title) }
                    RiffetValueRow(label: String(localized: "命令", bundle: .riffet), value: process.command, mono: true)
                }
                if process.canTerminate {
                    Section { RiffetActionRow("结束进程", destructive: true) { confirming = process } }
                }
            }
        }
        .navigationTitle(process?.name ?? "").navigationBarTitleDisplayMode(.inline)
        .onChange(of: process == nil) { _, gone in if gone { dismiss() } }
        .modifier(EndProcessDialog(workbench: workbench, target: $confirming, done: refresh))
    }
}

/// The presets, plus a value set elsewhere (another client, the API) so the picker still shows it.
private func withCurrent(_ presets: [Int32], _ current: Int32) -> [Int32] {
    presets.contains(current) ? presets : (presets + [current]).sorted()
}

private func idleLabel(_ minutes: Int32) -> String {
    minutes == 0 ? String(localized: "关闭", bundle: .riffet) : minutes % 60 == 0 ? String(localized: "\(minutes / 60) 小时", bundle: .riffet) : String(localized: "\(minutes) 分钟", bundle: .riffet)
}

private func memoryLabel(_ mb: Int32) -> String {
    mb == 0 ? String(localized: "不限", bundle: .riffet) : mb % 1024 == 0 ? "\(mb / 1024) GB" : "\(mb) MB"
}

/// Why the CLI is kept, else when it stops; an unknown reason says nothing.
private func agentStatus(_ usage: AgentProcessUsage) -> String? {
    switch usage.retainedBy.first {
    case "turn": return String(localized: "回合进行中", bundle: .riffet)
    case "interaction": return String(localized: "等待回复", bundle: .riffet)
    case "background": return String(localized: "后台任务", bundle: .riffet)
    case "subscribed": return String(localized: "已打开", bundle: .riffet)
    case "terminal-held": return String(localized: "终端接管", bundle: .riffet)
    case "launching": return String(localized: "刚启动", bundle: .riffet)
    case "unobserved": return String(localized: "观察中", bundle: .riffet)
    case "not-resumable": return String(localized: "不可恢复", bundle: .riffet)
    default: break
    }
    guard let at = usage.reclaimAt, let date = ServerTime.date(at) else { return nil }
    let left = date.timeIntervalSinceNow
    return left <= 60 ? String(localized: "即将停止", bundle: .riffet) : String(localized: "\(duration(left)) 后停止", bundle: .riffet)
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
