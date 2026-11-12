import AppKit

/// Input mirrors the web canvas: two-finger scroll pans (the OS supplies the momentum events and they pass straight
/// through), ⌘/⌃-scroll and pinch zoom about the cursor with the same easing, dragging pans once it travels 4 points
/// so that a press that moved is never also a click.
extension CanvasSurfaceView {
    private func point(_ e: NSEvent) -> CGPoint {
        let p = convert(e.locationInWindow, from: nil)
        return CGPoint(x: p.x, y: bounds.height - p.y)
    }

    override func scrollWheel(with e: NSEvent) {
        let p = point(e)
        setPointer(p)
        let precise = e.hasPreciseScrollingDeltas
        if e.momentumPhase.isEmpty || e.phase.contains(.began) { userMoved() }
        if !e.modifierFlags.intersection([.command, .control]).isEmpty {
            // AppKit's delta is the browser's negated. One event moves the zoom by at most ×1.25.
            let delta = e.scrollingDeltaY * (precise ? 1 : 16)
            zoomEased(by: min(1.25, max(0.8, exp(delta * 0.0045))), at: p)
        } else {
            let s: CGFloat = precise ? 1 : 10
            panBy(dx: e.scrollingDeltaX * s, dy: e.scrollingDeltaY * s)
        }
    }

    override func magnify(with e: NSEvent) {
        if e.phase.contains(.began) { userMoved() }
        zoomEased(by: max(0.5, 1 + e.magnification), at: point(e))
    }

    override func smartMagnify(with e: NSEvent) { toggleSmartFit() }

    override func mouseDown(with e: NSEvent) {
        beginDrag(at: point(e))
    }

    override func mouseDragged(with e: NSEvent) {
        let p = point(e)
        setPointer(p)
        continueDrag(to: p)
    }

    override func mouseUp(with e: NSEvent) {
        if !endDrag() { clickAt(point(e), count: e.clickCount) }
    }

    override func mouseMoved(with e: NSEvent) {
        setPointer(point(e))
        updateHover()
    }

    override func mouseExited(with e: NSEvent) { setPointer(nil) }
}
