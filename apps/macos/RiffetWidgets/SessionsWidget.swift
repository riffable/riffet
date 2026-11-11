import SwiftUI
import WidgetKit

/// The desktop widget: how many conversations wait for an answer or run, and the first few of them.
/// Its only input is the snapshot file the app keeps current (`WidgetSnapshotWriter`); the app also
/// asks WidgetKit to reload when that file changes, and the timeline's own refresh is a fallback.
struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: .now, snapshot: WidgetSnapshot(waiting: 1, running: 2, rows: [
            .init(id: "1", title: String(localized: "整理发布说明"), project: "riffet", state: "waiting", since: nil),
            .init(id: "2", title: String(localized: "修复登录跳转"), project: "web", state: "running", since: .now.addingTimeInterval(-120)),
        ]))
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        // The app reloads on every change it shows; this refresh is what notices an app that died
        // without saying so, since its heartbeat writes do not spend the reload budget.
        completion(Timeline(entries: [current()], policy: .after(.now.addingTimeInterval(15 * 60))))
    }

    private func current() -> SnapshotEntry {
        // A missing or stale snapshot says nothing about whether the app's process is running.
        let stored = (try? Data(contentsOf: WidgetSnapshot.fileURL)).flatMap(WidgetSnapshot.decode)
        let snapshot = stored.flatMap { $0.isStale(at: .now) ? nil : $0 } ?? WidgetSnapshot(offline: true)
        return SnapshotEntry(date: .now, snapshot: snapshot)
    }
}

@main
struct SessionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "io.github.riffetai.mac.widgets.sessions", provider: SnapshotProvider()) { entry in
            SessionsWidgetView(snapshot: entry.snapshot)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Riffet 会话")
        .description("待确认和运行中的会话")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct SessionsWidgetView: View {
    let snapshot: WidgetSnapshot
    @Environment(\.widgetFamily) private var family

    private var limit: Int { family == .systemSmall ? 2 : 3 }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // A zero count is not shown; with neither, the empty line below says it.
            if snapshot.waiting > 0 || snapshot.running > 0 {
                HStack(spacing: 10) {
                    if snapshot.waiting > 0 { count(snapshot.waiting, String(localized: "待确认"), color: .orange) }
                    if snapshot.running > 0 { count(snapshot.running, String(localized: "运行中"), color: .green) }
                    Spacer(minLength: 0)
                }
            }
            if snapshot.rows.isEmpty {
                Spacer(minLength: 0)
                Text(snapshot.offline ? "状态未更新" : "没有运行中的会话")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(snapshot.rows.prefix(limit)) { row in
                        // A small widget has one tap target (`widgetURL`), a medium one can link each row.
                        if family == .systemSmall {
                            SessionRow(row: row, compact: true)
                        } else {
                            Link(destination: url(row.id)) { SessionRow(row: row, compact: false) }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .widgetURL(family == .systemSmall ? snapshot.rows.first.map { url($0.id) } : nil)
    }

    private func count(_ value: Int, _ label: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(value)").font(.title2.weight(.semibold).monospacedDigit()).foregroundStyle(color)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func url(_ id: String) -> URL {
        URL(string: "riffet://session/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")!
    }
}

private struct SessionRow: View {
    let row: WidgetSnapshot.Row
    let compact: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(row.state == "waiting" ? Color.orange : Color.green).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 0) {
                Text(row.title).font(.caption.weight(.medium)).lineLimit(1)
                if !compact, !row.project.isEmpty {
                    Text(row.project).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if !compact {
                if row.state == "waiting" {
                    Text("待确认").font(.caption2).foregroundStyle(.orange)
                } else if let since = row.since {
                    Text(since, style: .timer).font(.caption2.monospacedDigit()).foregroundStyle(.secondary).multilineTextAlignment(.trailing).frame(maxWidth: 52, alignment: .trailing)
                }
            }
        }
    }
}
