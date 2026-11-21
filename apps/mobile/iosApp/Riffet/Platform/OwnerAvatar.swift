import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import RiffetKit

/// Centre-crops to a square and scales to 512 px before upload; the server does not resize.
enum OwnerAvatarEncoder {
    static let side = 512
    static let maximumBytes = 1024 * 1024

    static func encode(_ data: Data) throws -> (data: Data, type: String) {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else { throw OwnerAvatarError.unreadable }
        let shortEdge = min(width, height), longEdge = max(width, height)
        // Size the long edge so the short one lands on `side`; a smaller photo is never enlarged.
        let target = shortEdge <= side ? longEdge : Int((Double(longEdge) * Double(side) / Double(shortEdge)).rounded(.up))
        guard let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: target,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary) else { throw OwnerAvatarError.unreadable }
        let edge = min(scaled.width, scaled.height, side)
        let crop = CGRect(x: (scaled.width - edge) / 2, y: (scaled.height - edge) / 2, width: edge, height: edge)
        guard let square = scaled.cropping(to: crop) else { throw OwnerAvatarError.unreadable }
        let alpha = square.alphaInfo
        let hasAlpha = alpha == .first || alpha == .last || alpha == .premultipliedFirst || alpha == .premultipliedLast
        if hasAlpha, let png = write(square, as: .png, quality: 1) { return (png, "image/png") }
        for quality in [0.9, 0.8, 0.7, 0.55] {
            if let jpeg = write(flattened(square), as: .jpeg, quality: quality) { return (jpeg, "image/jpeg") }
        }
        throw OwnerAvatarError.unreadable
    }

    private static func write(_ image: CGImage, as type: UTType, quality: Double) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length <= maximumBytes else { return nil }
        return output as Data
    }

    /// JPEG has no alpha; transparency falls back to white rather than black.
    private static func flattened(_ image: CGImage) -> CGImage {
        let alpha = image.alphaInfo
        guard alpha == .first || alpha == .last || alpha == .premultipliedFirst || alpha == .premultipliedLast,
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(bounds)
        context.draw(image, in: bounds)
        return context.makeImage() ?? image
    }
}

enum OwnerAvatarError: LocalizedError {
    case unreadable
    var errorDescription: String? { String(localized: "无法处理这张图片", bundle: .riffet) }
}

/// The owner's avatar: the picture, else the name's first character, else a person glyph, on a neutral disc.
struct OwnerAvatarView: View {
    let workbench: Workbench
    let owner: OwnerInfo?
    let size: CGFloat
    /// A picture other than the owner's own, e.g. a generated-avatar preview.
    var url: URL?
    @Environment(\.palette) private var palette
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Circle().fill(palette.bgMuted)
            if let monogram = owner?.monogram {
                Text(monogram).font(.system(size: size * 0.42, weight: .medium)).foregroundStyle(palette.fg2)
            } else {
                Image(systemName: "person.fill").font(.system(size: size * 0.46)).foregroundStyle(palette.fg2)
            }
            if let image { Image(uiImage: image).resizable().scaledToFill().transition(.opacity) }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: url ?? workbench.ownerAvatarURL) {
            guard let url = url ?? workbench.ownerAvatarURL else { image = nil; return }
            if let cached = OwnerAvatarCache.shared.object(forKey: url.absoluteString as NSString) { image = cached; return }
            guard let data = try? await workbench.resources.data(for: url),
                  // Decoded here, at display size: `UIImage(data:)` defers the full-size decode to the first draw on the main thread.
                  let decoded = await Task.detached(priority: .userInitiated, operation: { ConversationImageDecoder.decode(data, maximumPixelSize: 300) }).value else { return }
            OwnerAvatarCache.shared.setObject(decoded, forKey: url.absoluteString as NSString)
            withAnimation(RiffetMotion.release) { image = decoded }
        }
    }
}

/// Avatar URLs are content-addressed, so a cached picture never goes stale.
private enum OwnerAvatarCache {
    static let shared: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>(); cache.countLimit = 8; return cache
    }()
}

/// The generated-avatar styles as a grid of previews; a tap sets that picture, 换一批 rerolls every seed.
struct RandomAvatarSheet: View {
    let workbench: Workbench
    let styles: [OwnerAvatarStyle]
    let onPick: (OwnerAvatarStyle, String, String, String) async -> Void
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var seeds: [String: String]

    init(workbench: Workbench, styles: [OwnerAvatarStyle], onPick: @escaping (OwnerAvatarStyle, String, String, String) async -> Void) {
        self.workbench = workbench; self.styles = styles; self.onPick = onPick
        _seeds = State(initialValue: Self.rolled(styles))
    }

    private var shown: [OwnerAvatarStyle] {
        let hasName = !(workbench.owner?.name ?? "").isEmpty
        return styles.filter { hasName || !$0.needsName }
    }
    private var colors: (ink: String, paper: String) {
        let values = scheme == .dark ? palette.values.dark : palette.values.light
        return (values.fg.hex, values.bg.hex)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 14) {
                    ForEach(shown, id: \.id) { style in
                        let seed = seeds[style.id] ?? ""
                        Button {
                            let colors = colors
                            Task { await onPick(style, seed, colors.ink, colors.paper) }
                            dismiss()
                        } label: {
                            VStack(spacing: 6) {
                                OwnerAvatarView(workbench: workbench, owner: nil, size: 56,
                                                url: workbench.ownerAvatarPreviewURL(style: style, seed: seed, ink: colors.ink, paper: colors.paper))
                                Text(Self.title(style)).riffetFont(.caption).foregroundStyle(palette.fg2).lineLimit(1)
                            }.frame(maxWidth: .infinity).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }.padding()
            }
            .background(palette.bgSidebar)
            .navigationTitle(String(localized: "随机头像", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("换一批") { seeds = Self.rolled(styles) } }
            }
        }.presentationDetents([.medium, .large])
    }

    /// One seed per style, kept until the next shuffle so a tile and its tap agree.
    private static func rolled(_ styles: [OwnerAvatarStyle]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: styles.map { ($0.id, String(UInt64.random(in: 0...UInt64.max), radix: 36)) })
    }

    /// The reader's language, else Simplified Chinese, else English, else whatever the plugin gave.
    private static func title(_ style: OwnerAvatarStyle) -> String {
        let titles = style.title
        for tag in Locale.preferredLanguages {
            if let exact = titles.first(where: { $0.key.caseInsensitiveCompare(tag) == .orderedSame }) { return exact.value }
            let language = tag.split(separator: "-").first.map { $0.lowercased() }
            if let same = titles.sorted(by: { $0.key < $1.key }).first(where: { $0.key.split(separator: "-").first.map { $0.lowercased() } == language }) { return same.value }
        }
        return titles["zh-Hans"] ?? titles["en"] ?? titles.sorted(by: { $0.key < $1.key }).first?.value ?? style.id.split(separator: "/").last.map(String.init) ?? style.id
    }
}
