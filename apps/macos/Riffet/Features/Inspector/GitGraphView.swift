import SwiftUI
import RiffetKit

/// Geometry of the history list: one row, and the width a lane takes in the graph.
enum GitGraphMetrics {
    static let rowHeight: CGFloat = 28
    static let laneWidth: CGFloat = 12
    static let maxLanes = 9
    static let dot: CGFloat = 3.5
}

/// One commit's slice of the graph, drawn from its own lanes so the rows join up top to bottom.
struct GitGraphCell: View {
    let row: GitGraphRow
    /// Lanes the list leaves room for, the widest drawn row.
    let lanes: Int
    @Environment(\.palette) private var palette

    var body: some View {
        let colors = [palette.accent, palette.success, palette.warning, palette.danger, palette.fg2, palette.fg4]
        let step = GitGraphMetrics.laneWidth
        let limit = GitGraphMetrics.maxLanes
        Canvas { context, size in
            let mid = size.height / 2
            func x(_ column: Int32) -> CGFloat { CGFloat(column) * step + step / 2 }
            func color(_ value: Int32) -> Color { colors[Int(value) % colors.count] }
            func stroke(_ path: Path, _ value: Int32) {
                context.stroke(path, with: .color(color(value)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            }
            for lane in row.through where Int(lane.column) < limit {
                var path = Path()
                path.move(to: CGPoint(x: x(lane.column), y: 0))
                path.addLine(to: CGPoint(x: x(lane.column), y: size.height))
                stroke(path, lane.color)
            }
            let here = x(row.column)
            for lane in row.from where Int(lane.column) < limit || Int(row.column) < limit {
                var path = Path()
                let start = x(min(lane.column, Int32(limit - 1)))
                path.move(to: CGPoint(x: start, y: 0))
                if lane.column == row.column {
                    path.addLine(to: CGPoint(x: here, y: mid))
                } else {
                    path.addCurve(to: CGPoint(x: here, y: mid), control1: CGPoint(x: start, y: mid * 0.9), control2: CGPoint(x: here, y: mid * 0.1))
                }
                stroke(path, lane.color)
            }
            for lane in row.to where Int(lane.column) < limit || Int(row.column) < limit {
                var path = Path()
                let end = x(min(lane.column, Int32(limit - 1)))
                path.move(to: CGPoint(x: here, y: mid))
                if lane.column == row.column {
                    path.addLine(to: CGPoint(x: end, y: size.height))
                } else {
                    path.addCurve(to: CGPoint(x: end, y: size.height), control1: CGPoint(x: here, y: mid + mid * 0.9), control2: CGPoint(x: end, y: mid + mid * 0.1))
                }
                stroke(path, lane.color)
            }
            if Int(row.column) < limit {
                let r = GitGraphMetrics.dot
                let dot = Path(ellipseIn: CGRect(x: here - r, y: mid - r, width: r * 2, height: r * 2))
                context.fill(dot, with: .color(color(row.color)))
            }
        }
        .frame(width: CGFloat(min(lanes, limit)) * step, height: GitGraphMetrics.rowHeight)
        .accessibilityHidden(true)
    }
}

/// A branch, tag or remote name beside a commit: the checked-out branch stands out, the rest stay quiet.
struct GitRefChip: View {
    let label: GitRefLabel
    @Environment(\.palette) private var palette

    var body: some View {
        let emphasised = label.current?.boolValue == true || label.kind == .head
        Text(label.name)
            .font(.riffet(size: S(10), weight: emphasised ? .semibold : .medium, design: .monospaced))
            .foregroundStyle(emphasised ? palette.accent : palette.fg3)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 5)
            .frame(height: 18)
            .background((emphasised ? palette.accent : palette.fg3).opacity(emphasised ? 0.14 : 0.1), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .frame(maxWidth: 120)
            .fixedSize()
    }
}

struct GitCommitRow: View {
    let commit: GitCommit
    let graph: GitGraphRow?
    let lanes: Int
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            if let graph { GitGraphCell(row: graph, lanes: lanes) }
            ForEach(Array(commit.refs.prefix(2).enumerated()), id: \.offset) { _, label in GitRefChip(label: label) }
            if commit.refs.count > 2 {
                Text("+\(commit.refs.count - 2)").font(.riffet(size: S(10), design: .monospaced)).foregroundStyle(palette.fg4)
            }
            Text(commit.subject)
                .font(.riffet(size: S(13)))
                .foregroundStyle(palette.fg)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(commit.author)
                .font(.riffet(size: S(11)))
                .foregroundStyle(palette.fg4)
                .lineLimit(1)
                .frame(maxWidth: 72, alignment: .trailing)
            Text(gitRelativeDate(commit.date))
                .font(.riffet(size: S(11)))
                .foregroundStyle(palette.fg4)
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.horizontal, Space.sm)
        .frame(height: GitGraphMetrics.rowHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// "3d ago", always in English like the rest of the panel.
func gitRelativeDate(_ value: String) -> String {
    guard let date = ServerTime.date(value) else { return "" }
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: "en_US")
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: date, relativeTo: .now)
}

func gitAbsoluteDate(_ value: String) -> String {
    guard let date = ServerTime.date(value) else { return value }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US")
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: date)
}
