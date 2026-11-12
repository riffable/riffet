import CoreGraphics
import Foundation

/// Draws one node of the canvas into a CGContext, in node-local canvas units: the origin is the node's top-left corner, y grows
/// downward, and the card fills `(0, 0, w, h)`. Every measure is the CSS of `plugins/riffet/canvas/web/cards.tsx`: paddings, radii,
/// font sizes, line heights, tokens and opacities. Pure functions of the node and `CanvasPaint`; callable from any thread.
enum CanvasNodePainter {
    /// Draws [node] into [ctx] (y-down, origin at the node's top-left; text and shadows are drawn at the context's own scale).
    /// Shadows are drawn outside the box, so the context should cover `shadowOutset` beyond it.
    static func draw(_ node: CanvasNode, in ctx: CGContext, layout: CanvasLayout, paint: CanvasPaint) {
        ctx.saveGState()
        ctx.setShouldSmoothFonts(false)
        ctx.setAllowsFontSmoothing(false)
        ctx.setShouldSubpixelPositionFonts(true)
        ctx.setShouldSubpixelQuantizeFonts(false)
        ctx.setShouldAntialias(true)
        let size = CGSize(width: node.w, height: node.h)
        switch node.kind {
        case .header(let header): CanvasHeaderPainter.draw(header, size, ctx, layout, paint)
        case .user(let user): CanvasPromptPainter.draw(user, size, ctx, paint)
        case .signal(let signal): CanvasSignalPainter.draw(signal, size, ctx, paint)
        case .agent(let agent): CanvasAnswerPainter.draw(agent, node, size, ctx, layout, paint)
        case .actor(let actor): CanvasActorPainter.draw(actor, size, ctx, paint)
        case .fold(let fold): CanvasFoldPainter.draw(fold, size, ctx, paint)
        case .change(let change): CanvasLedgerPainter.draw(change, size, ctx, paint)
        case .artifacts(let shelf): CanvasShelfPainter.draw(shelf, size, ctx, paint)
        case .tools(let tools): CanvasStripPainter.draw(tools, size, ctx, paint)
        case .unknown: break
        }
        ctx.restoreGState()
    }

    /// How far outside its box a node paints (an answer's shadow): the bitmap of a node wants this much margin.
    static func outset(of node: CanvasNode, paint: CanvasPaint) -> CGFloat {
        if case .agent = node.kind, !paint.far { return 46 }
        return 0
    }
}

// MARK: - Layout helpers

/// Text placed on a row: the helpers draw at a vertical centre, or measure.
struct CanvasPen {
    let ctx: CGContext
    let paint: CanvasPaint

    @discardableResult
    func text(_ s: String, _ style: CanvasTextStyle, x: CGFloat, centerY: CGFloat, maxWidth: CGFloat? = nil) -> CGFloat {
        let shown = maxWidth.map { CanvasText.truncated(s, style, width: $0) } ?? s
        return CanvasText.draw(shown, style, in: ctx, x: x, baseline: style.font.baseline(centeredAt: centerY))
    }
    func width(_ s: String, _ style: CanvasTextStyle) -> CGFloat { CanvasText.width(s, style) }
    func icon(_ icon: CanvasIcon, x: CGFloat, centerY: CGFloat, size: CGFloat = 12, _ color: CGColor) {
        ctx.icon(icon, x: x, y: centerY - size / 2, size: size, color: color, zoom: paint.zoom)
    }
    /// `+N −M` as the ledgers and heads print it: mono, green and red.
    @discardableResult
    func counts(added: Int, removed: Int, size: CGFloat, x: CGFloat, centerY: CGFloat, addedColor: CGColor? = nil, removedColor: CGColor? = nil, tabular: Bool = true) -> CGFloat {
        let font = paint.font(.mono(size, 400, tabular: tabular))
        let plus = paint.text(font, addedColor ?? paint.addMarker), minus = paint.text(font, removedColor ?? paint.delMarker), space = paint.text(font, paint.fg())
        var cursor = x
        cursor += text("+\(added)", plus, x: cursor, centerY: centerY)
        cursor += width(" ", space)
        cursor += text("−\(removed)", minus, x: cursor, centerY: centerY)
        return cursor - x
    }
    func countsWidth(added: Int, removed: Int, size: CGFloat, tabular: Bool = true) -> CGFloat {
        let font = paint.font(.mono(size, 400, tabular: tabular))
        let s = paint.text(font, paint.fg())
        return width("+\(added)", s) + width(" ", s) + width("−\(removed)", s)
    }
}

/// A box filled and bordered the way a card is.
func canvasCard(_ ctx: CGContext, _ rect: CGRect, radius: CGFloat, fill: CGColor?, border: CGColor?, dashed: Bool = false) {
    if let fill { ctx.fillRounded(rect, radius, fill) }
    if let border { dashed ? ctx.dashedBorder(rect, radius, border) : ctx.borderRing(rect, radius, border) }
}

func canvasClipRounded(_ ctx: CGContext, _ rect: CGRect, _ radius: CGFloat) {
    ctx.addPath(canvasRoundedRect(rect, radius))
    ctx.clip()
}

// MARK: - Header

enum CanvasHeaderPainter {
    static func draw(_ node: CanvasNode.Header, _ size: CGSize, _ ctx: CGContext, _ layout: CanvasLayout, _ p: CanvasPaint) {
        let h = size.height
        if p.far {
            ctx.fillRounded(CGRect(x: 4, y: (h - 10) / 2, width: 192, height: 10), 5, p.fg(0.15))
            return
        }
        let pen = CanvasPen(ctx: ctx, paint: p)
        let midY = h / 2
        var x: CGFloat = 4
        let right = size.width - 4
        if let fork = node.fork {
            pen.icon(fork == "handoff" ? .arrowRightLeft : .gitFork, x: x, centerY: midY, size: 14, p.fg3)
            x += 14 + 8
        }
        let titleStyle = p.text(.sans(16, 600, tracking: -0.01), p.fg())
        let metaStyle = p.text(.sans(12), p.fg4)
        let session = layout.sessions.indices.contains(node.si) ? layout.sessions[node.si] : nil
        let meta = "\(p.backendLabel(session?.backend))" + (session?.model.map { " · \($0)" } ?? "")
        let metaWidth = pen.width(meta, metaStyle)
        var rightWidth: CGFloat = 0
        var rightItems: (files: String, filesW: CGFloat, countsW: CGFloat)?
        if let written = node.written {
            let filesText = p.strings.files(written.files)
            let filesStyle = p.text(.sans(11, 400, tabular: true), p.fg4)
            let fw = pen.width(filesText, filesStyle)
            let cw = pen.countsWidth(added: written.added, removed: written.removed, size: 10.5)
            rightItems = (filesText, fw, cw)
            rightWidth = 14 + 6 + fw + 6 + cw
        }
        let liveWidth: CGFloat = node.live == true ? 6 : 0
        // Title, meta and the dot are in a row with gaps of 8; the right group is pushed to the end.
        var fixed = metaWidth + 8 + (liveWidth > 0 ? liveWidth + 8 : 0)
        if rightWidth > 0 { fixed += 8 + rightWidth }
        let available = max(0, right - x - fixed)
        let title = CanvasText.truncated(node.title, titleStyle, width: available)
        x += pen.text(title, titleStyle, x: x, centerY: midY)
        x += 8
        x += pen.text(meta, metaStyle, x: x, centerY: midY) + 8
        if node.live == true {
            let dot = CGRect(x: x, y: midY - 3, width: 6, height: 6)
            if p.layered { p.liveDot(dot, id: "live") } else { ctx.fillRounded(dot, 3, p.accent()) }
        }
        if let written = node.written, let items = rightItems {
            var rx = right - rightWidth
            pen.icon(.gitCommitHorizontal, x: rx, centerY: midY, size: 14, p.fg4)
            rx += 14 + 6
            pen.text(items.files, p.text(.sans(11, 400, tabular: true), p.fg4), x: rx, centerY: midY)
            rx += items.filesW + 6
            pen.counts(added: written.added, removed: written.removed, size: 10.5, x: rx, centerY: midY)
        }
    }
}
