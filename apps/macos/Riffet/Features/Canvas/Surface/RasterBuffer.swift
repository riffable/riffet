import AppKit
import IOSurface

/// One rendered bitmap, ready to be a layer's `contents`.
///
/// IOSurface-backed by default: Core Animation shares the pages with the render server, whereas a `CGImage` is copied
/// into the server's own backing store at commit, so every live bitmap would cost twice. Measured in the bench harness
/// (`tmp/canvas-probe/surface-test`, `--cgimage` flips this) it is what brings `--repeat 3` under budget.
struct RasterBuffer {
    let contents: AnyObject
    let bytes: Int

    static var useIOSurface = true
    private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private static let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

    /// Thread-safe. `region` is in item-local points; the bitmap is `pixelWidth` x `pixelHeight` at `scale` pixels per point.
    static func render(item: SurfaceItem, region: CGRect, pixelWidth: Int, pixelHeight: Int, scale: CGFloat, zoom: CGFloat, renderer: SurfaceRenderer) -> RasterBuffer? {
        guard pixelWidth > 0, pixelHeight > 0 else { return nil }
        var surface: IOSurfaceRef?
        let ctx: CGContext?
        var bytes = pixelWidth * pixelHeight * 4
        if useIOSurface {
            let bpr = IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, pixelWidth * 4)
            let props: [CFString: Any] = [
                kIOSurfaceWidth: pixelWidth, kIOSurfaceHeight: pixelHeight, kIOSurfaceBytesPerElement: 4,
                kIOSurfaceBytesPerRow: bpr, kIOSurfacePixelFormat: 0x42475241 as UInt32,
                kIOSurfaceAllocSize: IOSurfaceAlignProperty(kIOSurfaceAllocSize, bpr * pixelHeight),
            ]
            guard let s = IOSurfaceCreate(props as CFDictionary) else { return nil }
            IOSurfaceSetValue(s, kIOSurfaceColorSpace, colorSpace.copyPropertyList() ?? NSNull())
            IOSurfaceLock(s, [], nil)
            ctx = CGContext(data: IOSurfaceGetBaseAddress(s), width: pixelWidth, height: pixelHeight, bitsPerComponent: 8, bytesPerRow: IOSurfaceGetBytesPerRow(s), space: colorSpace, bitmapInfo: bitmapInfo)
            surface = s
            bytes = IOSurfaceGetAllocSize(s)
        } else {
            ctx = CGContext(data: nil, width: pixelWidth, height: pixelHeight, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace, bitmapInfo: bitmapInfo)
        }
        defer { if let s = surface { IOSurfaceUnlock(s, [], nil) } }
        guard let ctx else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(pixelHeight))
        ctx.scaleBy(x: scale, y: -scale)
        ctx.translateBy(x: -region.minX, y: -region.minY)
        ctx.setAllowsFontSmoothing(false)
        renderer.draw(item, region: region, in: ctx, scale: scale, zoom: zoom)
        if let s = surface { return RasterBuffer(contents: s, bytes: bytes) }
        guard let image = ctx.makeImage() else { return nil }
        return RasterBuffer(contents: image, bytes: image.bytesPerRow * image.height)
    }
}
