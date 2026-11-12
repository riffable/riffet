import CoreGraphics
import Foundation

// The reader's message, the signal, the fold pin and the agent's answer.

// MARK: - Prompt

enum CanvasPromptPainter {
    static func draw(_ node: CanvasNode.User, _ size: CGSize, _ ctx: CGContext, _ p: CanvasPaint) {
        let rect = CGRect(origin: .zero, size: size)
        if p.far {
            if node.variant == .brief { ctx.dashedBorder(rect, 14, p.fg(0.2)) } else { ctx.fillRounded(rect, 14, p.fg(0.1)) }
            return
        }
        let pen = CanvasPen(ctx: ctx, paint: p)
        if node.variant == .command {
            canvasCard(ctx, rect, radius: 12, fill: p.muted, border: p.line)
            let style = p.text(.mono(12.5), p.fg())
            pen.text(node.text, style, x: 15, centerY: size.height / 2, maxWidth: size.width - 30)
            return
        }
        let brief = node.variant == .brief
        canvasCard(ctx, rect, radius: 14, fill: brief ? p.elevated(0.7) : p.bubble, border: brief ? p.line : nil)
        let b: CGFloat = brief ? 1 : 0
        let x0 = b + 16, width = size.width - 2 * x0
        let hasHeader = brief || node.variant == .scheduled
        let style = p.text(.sans(13), brief ? p.fg2 : p.fg())
        let block = CanvasText.clamp([CanvasText.collapse(node.text.isEmpty ? "…" : more(node.text, 640))], style, width: width, maxLines: max(1, node.lines))
        let images = node.images ?? [], others = node.others ?? 0
        let hasImages = !images.isEmpty
        let sStyle = p.text(.sans(12), p.fg2)
        let steers = (node.steers ?? []).map { CanvasText.clamp([CanvasText.collapse(more($0, 300))], sStyle, width: width - 10, maxLines: 4).lines }

        // The bubble is a column of fixed height: when its content is taller, the clamped paragraphs (overflow hidden, so shrinkable)
        // give way in proportion to their height, as flex-shrink does, and clip their text.
        struct Item { var base: CGFloat; var min: CGFloat; var margin: CGFloat }
        var items: [Item] = []
        if hasHeader { items.append(Item(base: 16, min: 16, margin: 4)) }
        items.append(Item(base: CGFloat(block.lines.count) * 19, min: 0, margin: 0))
        let hasAttach = hasImages || others > 0
        if hasAttach { items.append(Item(base: hasImages ? 44 : 20, min: 0, margin: hasImages ? 8 : 4)) }
        for lines in steers { items.append(Item(base: CGFloat(lines.count) * 17, min: 0, margin: 10)) }
        let available = size.height - 2 * b - 24 - items.reduce(0) { $0 + $1.margin }
        let heights = flexShrink(items.map { ($0.base, $0.min) }, available: available)

        var y = b + 12
        var k = 0
        if hasHeader {
            let handoff = node.origin == "handoff"
            let icon: CanvasIcon = handoff ? .arrowRightLeft : brief ? .gitFork : .clock
            let label = handoff ? p.strings["handoffSummary"] : brief ? p.strings["forkBrief"] : node.origin == "template" ? p.strings["taskTemplate"] : p.strings["scheduled"]
            pen.icon(icon, x: x0, centerY: y + 8, p.fg3)
            pen.text(label, p.text(.sans(11, 500), p.fg3), x: x0 + 12 + 6, centerY: y + 8)
            y += heights[k] + 4; k += 1
        }
        ctx.saveGState()
        ctx.clip(to: CGRect(x: x0, y: y, width: width, height: heights[k]))
        CanvasText.drawLines(block.lines, style, in: ctx, x: x0, top: y, lineHeight: 19)
        ctx.restoreGState()
        y += heights[k]; k += 1
        if hasAttach {
            y += hasImages ? 8 : 4
            let rowH = heights[k]; k += 1
            ctx.saveGState()
            ctx.clip(to: CGRect(x: x0, y: y, width: width, height: rowH))
            let full: CGFloat = hasImages ? 44 : 20
            var x = x0
            for id in images.prefix(6) {
                let image = p.image(id)
                let w: CGFloat = image.map { min(96, 44 * CGFloat($0.width) / max(1, CGFloat($0.height))) } ?? 44
                let box = CGRect(x: x, y: y + full - 44, width: w, height: 44)
                ctx.fillRounded(box, 6, p.muted)
                if let image {
                    ctx.saveGState()
                    ctx.addPath(canvasRoundedRect(box, 6)); ctx.clip()
                    drawCover(ctx, image, in: box)
                    ctx.restoreGState()
                }
                ctx.borderRing(box, 6, p.line)
                x += w + 6
            }
            if others > 0 {
                let cy = y + full - 10
                pen.icon(.paperclip, x: x, centerY: cy, p.fg3)
                pen.text(p.strings.attachments(others), p.text(.sans(11), p.fg3), x: x + 12 + 4, centerY: cy)
            }
            ctx.restoreGState()
            y += rowH
        }
        for lines in steers {
            y += 10
            let height = heights[k]; k += 1
            ctx.saveGState()
            ctx.clip(to: CGRect(x: x0, y: y, width: width, height: height))
            ctx.setFillColor(p.accent(0.4))
            ctx.fill(CGRect(x: x0, y: y, width: 2, height: CGFloat(lines.count) * 17))
            CanvasText.drawLines(lines, sStyle, in: ctx, x: x0 + 10, top: y, lineHeight: 17)
            ctx.restoreGState()
            y += height
        }
    }
}

/// The sizes a flex column of fixed [available] height gives its items of [base] height and [min] floor (`flex-shrink: 1`):
/// content that overflows takes from the items in proportion to their base size, none below its floor.
func flexShrink(_ items: [(base: CGFloat, min: CGFloat)], available: CGFloat) -> [CGFloat] {
    var sizes = items.map { $0.base }
    var frozen = [Bool](repeating: false, count: items.count)
    for _ in 0..<items.count + 1 {
        let total = sizes.reduce(0, +)
        let over = total - available
        if over <= 0.001 { break }
        let weight = zip(items.indices, items).reduce(CGFloat(0)) { frozen[$1.0] ? $0 : $0 + $1.1.base }
        if weight <= 0 { break }
        var hit = false
        var next = sizes
        for i in items.indices where !frozen[i] {
            let target = sizes[i] - over * items[i].base / weight
            if target < items[i].min { next[i] = items[i].min; frozen[i] = true; hit = true } else { next[i] = target }
        }
        sizes = next
        if !hit { break }
    }
    return sizes
}

/// `object-fit: cover; object-position: left top` of [image] in [box] (the context is y-down).
func drawCover(_ ctx: CGContext, _ image: CGImage, in box: CGRect) {
    let iw = CGFloat(image.width), ih = CGFloat(image.height)
    let scale = max(box.width / iw, box.height / ih)
    ctx.saveGState()
    ctx.clip(to: box)
    ctx.translateBy(x: box.minX, y: box.minY + ih * scale)
    ctx.scaleBy(x: scale, y: -scale)
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: iw, height: ih))
    ctx.restoreGState()
}

// MARK: - Signal

enum CanvasSignalPainter {
    static func draw(_ node: CanvasNode.Signal, _ size: CGSize, _ ctx: CGContext, _ p: CanvasPaint) {
        let rect = CGRect(origin: .zero, size: size)
        if p.far { ctx.dashedBorder(rect, 12, p.fg(0.2)); return }
        canvasCard(ctx, rect, radius: 12, fill: p.subtle(0.6), border: p.lineStrong, dashed: true)
        let pen = CanvasPen(ctx: ctx, paint: p)
        let row = p.row("signalRow")
        let arrivals = node.arrivals ?? []
        if arrivals.isEmpty {
            pen.text(p.strings["autoContinue"], p.text(.sans(12), p.fg3), x: 13, centerY: size.height / 2)
            return
        }
        let top = (size.height - CGFloat(arrivals.count) * row) / 2
        let style = p.text(.sans(12), p.fg2)
        for (i, a) in arrivals.enumerated() {
            let cy = top + CGFloat(i) * row + row / 2
            switch a.status {
            case "failed": pen.icon(.circleAlert, x: 13, centerY: cy, p.danger())
            case "running":
                if p.layered { p.spinner(at: CGPoint(x: 13, y: cy - 6), size: 12, color: p.fg3, id: "spin\(i)") } else { pen.icon(.loaderCircle, x: 13, centerY: cy, p.fg3) }
            default: pen.icon(.circleCheck, x: 13, centerY: cy, p.fg3)
            }
            pen.text(a.title, style, x: 13 + 12 + 6, centerY: cy, maxWidth: size.width - 13 - 31)
        }
    }
}

// MARK: - Fold pin

enum CanvasFoldPainter {
    static func draw(_ node: CanvasNode.Fold, _ size: CGSize, _ ctx: CGContext, _ p: CanvasPaint) {
        if p.far { ctx.fillRounded(CGRect(origin: .zero, size: size), size.height / 2, p.fg(0.05)); return }
        let pen = CanvasPen(ctx: ctx, paint: p)
        let label = p.text(.sans(11), p.fg3), tokens = p.text(.mono(10.5, 400, tabular: true), p.fg4)
        let name = p.strings["compaction"]
        var inner: CGFloat = 14 + 6 + pen.width(name, label)
        if !node.tokens.isEmpty { inner += 6 + pen.width(node.tokens, tokens) }
        let pw = inner + 2 * 11
        let rect = CGRect(x: (size.width - pw) / 2, y: 0, width: pw, height: size.height)
        canvasCard(ctx, rect, radius: size.height / 2, fill: p.subtle(), border: p.lineStrong, dashed: true)
        var x = rect.minX + 11
        let cy = size.height / 2
        pen.icon(.foldHorizontal, x: x, centerY: cy, size: 14, p.fg4)
        x += 14 + 6
        x += pen.text(name, label, x: x, centerY: cy) + 6
        if !node.tokens.isEmpty { pen.text(node.tokens, tokens, x: x, centerY: cy) }
    }
}

// MARK: - Answer

enum CanvasAnswerPainter {
    static let shadows: [CanvasShadow] = [
        CanvasShadow(dx: 0, dy: 1, blur: 1, spread: 0, color: CGColor(gray: 0, alpha: 0.03)),
        CanvasShadow(dx: 0, dy: 10, blur: 28, spread: -16, color: CGColor(gray: 0, alpha: 0.22)),
    ]

    static let hotShadows: [CanvasShadow] = [
        CanvasShadow(dx: 0, dy: 1, blur: 1, spread: 0, color: CGColor(gray: 0, alpha: 0.04)),
        CanvasShadow(dx: 0, dy: 16, blur: 36, spread: -16, color: CGColor(gray: 0, alpha: 0.3)),
    ]

    static func draw(_ node: CanvasNode.Agent, _ box: CanvasNode, _ size: CGSize, _ ctx: CGContext, _ layout: CanvasLayout, _ p: CanvasPaint) {
        let rect = CGRect(origin: .zero, size: size)
        if p.far { ctx.fillRounded(rect, 14, p.fg(0.07)); return }
        let running = node.running == true
        let errored = node.errored == true
        let stopped = node.stopped == true && !errored
        // The pointer on the card, or its column lit, firms the border; the pointer also lifts the shadow (`answerHover`).
        let strong = p.hot || p.lit
        if !stopped { ctx.boxShadows(rect, 14, p.hot ? hotShadows : shadows) }
        ctx.fillRounded(rect, 14, p.elevated())
        if stopped { ctx.dashedBorder(rect, 14, p.lineStrong) } else { ctx.borderRing(rect, 14, strong ? p.lineStrong : errored ? p.danger(0.4) : p.line) }
        let pad = p.row("agentPad")
        let inset = 1 + pad
        let inner = CGRect(x: 1, y: 1, width: size.width - 2, height: size.height - 2)
        ctx.saveGState()
        ctx.addPath(canvasRoundedRect(inner, 13)); ctx.clip()
        if running { shimmer(ctx, size, p) }
        let pen = CanvasPen(ctx: ctx, paint: p)
        let x0 = inset, width = size.width - 2 * inset
        // The head: which agent, how long, how it ended; the diff or the live mark at the end.
        let metaH = p.row("meta")
        let cy = inset + metaH / 2
        let session = box.ti.flatMap { layout.turns.indices.contains($0) ? layout.sessions[layout.turns[$0].si] : nil }
        var x = x0
        pen.icon(.sparkle, x: x, centerY: cy, p.fg3)
        x += 12 + 8
        let meta500 = p.font(.sans(11, 500, tabular: true))
        x += pen.text(p.backendLabel(session?.backend), p.text(meta500, p.fg2), x: x, centerY: cy) + 8
        // The web gives a finished card no clock (`elapsed` is measured from a `now` it only passes to a running one).
        if running, let elapsed = node.elapsed { x += pen.text(elapsed, p.text(meta500, p.fg4), x: x, centerY: cy) + 8 }
        if errored { x += pen.text(p.strings["turnError"], p.text(meta500, p.danger()), x: x, centerY: cy) + 8 }
        if stopped { x += pen.text(p.strings["interrupted"], p.text(meta500, p.fg3), x: x, centerY: cy) + 8 }
        let right = size.width - inset
        if let diff = node.diff, !running {
            let w = pen.countsWidth(added: diff.added, removed: diff.removed, size: 10.5, tabular: true)
            pen.counts(added: diff.added, removed: diff.removed, size: 10.5, x: right - w, centerY: cy, addedColor: p.success, removedColor: p.danger(0.8))
            // `text-success` for the added count, as the card sets it (not the diff marker).
        }
        if running { live(ctx, right: right, centerY: cy, pen: pen, p: p) }

        var y = inset + metaH + 6
        if let blocks = node.blocks {
            if blocks.isEmpty {
                pen.textTop(running ? p.strings["running"] : p.strings["noBody"], p.text(.sans(13), p.fg4), x: x0, top: y, lineHeight: 19)
            }
            for block in blocks {
                CanvasBlockPainter.draw(block, x: x0, y: y, width: width, size: size, pen: pen, p: p)
                y += blockHeight(block) + p.row("blockGap")
            }
        } else {
            let text: String, style: CanvasTextStyle
            if let summary = node.summary, !running, !summary.isEmpty { text = summary; style = p.text(.sans(13, 500), p.fg()) }
            else if let preview = node.preview, !preview.isEmpty { text = preview; style = p.text(.sans(13), p.fg()) }
            else { text = running ? p.strings["running"] : node.pending == true ? "" : p.strings["noBody"]; style = p.text(.sans(13), p.fg4) }
            let block = CanvasText.clamp([CanvasText.collapse(more(text, node.summary == nil ? 220 : .max))], style, width: width, maxLines: max(1, node.previewLines ?? 1))
            CanvasText.drawLines(text.isEmpty ? [] : block.lines, style, in: ctx, x: x0, top: y, lineHeight: 19)
            if node.activity != nil {
                activity(node, x: x0, bottom: size.height - inset, pen: pen, p: p)
            }
        }
        ctx.restoreGState()
    }

    static func blockHeight(_ block: CanvasBlock) -> CGFloat {
        switch block {
        case .thought(_, let h), .commentary(_, let h), .plan(_, _, _, let h), .actor(_, _, _, let h), .calls(_, _, let h),
             .compaction(_, let h), .status(_, let h), .answer(_, _, let h), .unknown(let h): CGFloat(h)
        }
    }

    /// What the turn did, as counts by tool: the transcript's icons, quiet, at the foot of the card.
    private static func activity(_ node: CanvasNode.Agent, x: CGFloat, bottom: CGFloat, pen: CanvasPen, p: CanvasPaint) {
        let cy = bottom - 11
        var cursor = x
        let count = p.text(.sans(11, 400, tabular: true), p.fg4)
        for item in node.activity ?? [] {
            pen.icon(CanvasIcons.tool(item.tool), x: cursor, centerY: cy, p.fg4)
            cursor += 12 + 4
            cursor += pen.text("\(item.count)", count, x: cursor, centerY: cy) + 12
        }
        let near = p.text(.sans(11, 400, tabular: true), p.fg3)
        if let n = node.subagents, n > 0 {
            pen.icon(.sparkles, x: cursor, centerY: cy, p.fg3)
            cursor += 12 + 4
            cursor += pen.text("\(n)", near, x: cursor, centerY: cy) + 12
        }
        if let n = node.background, n > 0 {
            pen.icon(.squareTerminal, x: cursor, centerY: cy, p.fg3)
            cursor += 12 + 4
            pen.text("\(n)", near, x: cursor, centerY: cy)
        }
    }

    /// A working card's end of the head: the output rate as a sparkline and a number, or a pulsing dot before there is one.
    private static func live(_ ctx: CGContext, right: CGFloat, centerY cy: CGFloat, pen: CanvasPen, p: CanvasPaint) {
        guard let pulse = p.pulse else {
            let dot = CGRect(x: right - 6, y: cy - 3, width: 6, height: 6)
            if p.layered { p.liveDot(dot, id: "live") } else { ctx.fillRounded(dot, 3, p.accent()) }
            return
        }
        let rate = "\(Int(pulse.rate.rounded())) t/s"
        let style = p.text(.sans(10.5), p.accent())
        pen.text(rate, style, x: right - pen.width(rate, style), centerY: cy)
        let series = pulse.series
        guard series.count >= 2 else { return }
        // `w-12` for the number, `gap-1.5`, then a 44 x 13 box with the line inside.
        let box = CGRect(x: right - 48 - 6 - 44, y: cy - 6.5, width: 44, height: 13)
        let peak = max(series.max() ?? 1, 1)
        let line = CGMutablePath()
        for (i, v) in series.enumerated() {
            let pt = CGPoint(x: box.minX + CGFloat(i) / CGFloat(series.count - 1) * 44, y: box.minY + 12 - CGFloat(v / peak) * 11)
            i == 0 ? line.move(to: pt) : line.addLine(to: pt)
        }
        ctx.saveGState()
        ctx.setStrokeColor(p.accent()); ctx.setLineWidth(1.2); ctx.setLineCap(.round); ctx.setLineJoin(.round)
        ctx.addPath(line); ctx.strokePath()
        ctx.setFillColor(p.accent())
        ctx.fillEllipse(in: CGRect(x: box.maxX - 1.6, y: box.minY + 12 - CGFloat((series.last ?? 0) / peak) * 11 - 1.6, width: 3.2, height: 3.2))
        ctx.restoreGState()
    }

    /// The band of the accent along a working card's top edge. In a bitmap it holds its first position; on a surface it sweeps as a layer
    /// (`canvas-shimmer`), quicker the more the turn writes.
    private static func shimmer(_ ctx: CGContext, _ size: CGSize, _ p: CanvasPaint) {
        let width = size.width - 40
        let band = CGRect(x: 20, y: 1, width: width, height: 1.5)
        if p.layered {
            let seconds = p.pulse.map { min(2.6, max(0.6, 2.6 - $0.rate / 50)) } ?? 1.8
            p.sink?.add(CanvasAccessory(id: "shimmer", motion: .shimmer(seconds: seconds), frame: band, fill: p.accent(0.7)))
            return
        }
        ctx.saveGState()
        ctx.addPath(canvasRoundedRect(band, 0.75)); ctx.clip()
        let colors = [p.accent(0), p.accent(0.7), p.accent(0)] as CFArray
        if let gradient = CGGradient(colorsSpace: CanvasPaint.srgb, colors: colors, locations: [0, 0.5, 1]) {
            ctx.drawLinearGradient(gradient, start: CGPoint(x: band.minX, y: 0), end: CGPoint(x: band.minX + width / 2, y: 0), options: [])
        }
        ctx.restoreGState()
    }
}

extension CanvasPen {
    /// Text whose line box starts at [top].
    @discardableResult
    func textTop(_ s: String, _ style: CanvasTextStyle, x: CGFloat, top: CGFloat, lineHeight: CGFloat) -> CGFloat {
        CanvasText.draw(s, style, in: ctx, x: x, baseline: style.font.baseline(top: top, lineHeight: lineHeight))
    }
}

// MARK: - Answer blocks

enum CanvasBlockPainter {
    static func draw(_ block: CanvasBlock, x: CGFloat, y: CGFloat, width: CGFloat, size: CGSize, pen: CanvasPen, p: CanvasPaint) {
        let ctx = pen.ctx
        switch block {
        case .thought(let text, _):
            let style = p.text(.sans(12, 400, italic: true), p.fg3)
            pen.icon(.brain, x: x, centerY: y + 3 + 6, p.fg4)
            let lines = CanvasText.clamp([CanvasText.collapse(more(text, 140))], style, width: width - 18, maxLines: 2).lines
            CanvasText.drawLines(lines, style, in: ctx, x: x + 18, top: y, lineHeight: 18)
        case .commentary(let text, _):
            let style = p.text(.sans(12.5), p.fg2)
            let lines = CanvasText.clamp([CanvasText.collapse(more(text, 140))], style, width: width, maxLines: 2).lines
            CanvasText.drawLines(lines, style, in: ctx, x: x, top: y, lineHeight: 18)
        case .plan(let title, let entries, let hidden, let h):
            let box = CGRect(x: x - 6, y: y, width: width + 12, height: CGFloat(h))
            ctx.borderRing(box, 10, p.lineSoft)
            let x0 = box.minX + 1 + 8
            var cy = y + 1 + 4 + 10
            pen.icon(.listChecks, x: x0, centerY: cy, p.fg3)
            pen.text(title, p.text(.sans(11, 500), p.fg3), x: x0 + 18, centerY: cy)
            let rowH = p.row("planRow")
            cy += 10 + rowH / 2
            let room = box.width - 2 - 16 - 20
            for entry in entries {
                switch entry.status {
                case "completed": pen.icon(.check, x: x0, centerY: cy, p.fg4)
                case "in_progress": ctx.fillRounded(CGRect(x: x0 + 3, y: cy - 3, width: 6, height: 6), 3, p.accent())
                default: pen.icon(.circle, x: x0, centerY: cy, p.fg4)
                }
                let done = entry.status == "completed"
                pen.text(entry.text, p.text(.sans(12), done ? p.fg4 : p.fg2, strike: done ? p.fg4(0.5) : nil), x: x0 + 20, centerY: cy, maxWidth: room)
                cy += rowH
            }
            if hidden > 0 { pen.text("+\(hidden)", p.text(.sans(11), p.fg4), x: x0 + 20, centerY: cy) }
        case .actor(let background, let label, let duration, let h):
            let box = CGRect(x: x - 6, y: y, width: width + 12, height: CGFloat(h))
            ctx.borderRing(box, 10, p.lineSoft)
            let cy = y + CGFloat(h) / 2
            let x0 = box.minX + 1 + 6
            pen.icon(background ? .squareTerminal : .sparkles, x: x0, centerY: cy, p.fg3)
            let dStyle = p.text(.sans(11, 400, tabular: true), p.fg4)
            let dw = pen.width(duration, dStyle)
            let right = box.maxX - 1 - 6
            pen.text(duration, dStyle, x: right - dw, centerY: cy)
            pen.text(label, p.text(.sans(12), p.fg2), x: x0 + 20, centerY: cy, maxWidth: right - dw - 8 - (x0 + 20))
        case .calls(let items, let failed, let h):
            let cy = y + CGFloat(h) / 2
            var cursor = x
            let style = p.text(.sans(11, 400, tabular: true), p.fg4)
            let times = p.text(.sans(11, 400, tabular: true), p.fg4(0.8))
            for item in items {
                pen.icon(CanvasIcons.tool(item.tool), x: cursor, centerY: cy, p.fg4)
                cursor += 12 + 4
                cursor += pen.text(item.name, style, x: cursor, centerY: cy)
                if item.count > 1 { cursor += 4; cursor += pen.text("×\(item.count)", times, x: cursor, centerY: cy) }
                cursor += 12
            }
            if failed { pen.icon(.circleAlert, x: cursor, centerY: cy, p.danger()) }
        case .compaction(let text, let h):
            let cy = y + CGFloat(h) / 2
            let style = p.text(.sans(10.5), p.fg4)
            let tw = pen.width(text, style)
            let each = max(0, (width - tw - 16) / 2)
            ctx.setFillColor(p.line)
            ctx.fill(CGRect(x: x, y: cy - 0.5, width: each, height: 1))
            pen.text(text, style, x: x + each + 8, centerY: cy)
            ctx.fill(CGRect(x: x + each + 16 + tw, y: cy - 0.5, width: each, height: 1))
        case .status(let text, _):
            let style = p.text(.sans(12), p.danger())
            CanvasText.draw(CanvasText.truncated(text, style, width: width), style, in: ctx, x: x, baseline: style.font.baseline(top: y, lineHeight: 22))
        case .answer(let text, let lines, _):
            ctx.setFillColor(p.lineSoft)
            ctx.fill(CGRect(x: x, y: y, width: width, height: 1))
            let style = p.text(.sans(13), p.fg())
            let block = CanvasText.clamp(CanvasText.paragraphs(more(text, 1000)), style, width: width, maxLines: max(1, lines))
            CanvasText.drawLines(block.lines, style, in: ctx, x: x, top: y + 1 + 8, lineHeight: 19)
        case .unknown: break
        }
    }
}

/// The layout engine cuts a card's text at [limit] characters (the card clamps it to a few lines anyway); a text at the limit
/// went on, so it ends in an ellipsis.
func more(_ text: String, _ limit: Int) -> String { text.count >= limit ? text + "…" : text }
