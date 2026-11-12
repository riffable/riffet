import CoreGraphics
import Foundation

// The subagent bar, the call strip, the ledger of writes and the shelf of artifacts: what the canvas prints on a track.

// MARK: - Actor bar

enum CanvasActorPainter {
    static func draw(_ node: CanvasNode.Actor, _ size: CGSize, _ ctx: CGContext, _ p: CanvasPaint) {
        let bar = CGFloat(node.bar)
        let y = p.bar("pad") + p.bar("label") + p.bar("bar") / 2
        let running = node.running == true, failed = node.failed == true
        let tone = running ? p.palette.accent : failed ? p.palette.danger : p.palette.fg
        ctx.setLineCap(.butt)
        if let report = node.report, !running {
            ctx.saveGState()
            ctx.setStrokeColor(p.fg(0.3)); ctx.setLineWidth(1.2); ctx.setLineCap(.round); ctx.setLineDash(phase: 0, lengths: [1, 4])
            ctx.move(to: CGPoint(x: bar + 5, y: y)); ctx.addLine(to: CGPoint(x: CGFloat(report), y: y)); ctx.strokePath()
            ctx.restoreGState()
            let c = CGRect(x: CGFloat(report) - 3, y: y - 3, width: 6, height: 6)
            ctx.setFillColor(p.elevated()); ctx.fillEllipse(in: c)
            ctx.setStrokeColor(p.fg(0.45)); ctx.setLineWidth(1.2); ctx.strokeEllipse(in: c.insetBy(dx: 0, dy: 0))
        }
        let body = CGMutablePath()
        if node.subagent {
            body.move(to: CGPoint(x: 3, y: y)); body.addLine(to: CGPoint(x: max(3.01, bar - 3), y: y))
            let color = p.color(tone, running ? 0.55 : failed ? 0.6 : 0.2)
            if running { p.pulsing(ctx, id: "bar", path: body, stroke: color, width: 6, cap: .round) } else {
                ctx.saveGState(); ctx.setStrokeColor(color); ctx.setLineWidth(6); ctx.setLineCap(.round)
                ctx.addPath(body); ctx.strokePath(); ctx.restoreGState()
            }
        } else {
            body.move(to: CGPoint(x: 0, y: y)); body.addLine(to: CGPoint(x: bar, y: y))
            let color = p.color(tone, running ? 0.7 : failed ? 0.7 : 0.4)
            if running { p.pulsing(ctx, id: "bar", path: body, stroke: color, width: 2, dash: [5, 3]) } else {
                ctx.saveGState(); ctx.setStrokeColor(color); ctx.setLineWidth(2); ctx.setLineDash(phase: 0, lengths: [5, 3])
                ctx.addPath(body); ctx.strokePath(); ctx.restoreGState()
            }
            ctx.setStrokeColor(p.color(tone, 0.4)); ctx.setLineWidth(1.2)
            ctx.move(to: CGPoint(x: 0, y: y - 4)); ctx.addLine(to: CGPoint(x: 0, y: y + 4))
            ctx.move(to: CGPoint(x: bar, y: y - 4)); ctx.addLine(to: CGPoint(x: bar, y: y + 4))
            ctx.strokePath()
        }
        let ticks = CGMutablePath(), bad = CGMutablePath()
        for (i, mark) in node.marks.enumerated() where i != p.marked {
            let target = mark.failed ? bad : ticks
            target.move(to: CGPoint(x: mark.x, y: y - 5)); target.addLine(to: CGPoint(x: mark.x, y: y + 5))
        }
        ctx.setLineWidth(1.2)
        if !ticks.isEmpty { ctx.setStrokeColor(p.fg(0.55)); ctx.addPath(ticks); ctx.strokePath() }
        if !bad.isEmpty { ctx.setStrokeColor(p.danger(0.85)); ctx.addPath(bad); ctx.strokePath() }
        // The marked call, taller and in full ink.
        if let m = p.marked, node.marks.indices.contains(m) {
            ctx.setStrokeColor(p.fg()); ctx.setLineWidth(2)
            ctx.move(to: CGPoint(x: node.marks[m].x, y: y - 7)); ctx.addLine(to: CGPoint(x: node.marks[m].x, y: y + 7)); ctx.strokePath()
        }
        if p.far { return }

        let pen = CanvasPen(ctx: ctx, paint: p)
        let cy = p.bar("pad") + p.bar("label") / 2
        let iconColor = running ? p.accent() : failed ? p.danger() : p.fg4
        pen.icon(node.subagent ? .sparkles : .squareTerminal, x: 0, centerY: cy, iconColor)
        var x: CGFloat = 12 + 6
        let nameStyle = node.subagent ? p.text(.sans(11.5, 500), p.fg2) : p.text(.mono(11), p.fg2)
        let noteText = node.subagent ? node.note : nil
        let noteStyle = p.text(.mono(10.5), p.fg4)
        let timeText = running ? p.strings["running"] : node.elapsed
        let timeStyle = p.text(.sans(10.5, 400, tabular: true), p.fg4)
        var fixed: CGFloat = 0
        if let n = noteText { fixed += 6 + pen.width(n, noteStyle) }
        if let t = timeText { fixed += 6 + pen.width(t, timeStyle) }
        let room = max(0, size.width - x - fixed)
        let nameWidth = pen.text(node.name, nameStyle, x: x, centerY: cy, maxWidth: room)
        // A shrunk name keeps the whole space it was given, ellipsis and all.
        x += pen.width(node.name, nameStyle) > room ? room : nameWidth
        if let n = noteText { x += 6; x += pen.text(n, noteStyle, x: x, centerY: cy) }
        if let t = timeText { x += 6; pen.text(t, timeStyle, x: x, centerY: cy) }
        if let conclusion = node.conclusion {
            let top = p.bar("pad") + p.bar("label") + p.bar("bar")
            pen.text(conclusion, p.text(.sans(11), p.fg3), x: 0, centerY: top + p.bar("line") / 2, maxWidth: size.width)
        }
    }
}

// MARK: - Strip

enum CanvasStripPainter {
    static func draw(_ node: CanvasNode.Tools, _ size: CGSize, _ ctx: CGContext, _ p: CanvasPaint) {
        let w = size.width
        let pad = p.strip("pad"), marks = p.strip("marks"), callout = p.strip("callout"), inset = p.strip("inset")
        let mid = pad + marks / 2
        let below = pad + marks + 2
        // The turn's own stretch of the track, its ends marked.
        ctx.saveGState()
        ctx.setStrokeColor(p.fg(0.16)); ctx.setLineWidth(1); ctx.setLineCap(.butt)
        ctx.move(to: CGPoint(x: inset, y: mid)); ctx.addLine(to: CGPoint(x: w - inset, y: mid))
        ctx.move(to: CGPoint(x: inset, y: mid - 4)); ctx.addLine(to: CGPoint(x: inset, y: mid + 4))
        ctx.move(to: CGPoint(x: w - inset, y: mid - 4)); ctx.addLine(to: CGPoint(x: w - inset, y: mid + 4))
        ctx.strokePath()
        if !p.far {
            for marked in [false, true] {
                ctx.setStrokeColor(p.fg(marked ? 0.5 : 0.18))
                for c in node.callouts where (c.i == p.marked) == marked {
                    let y = below + CGFloat(c.row) * callout + callout / 2
                    let elbow: CGFloat = c.isLeft ? -4 : 4
                    ctx.move(to: CGPoint(x: c.x, y: mid + 5)); ctx.addLine(to: CGPoint(x: c.x, y: y)); ctx.addLine(to: CGPoint(x: c.x + elbow, y: y))
                }
                ctx.strokePath()
            }
        }
        ctx.restoreGState()

        // Every look is one path, so overlapping marks do not darken each other.
        let plain = CGMutablePath(), failed = CGMutablePath(), live = CGMutablePath()
        let focus = CGMutablePath()
        var focusKind = 0
        for (i, mark) in node.marks.enumerated() {
            if i == p.marked { glyph(node.track, mark, mid, into: focus); focusKind = mark.running ? 2 : mark.failed ? 1 : 0; continue }
            let target = mark.running ? live : mark.failed ? failed : plain
            glyph(node.track, mark, mid, into: target)
        }
        func ink(_ path: CGPath, _ kind: Int, focused: Bool) {
            let color = kind == 0 ? p.palette.fg : kind == 1 ? p.palette.danger : p.palette.accent
            let opacity: CGFloat = focused ? 1 : node.track == .shell ? (kind == 0 ? 0.5 : kind == 1 ? 0.85 : 0.9) : node.track == .explore ? (kind == 0 ? 0.4 : kind == 1 ? 0.85 : 0.9) : (kind == 0 ? 0.5 : kind == 1 ? 0.85 : 0.9)
            let shape: CGFloat = node.track == .shell ? (focused ? 7 : 5) : 1.4
            switch node.track {
            case .shell:
                if kind == 2 && !focused { p.pulsing(ctx, id: "live", path: path, stroke: p.color(color, opacity), width: shape, cap: .round); return }
                ctx.saveGState(); ctx.addPath(path)
                ctx.setStrokeColor(p.color(color, opacity)); ctx.setLineWidth(shape); ctx.setLineCap(.round); ctx.strokePath()
                ctx.restoreGState()
            case .explore:
                if kind == 2 && !focused { p.pulsing(ctx, id: "live", path: path, stroke: p.color(color, opacity), fill: p.elevated(), width: shape); return }
                ctx.saveGState()
                ctx.setFillColor(p.elevated()); ctx.addPath(path); ctx.fillPath()
                ctx.setStrokeColor(p.color(color, opacity)); ctx.setLineWidth(shape); ctx.addPath(path); ctx.strokePath()
                ctx.restoreGState()
            default:
                if kind == 2 && !focused { p.pulsing(ctx, id: "live", path: path, fill: p.color(color, opacity)); return }
                ctx.saveGState(); ctx.addPath(path); ctx.setFillColor(p.color(color, opacity)); ctx.fillPath(); ctx.restoreGState()
            }
        }
        for (path, kind) in [(plain, 0), (failed, 1), (live, 2)] where !path.isEmpty { ink(path, kind, focused: false) }
        if !focus.isEmpty { ink(focus, focusKind, focused: true) }
        if p.far { return }

        let pen = CanvasPen(ctx: ctx, paint: p)
        let flexible = node.track == .other || node.track == .ask
        for c in node.callouts {
            let cw = CGFloat(c.w)
            let left = c.isLeft ? c.x - 6 - cw : c.x + 6
            let top = below + CGFloat(c.row) * callout
            let labelFont: CanvasFont = p.font(c.mono == true ? .mono(10.5) : .sans(11, node.track == .other ? 500 : 400))
            // `opacity-50` on the other calls while one is marked.
            let dim: CGFloat = p.marked != nil && p.marked != c.i ? 0.5 : 1
            let labelStyle = p.text(labelFont, p.faded(c.failed == true ? p.danger() : p.fg2, dim))
            let asideStyle = p.text(.sans(10.5, 400, tabular: true), p.faded(p.fg4, dim))
            var label = c.text
            var aside = c.aside
            let natural = pen.width(label, labelStyle)
            var lw = natural
            var aw: CGFloat = 0
            if let a = aside {
                aw = pen.width(a, asideStyle)
                if flexible {
                    lw = min(natural, cw * 0.6)
                    aw = min(aw, max(0, cw - lw - 8))
                } else if natural + 8 + aw > cw {
                    lw = max(0, cw - 8 - aw)
                }
            } else { lw = min(natural, cw) }
            label = CanvasText.truncated(label, labelStyle, width: lw)
            if let a = aside { aside = CanvasText.truncated(a, asideStyle, width: aw) }
            lw = min(lw, pen.width(label, labelStyle))
            let total = lw + (aside != nil ? 8 + (aside.map { pen.width($0, asideStyle) } ?? 0) : 0)
            let startX = c.isLeft ? left + cw - total : left
            // Baseline-aligned: the item whose baseline is lowest sets it.
            let lb = labelFont.baseline(top: top, lineHeight: callout), ab = p.font(.sans(10.5)).baseline(top: top, lineHeight: callout)
            let baseline = aside != nil ? max(lb, ab) : lb
            CanvasText.draw(label, labelStyle, in: ctx, x: startX, baseline: baseline)
            if let a = aside { CanvasText.draw(a, asideStyle, in: ctx, x: startX + lw + 8, baseline: baseline) }
        }
    }

    private static func glyph(_ track: CanvasTrack, _ mark: CanvasMark, _ mid: CGFloat, into path: CGMutablePath) {
        let x = CGFloat(mark.x)
        switch track {
        case .shell:
            path.move(to: CGPoint(x: x, y: mid)); path.addLine(to: CGPoint(x: max(CGFloat(mark.x2), x + 0.01), y: mid))
        case .explore:
            if mark.tick { path.move(to: CGPoint(x: x, y: mid - 6)); path.addLine(to: CGPoint(x: x, y: mid + 6)) }
            else { path.addEllipse(in: CGRect(x: x - 3.5, y: mid - 3.5, width: 7, height: 7)) }
        case .web:
            path.move(to: CGPoint(x: x, y: mid - 4.5)); path.addLine(to: CGPoint(x: x + 4.5, y: mid)); path.addLine(to: CGPoint(x: x, y: mid + 4.5)); path.addLine(to: CGPoint(x: x - 4.5, y: mid)); path.closeSubpath()
        case .ask:
            path.addRect(CGRect(x: x - 0.6, y: mid - 9, width: 1.2, height: 6))
            path.addEllipse(in: CGRect(x: x - 4, y: mid - 3, width: 8, height: 8))
        case .other:
            path.addRect(CGRect(x: x - 3, y: mid - 3, width: 6, height: 6))
        }
    }
}

// MARK: - Ledger

enum CanvasLedgerPainter {
    static func draw(_ node: CanvasNode.Change, _ size: CGSize, _ ctx: CGContext, _ p: CanvasPaint) {
        let rect = CGRect(origin: .zero, size: size)
        ctx.fillRounded(rect, 6, p.ground)
        // The rule down the left: split green and red by what was added and removed.
        let rule = CGRect(x: 0, y: 3, width: 2, height: size.height - 6)
        ctx.saveGState()
        ctx.addPath(canvasRoundedRect(rule, 1)); ctx.clip()
        if node.counted {
            let cut = rule.minY + rule.height * CGFloat(node.share) / 100
            ctx.setFillColor(p.color(p.palette.diffAddMarker, 0.75)); ctx.fill(CGRect(x: 0, y: rule.minY, width: 2, height: cut - rule.minY))
            ctx.setFillColor(p.color(p.palette.diffDelMarker, 0.75)); ctx.fill(CGRect(x: 0, y: cut, width: 2, height: rule.maxY - cut))
        } else {
            ctx.setFillColor(p.fg4(0.75)); ctx.fill(rule)
        }
        ctx.restoreGState()
        if p.far {
            ctx.fillRounded(CGRect(x: 14, y: 9, width: size.width * 0.4, height: 6), 3, p.fg(0.1))
            return
        }
        let pen = CanvasPen(ctx: ctx, paint: p)
        let headH = p.change("head"), fileH = p.change("file"), lineH = p.change("line"), inset = p.change("inset"), gap = p.change("gap")
        let x0: CGFloat = 14, right = size.width - 6
        let headStyle = p.text(.sans(11, 400, tabular: true), p.fg3)
        pen.text(node.count == 1 ? p.strings["oneFile"] : p.strings.files(node.count), headStyle, x: x0, centerY: headH / 2)
        if node.edits == true {
            let w = pen.countsWidth(added: node.added, removed: node.removed, size: 10.5)
            pen.counts(added: node.added, removed: node.removed, size: 10.5, x: right - w, centerY: headH / 2)
        }
        var y = headH
        for file in node.files {
            row(file, y: y, x0: x0, right: right, height: fileH, pen: pen, p: p)
            y += fileH
            if let preview = file.preview, !preview.isEmpty {
                let box = CGRect(x: x0 - 4, y: y, width: right + 4 - (x0 - 4), height: 2 * inset + CGFloat(preview.count) * lineH)
                ctx.fillRounded(box, 8, p.muted)
                ctx.saveGState()
                ctx.addPath(canvasRoundedRect(box, 8)); ctx.clip()
                var ly = y + inset
                for line in preview {
                    drawLine(line, x: box.minX, y: ly, width: box.width, height: lineH, ctx: ctx, pen: pen, p: p)
                    ly += lineH
                }
                ctx.restoreGState()
                y += box.height + gap
            }
        }
        let hidden = node.hidden?.count ?? 0
        if hidden > 0 {
            pen.text(p.strings.moreFiles(hidden), p.text(.sans(11), p.fg4), x: x0 + 20, centerY: y + fileH / 2)
        }
    }

    private static func row(_ f: CanvasNode.Change.File, y: CGFloat, x0: CGFloat, right: CGFloat, height: CGFloat, pen: CanvasPen, p: CanvasPaint) {
        let cy = y + height / 2
        // The file the pointer is on in any ledger: `-mx-1.5 rounded-md px-1.5 bg-hover`.
        if f.path == p.focusPath { pen.ctx.fillRounded(CGRect(x: x0 - 6, y: y, width: right + 6 - (x0 - 6), height: height), 6, p.color(p.palette.bgHover)) }
        let created = f.created == true, deleted = f.deleted == true
        let marker = created ? "+" : deleted ? "−" : "·"
        let markerColor = created ? p.addMarker : deleted ? p.delMarker : p.fg4
        let mStyle = p.text(.mono(11), markerColor)
        let mw = pen.width(marker, mStyle)
        CanvasText.draw(marker, mStyle, in: pen.ctx, x: x0 + (10 - mw) / 2, baseline: mStyle.font.baseline(centeredAt: cy))
        var x = x0 + 10 + 6
        let nameStyle = p.text(.mono(11.5), p.fg2, strike: deleted ? p.fg4 : nil)
        // The count (or the shell's note) at the end first: it never shrinks.
        var tail: CGFloat = 0
        if f.edits == true { tail = pen.countsWidth(added: f.added, removed: f.removed, size: 10.5) } else { tail = pen.width(pen.paint.strings["byCommand"], p.text(.sans(10.5), p.fg4)) }
        let nameW = pen.width(f.name, nameStyle)
        pen.text(f.name, nameStyle, x: x, centerY: cy)
        x += nameW + 6
        let dirRoom = right - tail - 6 - x
        if let dir = f.dir, dirRoom > 0 {
            // `dir="rtl"` with an ellipsis: the start is what goes, and the text sits at the end of its space.
            let style = p.text(.mono(10.5), p.fg4)
            let shown = CanvasText.truncated(dir, style, width: dirRoom, fromStart: true)
            CanvasText.draw(shown, style, in: pen.ctx, x: x + dirRoom, baseline: style.font.baseline(centeredAt: cy), alignRight: true)
        }
        if f.edits == true {
            pen.counts(added: f.added, removed: f.removed, size: 10.5, x: right - tail, centerY: cy)
        } else {
            pen.text(pen.paint.strings["byCommand"], p.text(.sans(10.5), p.fg4), x: right - tail, centerY: cy)
        }
    }

    private static func drawLine(_ line: CanvasDiffLine, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, ctx: CGContext, pen: CanvasPen, p: CanvasPaint) {
        switch line.type {
        case .gap:
            ctx.saveGState()
            ctx.setStrokeColor(p.line); ctx.setLineWidth(1); ctx.setLineDash(phase: 0, lengths: [3, 3])
            let ly = y + height / 2 + 0.5
            ctx.move(to: CGPoint(x: x + 8, y: ly)); ctx.addLine(to: CGPoint(x: x + width - 8, y: ly)); ctx.strokePath()
            ctx.restoreGState()
        case .add, .del, .same:
            let cy = y + height / 2
            if line.type == .add { ctx.setFillColor(p.diffAdd); ctx.fill(CGRect(x: x, y: y, width: width, height: height)) }
            if line.type == .del { ctx.setFillColor(p.diffDel); ctx.fill(CGRect(x: x, y: y, width: width, height: height)) }
            let mark = line.type == .add ? "+" : line.type == .del ? "−" : ""
            let mStyle = p.text(.mono(10.5), line.type == .add ? p.addMarker : p.delMarker)
            if !mark.isEmpty { let mw = pen.width(mark, mStyle); CanvasText.draw(mark, mStyle, in: ctx, x: x + (16 - mw) / 2, baseline: mStyle.font.baseline(centeredAt: cy)) }
            let tStyle = p.text(.mono(10.5), line.type == .same ? p.fg3 : p.fg())
            // `whitespace-pre`, clipped at the end with an ellipsis.
            let shown = CanvasText.truncated(line.text.isEmpty ? " " : line.text, tStyle, width: width - 16 - 8)
            CanvasText.draw(shown, tStyle, in: ctx, x: x + 16, baseline: tStyle.font.baseline(centeredAt: cy))
        }
    }
}

// MARK: - Shelf

enum CanvasShelfPainter {
    static func draw(_ node: CanvasNode.Artifacts, _ size: CGSize, _ ctx: CGContext, _ p: CanvasPaint) {
        let w = p.art("w"), h = p.art("h"), gap = p.art("gap")
        let pen = CanvasPen(ctx: ctx, paint: p)
        for (i, item) in node.items.enumerated() {
            let x = CGFloat(i) * (w + gap)
            let box = CGRect(x: x, y: 0, width: w, height: h)
            if p.far { ctx.fillRounded(box, 7, p.fg(0.07)); continue }
            if item.kind == "image" {
                ctx.fillRounded(box, 7, p.muted)
                if let image = p.image(item.key) {
                    ctx.saveGState()
                    ctx.addPath(canvasRoundedRect(box, 7)); ctx.clip()
                    drawCover(ctx, image, in: box.insetBy(dx: 1, dy: 1))
                    ctx.restoreGState()
                }
                ctx.borderRing(box, 7, p.lineStrong)
            } else {
                ctx.fillRounded(box, 7, p.subtle())
                ctx.saveGState()
                ctx.addPath(canvasRoundedRect(box, 7)); ctx.clip()
                ctx.setFillColor(p.muted); ctx.fill(CGRect(x: x + 1, y: 1, width: w - 2, height: 15))
                ctx.setFillColor(p.line); ctx.fill(CGRect(x: x + 1, y: 16, width: w - 2, height: 1))
                for d in 0..<3 {
                    ctx.setFillColor(p.fg4(0.6))
                    ctx.fillEllipse(in: CGRect(x: x + 1 + 6 + CGFloat(d) * 8, y: 1 + 7.5 - 2.5, width: 5, height: 5))
                }
                ctx.restoreGState()
                pen.icon(.globe, x: x + w / 2 - 7, centerY: 17 + (h - 1 - 17) / 2, size: 14, p.fg4)
                ctx.borderRing(box, 7, p.lineStrong)
            }
            let style = p.text(.mono(10.5), p.fg3)
            let top = h + 5
            CanvasText.draw(CanvasText.truncated(item.name, style, width: w), style, in: ctx, x: x, baseline: style.font.baseline(top: top, lineHeight: 16))
        }
        if node.more > 0 {
            let x = CGFloat(node.items.count) * (w + gap)
            let box = CGRect(x: x, y: 0, width: w, height: h)
            if p.far { ctx.fillRounded(box, 7, p.fg(0.07)) } else {
                ctx.dashedBorder(box, 7, p.lineStrong)
                let style = p.text(.sans(12, 400, tabular: true), p.fg3)
                let t = "+\(node.more)"
                let tw = pen.width(t, style)
                pen.text(t, style, x: x + (w - tw) / 2, centerY: h / 2)
            }
        }
    }
}
