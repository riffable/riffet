import CoreGraphics
import Foundation

/// Parses SVG path data (`d`) into a CGPath, in the path's own units and y-down orientation.
/// Supports every command of SVG 1.1 (M L H V C S Q T A Z, absolute and relative). Pure and thread-safe.
enum SVGPath {
    static func parse(_ d: String) -> CGPath {
        var parser = Parser(Array(d.utf8))
        return parser.run()
    }

    private struct Parser {
        let s: [UInt8]
        var i = 0
        let path = CGMutablePath()
        var cur = CGPoint.zero, start = CGPoint.zero
        var lastCtl: CGPoint?
        var lastCmd: UInt8 = 0

        init(_ s: [UInt8]) { self.s = s }

        mutating func run() -> CGPath {
            var cmd: UInt8 = 0
            while true {
                skipSep()
                if i >= s.count { break }
                let c = s[i]
                if isCmd(c) { cmd = c; i += 1 } else if cmd == 0 { break } else if cmd == UInt8(ascii: "M") { cmd = UInt8(ascii: "L") } else if cmd == UInt8(ascii: "m") { cmd = UInt8(ascii: "l") }
                if cmd == UInt8(ascii: "z") || cmd == UInt8(ascii: "Z") {
                    path.closeSubpath(); cur = start; lastCtl = nil; lastCmd = cmd; continue
                }
                guard exec(cmd) else { break }
                lastCmd = cmd
            }
            return path
        }

        func isCmd(_ c: UInt8) -> Bool {
            switch c { case UInt8(ascii: "M"), UInt8(ascii: "m"), UInt8(ascii: "L"), UInt8(ascii: "l"), UInt8(ascii: "H"), UInt8(ascii: "h"), UInt8(ascii: "V"), UInt8(ascii: "v"), UInt8(ascii: "C"), UInt8(ascii: "c"), UInt8(ascii: "S"), UInt8(ascii: "s"), UInt8(ascii: "Q"), UInt8(ascii: "q"), UInt8(ascii: "T"), UInt8(ascii: "t"), UInt8(ascii: "A"), UInt8(ascii: "a"), UInt8(ascii: "Z"), UInt8(ascii: "z"): return true
            default: return false }
        }

        mutating func skipSep() { while i < s.count, s[i] == 32 || s[i] == 44 || s[i] == 10 || s[i] == 9 || s[i] == 13 { i += 1 } }

        mutating func num() -> Double? {
            skipSep()
            let begin = i
            if i < s.count, s[i] == 43 || s[i] == 45 { i += 1 }
            var digits = false
            while i < s.count, s[i] >= 48, s[i] <= 57 { i += 1; digits = true }
            if i < s.count, s[i] == 46 { i += 1; while i < s.count, s[i] >= 48, s[i] <= 57 { i += 1; digits = true } }
            if digits, i < s.count, s[i] == 101 || s[i] == 69 {
                var j = i + 1
                if j < s.count, s[j] == 43 || s[j] == 45 { j += 1 }
                if j < s.count, s[j] >= 48, s[j] <= 57 { while j < s.count, s[j] >= 48, s[j] <= 57 { j += 1 }; i = j }
            }
            guard digits else { i = begin; return nil }
            return Double(String(decoding: s[begin..<i], as: UTF8.self))
        }

        /// Arc flags may be written without separators ("a2 2 0 011 1").
        mutating func flag() -> Bool? {
            skipSep()
            guard i < s.count, s[i] == 48 || s[i] == 49 else { return nil }
            defer { i += 1 }
            return s[i] == 49
        }

        mutating func exec(_ cmd: UInt8) -> Bool {
            let rel = cmd >= 97
            let ox = rel ? cur.x : 0, oy = rel ? cur.y : 0
            switch cmd | 0x20 {
            case UInt8(ascii: "m"):
                guard let x = num(), let y = num() else { return false }
                cur = CGPoint(x: ox + x, y: oy + y); start = cur; path.move(to: cur); lastCtl = nil
            case UInt8(ascii: "l"):
                guard let x = num(), let y = num() else { return false }
                cur = CGPoint(x: ox + x, y: oy + y); path.addLine(to: cur); lastCtl = nil
            case UInt8(ascii: "h"):
                guard let x = num() else { return false }
                cur = CGPoint(x: ox + x, y: cur.y); path.addLine(to: cur); lastCtl = nil
            case UInt8(ascii: "v"):
                guard let y = num() else { return false }
                cur = CGPoint(x: cur.x, y: oy + y); path.addLine(to: cur); lastCtl = nil
            case UInt8(ascii: "c"):
                guard let a = num(), let b = num(), let c = num(), let d = num(), let x = num(), let y = num() else { return false }
                let c1 = CGPoint(x: ox + a, y: oy + b), c2 = CGPoint(x: ox + c, y: oy + d)
                cur = CGPoint(x: ox + x, y: oy + y); path.addCurve(to: cur, control1: c1, control2: c2); lastCtl = c2
            case UInt8(ascii: "s"):
                guard let c = num(), let d = num(), let x = num(), let y = num() else { return false }
                let prev = lastCmdIsCubic ? lastCtl : nil
                let c1 = prev.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let c2 = CGPoint(x: ox + c, y: oy + d)
                cur = CGPoint(x: ox + x, y: oy + y); path.addCurve(to: cur, control1: c1, control2: c2); lastCtl = c2
            case UInt8(ascii: "q"):
                guard let a = num(), let b = num(), let x = num(), let y = num() else { return false }
                let c1 = CGPoint(x: ox + a, y: oy + b)
                cur = CGPoint(x: ox + x, y: oy + y); path.addQuadCurve(to: cur, control: c1); lastCtl = c1
            case UInt8(ascii: "t"):
                guard let x = num(), let y = num() else { return false }
                let prev = lastCmdIsQuad ? lastCtl : nil
                let c1 = prev.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                cur = CGPoint(x: ox + x, y: oy + y); path.addQuadCurve(to: cur, control: c1); lastCtl = c1
            case UInt8(ascii: "a"):
                guard let rx = num(), let ry = num(), let rot = num(), let large = flag(), let sweep = flag(), let x = num(), let y = num() else { return false }
                let to = CGPoint(x: ox + x, y: oy + y)
                arc(to: to, rx: abs(rx), ry: abs(ry), rotation: rot, large: large, sweep: sweep)
                cur = to; lastCtl = nil
            default: return false
            }
            return true
        }

        var lastCmdIsCubic: Bool { let c = lastCmd | 0x20; return c == UInt8(ascii: "c") || c == UInt8(ascii: "s") }
        var lastCmdIsQuad: Bool { let c = lastCmd | 0x20; return c == UInt8(ascii: "q") || c == UInt8(ascii: "t") }

        /// SVG endpoint arc to cubic Béziers (SVG 1.1 implementation notes, F.6).
        mutating func arc(to p: CGPoint, rx rx0: Double, ry ry0: Double, rotation: Double, large: Bool, sweep: Bool) {
            var rx = rx0, ry = ry0
            if cur == p { return }
            if rx == 0 || ry == 0 { path.addLine(to: p); return }
            let phi = rotation * .pi / 180, cp = cos(phi), sp = sin(phi)
            let dx = (cur.x - p.x) / 2, dy = (cur.y - p.y) / 2
            let x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy
            let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
            if lambda > 1 { let s = lambda.squareRoot(); rx *= s; ry *= s }
            let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
            let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
            var k = den == 0 ? 0 : (max(0, num / den)).squareRoot()
            if large == sweep { k = -k }
            let cxp = k * rx * y1 / ry, cyp = -k * ry * x1 / rx
            let cx = cp * cxp - sp * cyp + (cur.x + p.x) / 2, cy = sp * cxp + cp * cyp + (cur.y + p.y) / 2
            func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
                let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a
            }
            let t1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
            var dt = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
            if !sweep, dt > 0 { dt -= 2 * .pi } else if sweep, dt < 0 { dt += 2 * .pi }
            let n = max(1, Int((abs(dt) / (.pi / 2)).rounded(.up)))
            let step = dt / Double(n)
            let alpha = 4 / 3 * tan(step / 4)
            var a = t1
            for _ in 0..<n {
                let a2 = a + step
                let c1 = (cos(a), sin(a)), c2 = (cos(a2), sin(a2))
                func pt(_ x: Double, _ y: Double) -> CGPoint {
                    CGPoint(x: cp * rx * x - sp * ry * y + cx, y: sp * rx * x + cp * ry * y + cy)
                }
                let q1 = pt(c1.0 - alpha * c1.1, c1.1 + alpha * c1.0)
                let q2 = pt(c2.0 + alpha * c2.1, c2.1 - alpha * c2.0)
                path.addCurve(to: pt(c2.0, c2.1), control1: q1, control2: q2)
                a = a2
            }
            path.addLine(to: p)
        }
    }
}
