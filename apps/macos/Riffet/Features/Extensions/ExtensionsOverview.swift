import Charts
import SwiftUI
import RiffetKit

/// The extensions overview: counts of the scanned directory entries (never usage), by Agent, by
/// kind and by configured state. Every number leads to the catalog filtered to it.
struct ExtensionsOverview: View {
    let store: ExtensionsStore
    let onBrowse: (_ kind: String?, _ backend: NativeBackendId?, _ status: ExtensionStatusFilter) -> Void
    @Environment(\.palette) private var palette

    private static let backendOrder = NativeBackendId.allCases.filter { $0 != .chat }

    var body: some View {
        let stats = store.stats
        let sources = store.sources
        let readable = store.readableSourceCount
        // Without a readable directory the numbers would read as zero rather than as unknown.
        let available = stats.total > 0 || readable > 0 || sources.isEmpty
        let agents = agentRows(stats: stats, sources: sources)
        let kinds = ExtensionText.kindOrder.map { (kind: $0, value: stats.kinds[$0] ?? 0) }.filter { $0.value > 0 }
        let colors = chartColors(palette)

        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                HStack(spacing: Space.sm) {
                    Text("\(agents.count) 个 Agent · \(sources.count) 个配置")
                    Image(icon: "info.circle")
                        .help("按各 Agent 配置的扫描条目计数，同一文件跨配置或共享来源可能重复出现。")
                }
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg3)

                if store.loading && stats.total == 0 {
                    HStack(spacing: Space.sm) {
                        Spinner(size: .small)
                        Text("正在读取扩展目录").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    }
                    .frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    kpis(stats: stats, available: available)
                    HStack(alignment: .top, spacing: Space.md) {
                        agentCard(agents: agents, colors: colors)
                        typeCard(kinds: kinds, total: stats.total, colors: colors, available: available)
                    }
                    statusStrip(stats: stats, available: available)
                }
                if store.loading || readable < sources.count {
                    Text("\(store.loading ? String(localized: "读取中 · ") : "")已读取 \(readable) / \(sources.count) 个配置")
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg4)
                }
            }
            .padding(.horizontal, Space.lg)
            .padding(.top, Space.md)
            .padding(.bottom, Space.xxl)
            .frame(maxWidth: 1180)
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: Pieces

    private struct AgentRow: Identifiable {
        let id: NativeBackendId
        let value: Int
        let available: Bool
    }

    private func agentRows(stats: ExtensionStats, sources: [ExtensionSource]) -> [AgentRow] {
        Self.backendOrder
            .filter { backend in stats.backends[backend] != nil || sources.contains { $0.backendId == backend } }
            .map { backend in
                AgentRow(
                    id: backend,
                    value: stats.backends[backend] ?? 0,
                    available: stats.backends[backend] != nil || sources.contains { $0.backendId == backend && $0.inventory != nil }
                )
            }
            .sorted { $0.value > $1.value }
    }

    private func kpis(stats: ExtensionStats, available: Bool) -> some View {
        let items: [(label: String, value: Int, kind: String?, status: ExtensionStatusFilter)] = [
            (String(localized: "目录条目"), stats.total, nil, .all),
            ("Skills", stats.kinds["skill"] ?? 0, "skill", .all),
            (String(localized: "插件"), stats.kinds["plugin"] ?? 0, "plugin", .all),
            (String(localized: "已停用"), stats.disabled, nil, .disabled),
        ]
        return HStack(alignment: .center, spacing: Space.lg) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                Button { onBrowse(item.kind, nil, item.status) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.label).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                        Text(available ? "\(item.value)" : "—")
                            .font(.riffet(size: S(index == 0 ? 34 : 22), weight: .semibold))
                            .foregroundStyle(palette.fg)
                            .monospacedDigit()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(Space.lg)
        .background(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous).fill(palette.bgSubtle))
    }

    private func agentCard(agents: [AgentRow], colors: [Color]) -> some View {
        let maxValue = max(1, agents.map(\.value).max() ?? 1)
        return StatsCard(title: String(localized: "Agent 分布")) {
            Text("目录条目").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
        } content: {
            if agents.isEmpty {
                StatsEmptyNote(text: String(localized: "暂无 Agent 配置"))
            } else {
                VStack(spacing: 2) {
                    ForEach(Array(agents.enumerated()), id: \.element.id) { index, row in
                        Button { onBrowse(nil, row.id, .all) } label: {
                            HStack(spacing: Space.md) {
                                HStack(spacing: Space.sm) {
                                    AgentIcon(id: backendWire(row.id), size: 13, color: agentMarkColor(row.id, palette))
                                    Text(backendTitle(row.id)).font(.riffet(size: S(12))).foregroundStyle(palette.fg2).lineLimit(1)
                                }
                                .frame(width: 100, alignment: .leading)
                                GeometryReader { proxy in
                                    ZStack(alignment: .leading) {
                                        Capsule().fill(palette.bgMuted)
                                        Capsule().fill(colors[index % colors.count].opacity(0.8))
                                            .frame(width: proxy.size.width * CGFloat(row.value) / CGFloat(maxValue))
                                    }
                                }
                                .frame(height: 6)
                                Text(row.available ? "\(row.value)" : "—")
                                    .font(.riffet(size: S(12))).foregroundStyle(palette.fg2).monospacedDigit()
                                    .frame(width: 36, alignment: .trailing)
                            }
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("查看 \(backendTitle(row.id)) 的扩展")
                    }
                }
                .frame(minHeight: 180, alignment: .center)
            }
        }
    }

    private func typeCard(kinds: [(kind: String, value: Int)], total: Int, colors: [Color], available: Bool) -> some View {
        StatsCard(title: String(localized: "类型分布")) {
            EmptyView()
        } content: {
            if kinds.isEmpty {
                StatsEmptyNote(text: available ? String(localized: "尚无扩展条目") : String(localized: "目录尚未读取成功"))
            } else {
                HStack(alignment: .center, spacing: Space.lg) {
                    Chart(Array(kinds.enumerated()), id: \.element.kind) { index, item in
                        SectorMark(angle: .value("数量", item.value), innerRadius: .ratio(0.64), angularInset: 1.5)
                            .foregroundStyle(colors[index % colors.count].opacity(0.85))
                    }
                    .chartLegend(.hidden)
                    .frame(width: 168, height: 168)
                    .overlay {
                        VStack(spacing: 2) {
                            Text("\(total)").font(.riffet(size: S(22), weight: .semibold)).foregroundStyle(palette.fg).monospacedDigit()
                            Text("目录条目").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                        }
                    }
                    VStack(spacing: 0) {
                        ForEach(Array(kinds.enumerated()), id: \.element.kind) { index, item in
                            Button { onBrowse(item.kind, nil, .all) } label: {
                                HStack(spacing: Space.sm) {
                                    Circle().fill(colors[index % colors.count]).frame(width: 8, height: 8)
                                    Text(item.kind == "config" ? String(localized: "配置文件") : ExtensionText.kind(item.kind))
                                        .font(.riffet(size: S(12))).foregroundStyle(palette.fg2).lineLimit(1)
                                    Spacer(minLength: Space.xs)
                                    Text("\(item.value)").font(.riffet(size: S(12))).foregroundStyle(palette.fg).monospacedDigit()
                                    Text(percent(item.value, total)).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4).monospacedDigit()
                                        .frame(width: 38, alignment: .trailing)
                                }
                                .padding(.vertical, 5)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(maxWidth: 240)
                }
                .frame(maxWidth: .infinity, minHeight: 180)
            }
        }
    }

    private func statusStrip(stats: ExtensionStats, available: Bool) -> some View {
        let items: [(status: ExtensionStatusFilter, label: String, value: Int, color: Color)] = [
            (.enabled, String(localized: "已启用"), stats.enabled, palette.chart2),
            (.disabled, String(localized: "已停用"), stats.disabled, palette.chart8),
            (.unknown, String(localized: "未声明"), stats.unknown, palette.fg4),
        ]
        return HStack(spacing: Space.xl) {
            Text("配置状态").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg3)
            ForEach(items, id: \.status) { item in
                Button { onBrowse(nil, nil, item.status) } label: {
                    HStack(spacing: Space.sm) {
                        Circle().fill(item.color).frame(width: 8, height: 8)
                        Text(item.label).foregroundStyle(palette.fg3)
                        Text(available ? "\(item.value)" : "—").foregroundStyle(palette.fg).monospacedDigit()
                    }
                    .font(.riffet(size: S(12)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(.top, Space.md)
        .padding(.horizontal, 4)
        .overlay(alignment: .top) { Rectangle().fill(palette.line).frame(height: 1) }
    }

    private func percent(_ value: Int, _ total: Int) -> String {
        guard total > 0 else { return "—" }
        let share = Double(value) / Double(total) * 100
        return share < 1 ? "<1%" : "\(Int(share.rounded()))%"
    }
}
