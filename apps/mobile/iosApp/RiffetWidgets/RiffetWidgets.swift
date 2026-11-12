import ActivityKit
import SwiftUI
import WidgetKit

@main
struct RiffetWidgets: WidgetBundle {
    var body: some Widget { RiffetSummaryActivity() }
}

/// Three counts and nothing else: the lock screen and the Dynamic Island show what needs a look.
struct RiffetSummaryActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RiffetSummaryAttributes.self) { context in
            SummaryCounts(state: context.state)
                .padding(.horizontal, 20).padding(.vertical, 16)
                .widgetURL(Self.home)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) { SummaryCounts(state: context.state) }
            } compactLeading: {
                SummaryCount(kind: .waiting, value: context.state.waiting)
            } compactTrailing: {
                SummaryCount(kind: .running, value: context.state.running)
            } minimal: {
                SummaryCount(kind: context.state.waiting > 0 ? .waiting : .running, value: context.state.waiting > 0 ? context.state.waiting : context.state.running)
            }
            .widgetURL(Self.home)
        }
    }

    static let home = URL(string: "riffet://home")
}

private enum SummaryKind {
    case waiting, running, unseen

    var symbol: String {
        switch self {
        case .waiting: "hand.raised"
        case .running: "circle.dotted"
        case .unseen: "circle.inset.filled"
        }
    }

    func label(_ value: Int) -> String {
        switch self {
        case .waiting: String(localized: "等待你处理：\(value)")
        case .running: String(localized: "正在运行：\(value)")
        case .unseen: String(localized: "未读：\(value)")
        }
    }
}

private struct SummaryCounts: View {
    let state: RiffetSummaryAttributes.ContentState
    var body: some View {
        HStack(spacing: 0) {
            SummaryCount(kind: .waiting, value: state.waiting).frame(maxWidth: .infinity)
            SummaryCount(kind: .running, value: state.running).frame(maxWidth: .infinity)
            SummaryCount(kind: .unseen, value: state.unseen).frame(maxWidth: .infinity)
        }
        .font(.title3.weight(.medium))
    }
}

private struct SummaryCount: View {
    let kind: SummaryKind
    let value: Int
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: kind.symbol)
            Text(value, format: .number).monospacedDigit()
        }
        .foregroundStyle(value > 0 ? .primary : .secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(kind.label(value))
    }
}
