import CoreGraphics

/// A uniform grid over the items' frames. Culling, hit testing and raster planning all ask it for "what is in this
/// rect", so the cost of a frame follows the number of items in view, never the number on the plane.
struct SpatialGrid {
    private var cell: CGFloat = 512
    private var origin = CGPoint.zero
    private var cols = 0, rows = 0
    private var cells: [[Int32]] = []
    private var frames: [CGRect] = []
    private var seen: [UInt32] = []
    private var token: UInt32 = 0

    /// Indices refer to positions in `frames`. A wide item sits in every cell it touches.
    mutating func rebuild(_ frames: [CGRect]) {
        self.frames = frames
        seen = [UInt32](repeating: 0, count: frames.count)
        token = 0
        guard let first = frames.first else { cells = []; cols = 0; rows = 0; return }
        var bounds = first
        for f in frames.dropFirst() { bounds = bounds.union(f) }
        origin = bounds.origin
        // Keep the grid small on very large planes: the cell grows until the table has at most 2^17 cells.
        cell = 512
        while (bounds.width / cell + 1) * (bounds.height / cell + 1) > 131_072 { cell *= 2 }
        cols = Int(bounds.width / cell) + 1
        rows = Int(bounds.height / cell) + 1
        cells = [[Int32]](repeating: [], count: cols * rows)
        for (i, f) in frames.enumerated() {
            let (c0, c1, r0, r1) = span(f)
            for r in r0...r1 { for c in c0...c1 { cells[r * cols + c].append(Int32(i)) } }
        }
    }

    private func span(_ rect: CGRect) -> (Int, Int, Int, Int) {
        func clamp(_ v: CGFloat, _ n: Int) -> Int { max(0, min(n - 1, Int((v / cell).rounded(.down)))) }
        return (clamp(rect.minX - origin.x, cols), clamp(rect.maxX - origin.x, cols), clamp(rect.minY - origin.y, rows), clamp(rect.maxY - origin.y, rows))
    }

    /// Indices of frames intersecting `rect`, each once, in no particular order.
    mutating func query(_ rect: CGRect, into out: inout [Int32]) {
        out.removeAll(keepingCapacity: true)
        guard cols > 0 else { return }
        token &+= 1
        if token == 0 { for i in seen.indices { seen[i] = 0 }; token = 1 }
        let (c0, c1, r0, r1) = span(rect)
        for r in r0...r1 {
            for c in c0...c1 {
                for i in cells[r * cols + c] where seen[Int(i)] != token {
                    seen[Int(i)] = token
                    if frames[Int(i)].intersects(rect) { out.append(i) }
                }
            }
        }
    }

    /// Indices of frames containing `point`.
    mutating func hits(_ point: CGPoint, into out: inout [Int32]) {
        query(CGRect(x: point.x, y: point.y, width: 0.001, height: 0.001), into: &out)
        out.removeAll { !frames[Int($0)].contains(point) }
    }
}
