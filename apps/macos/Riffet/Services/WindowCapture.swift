import AppKit
import ScreenCaptureKit
import RiffetKit

/// Lists and captures other windows for the `window.capture` device capability. Capturing goes
/// through a window-only filter, so nothing is activated, raised or moved.
enum WindowCapture {
    struct Failure: Error { let message: String }

    struct Encoded {
        let data: Data
        let mimeType: String
        let width: Int
        let height: Int
    }

    /// Whether Screen Recording is granted; asking is `MacDeviceService.requestScreenCapture()`.
    static var hasAccess: Bool { CGPreflightScreenCaptureAccess() }

    /// Windows smaller than this on either side are controls and shadows, not something to look at.
    private static let minimumEdge: CGFloat = 40

    /// Encodings tried in turn when the server refuses an upload as too large: full-size PNG first,
    /// then JPEG at full, half and quarter size.
    private static let ladder: [(png: Bool, scale: CGFloat)] = [(true, 1), (false, 1), (false, 0.5), (false, 0.25)]

    static func list() async throws -> [MacWindow] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        return content.windows.compactMap { window in
            guard window.windowLayer == 0, let app = window.owningApplication,
                  window.frame.width >= minimumEdge, window.frame.height >= minimumEdge else { return nil }
            return MacWindow(
                id: Int64(window.windowID),
                app: app.applicationName,
                title: window.title ?? "",
                width: Int32(window.frame.width.rounded()),
                height: Int32(window.frame.height.rounded()),
                onScreen: window.isOnScreen
            )
        }
    }

    /// The window as an image at its pixel size, encoded per [attempt]; nil once the ladder is used up.
    static func capture(windowId: UInt32, attempt: Int) async throws -> Encoded? {
        guard ladder.indices.contains(attempt) else { return nil }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
            throw Failure(message: "No window has this id")
        }
        try Task.checkCancellation()
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = max(1, Int((filter.contentRect.width * scale).rounded()))
        configuration.height = max(1, Int((filter.contentRect.height * scale).rounded()))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        try Task.checkCancellation()
        let step = ladder[attempt]
        guard let encoded = encode(image, png: step.png, scale: step.scale) else {
            throw Failure(message: "The window image could not be encoded")
        }
        return encoded
    }

    private static func encode(_ image: CGImage, png: Bool, scale: CGFloat) -> Encoded? {
        var output = image
        if scale < 1 {
            let width = max(1, Int((CGFloat(image.width) * scale).rounded()))
            let height = max(1, Int((CGFloat(image.height) * scale).rounded()))
            guard let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return nil }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            guard let scaled = context.makeImage() else { return nil }
            output = scaled
        }
        let representation = NSBitmapImageRep(cgImage: output)
        let data = png
            ? representation.representation(using: .png, properties: [:])
            : representation.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
        guard let data else { return nil }
        return Encoded(data: data, mimeType: png ? "image/png" : "image/jpeg", width: output.width, height: output.height)
    }
}
