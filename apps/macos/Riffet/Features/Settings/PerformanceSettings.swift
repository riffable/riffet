import AppKit
import SwiftUI

/// The performance monitor's switches, its numbers per page, and the benchmark.
struct PerformanceSettingsSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var enabled = PerfMonitor.shared.enabled
    @State private var hud = PerfHUD.shared.visible
    @State private var rows: [PageRow] = []
    @State private var lastFile: URL?

    struct PageRow: Identifiable {
        let id: String
        let summary: String
    }

    var body: some View {
        SettingsBlock("性能监测") {
            SettingsRow("记录帧率、卡顿与主线程占用") {
                Toggle("记录帧率、卡顿与主线程占用", isOn: $enabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .onChange(of: enabled) { _, on in PerfMonitor.shared.setEnabled(on) }
            }
            SettingsRow("显示悬浮读数") {
                Toggle("显示悬浮读数", isOn: $hud)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .onChange(of: hud) { _, on in
                        PerfHUD.shared.setVisible(on)
                        enabled = PerfMonitor.shared.enabled
                    }
            }
            if enabled {
                ForEach(rows) { row in
                    LabeledContent(row.id) {
                        Text(row.summary).font(RiffetFont.caption.monospacedDigit()).foregroundStyle(palette.fg2).multilineTextAlignment(.trailing)
                    }
                }
                if rows.isEmpty {
                    SettingsHint("暂无记录。", symbol: "info.circle")
                }
            }
            // Off, the numbers are empty; only the benchmark (which turns recording on) remains.
            if enabled || AppBuildRecord.fromCheckout {
                HStack(spacing: Space.sm) {
                    SettingsActionButton("刷新", symbol: "arrow.clockwise") { reload() }
                        .disabled(!enabled)
                    SettingsActionButton("清零", symbol: "arrow.counterclockwise") {
                        PerfMonitor.shared.reset()
                        reload()
                    }
                    .disabled(!enabled)
                    SettingsActionButton("导出 JSON", symbol: "square.and.arrow.up") {
                        lastFile = PerfMonitor.write(PerfMonitor.shared.report(), name: "report")
                    }
                    .disabled(!enabled)
                    // The benchmark drives the window and writes to the perf directory: a developer tool.
                    if AppBuildRecord.fromCheckout {
                        SettingsActionButton("对当前会话跑基准", symbol: "play.circle") {
                            Task {
                                lastFile = await PerfBenchmark.shared.run(sessionId: model.workbench?.selected?.id)
                                enabled = PerfMonitor.shared.enabled
                                reload()
                            }
                        }
                        .disabled(model.workbench?.selected == nil)
                        .help("会打开当前会话自动滚动，结果写入 perf 目录。")
                    }
                }
                .controlSize(.small)
            }
            if let lastFile {
                HStack(spacing: Space.sm) {
                    Text(lastFile.path).font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.middle)
                    SettingsActionButton("在访达中显示", symbol: "folder") {
                        NSWorkspace.shared.activateFileViewerSelecting([lastFile])
                    }
                    .controlSize(.small)
                }
            }
        }
        .onAppear(perform: reload)
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.diagnostics.rawValue else { return }
            reload()
        }
    }

    private func reload() {
        let pages = PerfMonitor.shared.report()["pages"] as? [String: [String: Any]] ?? [:]
        rows = pages.keys.sorted().map { page in
            let entry = pages[page] ?? [:]
            let frames = entry["frames"] as? [String: [String: Any]] ?? [:]
            var parts: [String] = []
            for activity in PerfActivity.allCases.map(\.rawValue) {
                guard let value = frames[activity], (value["count"] as? Int ?? 0) > 0 else { continue }
                parts.append(String(format: String(localized: "%@ 卡顿 %.1fms/s p99 %.0fms"), label(activity), value["hitchMsPerSecond"] as? Double ?? 0, value["p99"] as? Double ?? 0))
            }
            if let click = (entry["input"] as? [String: [String: Any]])?["click"] {
                parts.append(String(format: String(localized: "点击 p95 %.0fms"), click["p95"] as? Double ?? 0))
            }
            if let stalls = (entry["mainThreadStalls"] as? [String: [String: Any]])?["stall"] {
                parts.append(String(format: String(localized: "主线程阻塞 %d 次 最长 %.0fms"), stalls["count"] as? Int ?? 0, stalls["max"] as? Double ?? 0))
            }
            return PageRow(id: page, summary: parts.joined(separator: "\n"))
        }
    }

    private func label(_ activity: String) -> String {
        switch activity {
        case "scroll": String(localized: "滚动")
        case "stream": String(localized: "流式")
        case "interact": String(localized: "交互")
        default: String(localized: "空闲")
        }
    }
}
