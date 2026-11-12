import SwiftUI
import RiffetKit

/// One row of the commit graph, drawn from the shared lane layout.
struct GitGraphCell: View {
    let row: GitGraphRow
    /// How many lanes the widest loaded row has, so every row's text starts at the same edge.
    let lanes: Int
    let height: CGFloat

    static let lane: CGFloat = 12
    static let maxLanes = 9
    private static let palette: [Color] = [.blue, .orange, .green, .purple, .pink, .teal]

    var body: some View {
        Canvas { context, size in
            let mid = size.height / 2
            func x(_ column: Int32) -> CGFloat { (CGFloat(min(Int(column), Self.maxLanes - 1)) + 0.5) * Self.lane }
            func color(_ index: Int32) -> Color { Self.palette[Int(index) % Self.palette.count] }
            func stroke(_ path: Path, _ index: Int32) { context.stroke(path, with: .color(color(index)), lineWidth: 1.5) }
            let own = x(row.column)
            for lane in row.through {
                var path = Path()
                path.move(to: CGPoint(x: x(lane.column), y: 0))
                path.addLine(to: CGPoint(x: x(lane.column), y: size.height))
                stroke(path, lane.color)
            }
            for lane in row.from {
                var path = Path()
                path.move(to: CGPoint(x: x(lane.column), y: 0))
                path.addCurve(to: CGPoint(x: own, y: mid), control1: CGPoint(x: x(lane.column), y: mid), control2: CGPoint(x: own, y: mid * 0.5))
                stroke(path, lane.color)
            }
            for lane in row.to {
                var path = Path()
                path.move(to: CGPoint(x: own, y: mid))
                path.addCurve(to: CGPoint(x: x(lane.column), y: size.height), control1: CGPoint(x: own, y: mid * 1.5), control2: CGPoint(x: x(lane.column), y: mid))
                stroke(path, lane.color)
            }
            let dot = CGRect(x: own - 3.5, y: mid - 3.5, width: 7, height: 7)
            context.fill(Path(ellipseIn: dot), with: .color(color(row.color)))
        }
        .frame(width: CGFloat(max(1, min(lanes, Self.maxLanes))) * Self.lane, height: height)
    }
}
