import CoreGraphics
import Foundation

/// The whole canvas drawn straight into a context at a camera: plane, dots, ground, edges, cards, next slot, track labels.
/// What a surface of layers assembles from the same painters; used for snapshots and for checking the surface against.
enum CanvasScenePainter {
    struct Camera { var x: CGFloat, y: CGFloat, k: CGFloat }

    /// [ctx] is y-down in screen points (scale it for the display before calling). [now] is unused by the painters (the layout holds
    /// the elapsed strings); the camera and [size] are those of the plane.
    static func draw(in ctx: CGContext, layout: CanvasLayout, paint base: CanvasPaint, camera: Camera, size: CGSize, ground: CanvasGround? = nil) {
        let p = base.with(zoom: camera.k)
        ctx.saveGState()
        ctx.setFillColor(p.subtle())
        ctx.fill(CGRect(origin: .zero, size: size))
        CanvasGroundPainter.drawDots(in: ctx, paint: p, camera: (camera.x, camera.y, camera.k), size: size)
        let ground = ground ?? CanvasGroundBuilder.make(layout: layout, paint: p)
        ctx.translateBy(x: camera.x, y: camera.y)
        ctx.scaleBy(x: camera.k, y: camera.k)
        let view = CGRect(x: -camera.x / camera.k, y: -camera.y / camera.k, width: size.width / camera.k, height: size.height / camera.k).insetBy(dx: -60, dy: -60)
        CanvasGroundPainter.draw(ground, in: ctx, paint: p, visible: view)
        for node in layout.nodes where CGRect(x: node.x, y: node.y, width: node.w, height: node.h).insetBy(dx: -50, dy: -50).intersects(view) {
            ctx.saveGState()
            ctx.translateBy(x: node.x, y: node.y)
            CanvasNodePainter.draw(node, in: ctx, layout: layout, paint: p)
            ctx.restoreGState()
        }
        if !p.far, let next = ground.next, next.rect.insetBy(dx: -4, dy: -4).intersects(view) {
            ctx.saveGState()
            ctx.translateBy(x: next.rect.minX, y: next.rect.minY)
            CanvasDecorationPainter.draw(next, in: ctx, paint: p)
            ctx.restoreGState()
        }
        ctx.restoreGState()
        if !p.far {
            for label in CanvasGroundBuilder.trackLabels(layout: layout, camera: (camera.x, camera.y, camera.k), size: size, paint: p) {
                ctx.saveGState()
                ctx.translateBy(x: label.rect.minX, y: label.rect.minY)
                CanvasDecorationPainter.draw(label, in: ctx, paint: p)
                ctx.restoreGState()
            }
        }
    }
}
