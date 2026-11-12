import AppKit

/// The canvas's AppKit side: the dotted ground, the surface, and (as siblings above it, since a layer-hosting view takes no
/// subviews) every overlay that follows the camera. Flipped, so overlays are placed in the surface's own y-down camera space.
final class CanvasContainerView: NSView {
    let surface = CanvasSurfaceView()
    private let dots = DotsView()
    /// Escape reached the plane: returns whether something took it.
    var onEscape: (() -> Bool)?
    var onResize: ((CGSize) -> Void)?
    private var lastSize = CGSize.zero

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        addSubview(dots)
        addSubview(surface)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The plane's colour and the ink of the dots on it (`radial-gradient(fg 9.85%, ...)`: the colour at full strength here).
    func setGround(background: NSColor, ink: NSColor) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = background.cgColor
            dots.ink = ink.cgColor
        }
    }

    func cameraChanged(_ camera: SurfaceCamera) { dots.update(camera) }

    override func layout() {
        super.layout()
        dots.frame = bounds
        surface.frame = bounds
        if bounds.size != lastSize {
            lastSize = bounds.size
            dots.update(surface.camera)
            onResize?(bounds.size)
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53, onEscape?() == true { return }
        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) { _ = onEscape?() }

    /// The dotted ground: one layer whose background is the tile of the grid (a dot every `22 * k`, four times that below half zoom),
    /// as wide as the plane plus a tile. A camera move only moves the layer, to whole device pixels as the browser does; the tile is
    /// drawn again only when the zoom changes its size in device pixels.
    private final class DotsView: NSView {
        private let tiles = CALayer()
        var ink: CGColor? { didSet { drawn = 0; update(last) } }
        private var drawn = 0
        private var last = SurfaceCamera(x: 0, y: 0, k: 1)

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            layer?.addSublayer(tiles)
            tiles.anchorPoint = .zero
            tiles.actions = ["position": NSNull(), "bounds": NSNull(), "backgroundColor": NSNull(), "hidden": NSNull()]
        }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func update(_ camera: SurfaceCamera) {
            last = camera
            let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
            let tile = 22 * camera.k * (camera.k < 0.5 ? 4 : 1)
            guard tile >= 7, bounds.width > 0, let ink else { tiles.isHidden = true; return }
            let dev = max(1, Int((tile * scale).rounded()))
            if dev != drawn, let image = CanvasGroundPainter.dotTile(ink: ink, tileDev: dev, scale: scale) {
                drawn = dev
                let size = NSSize(width: CGFloat(dev) / scale, height: CGFloat(dev) / scale)
                let ns = NSImage(cgImage: image, size: size)
                tiles.backgroundColor = NSColor(patternImage: ns).cgColor
            }
            tiles.isHidden = false
            // The grid's own offset in device pixels, in [-tile, 0] as the web's `translate3d` is.
            func offset(_ v: CGFloat) -> CGFloat {
                let css = (v.truncatingRemainder(dividingBy: tile) + tile).truncatingRemainder(dividingBy: tile) - tile
                return (css * scale).rounded() / scale
            }
            let t = CGFloat(dev) / scale
            let rows = (bounds.height / t).rounded(.up) + 1, cols = (bounds.width / t).rounded(.up) + 1
            let height = rows * t, width = cols * t
            // The layer is y up with its tile grid from its bottom edge, so its height is a whole number of tiles.
            tiles.bounds = CGRect(x: 0, y: 0, width: width, height: height)
            tiles.position = CGPoint(x: offset(camera.x), y: -offset(camera.y) - t - (height - bounds.height - t))
        }
    }
}
