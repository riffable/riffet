import AppKit
import QuickLookUI
import SwiftUI
import UniformTypeIdentifiers
import RiffetKit

/// Where a transcript image comes from. Server URLs carry the device token, so they go through
/// [ImageLoader] rather than `AsyncImage`.
enum TimelineImageSource: Hashable {
    case attachment(String)
    case projectFile(projectId: String, path: String)
    /// A Markdown or tool `src`: a data URL, an absolute URL, or a path inside the open project.
    case url(String)
    /// Bytes still on this Mac: a composer attachment before its upload finishes. Only the viewer
    /// reads it (full image, save, open in Preview).
    case local(Data)
}

/// Transcript images: the bytes are fetched once (with the device token for server URLs), decoded
/// off the main thread into a display copy no larger than the screen needs, and shared by every
/// row that shows the same image. The original stays available for the viewer and for saving.
@MainActor
final class ImageLoader {
    static let shared = ImageLoader()
    private let display = NSCache<NSString, NSImage>()
    private let originals = NSCache<NSString, NSData>()
    private var inflight: [String: Task<NSImage?, Never>] = [:]

    /// Long edge of the copy a transcript row draws; the viewer decodes the original.
    private static let displayEdge: CGFloat = 1600

    private init() {
        display.totalCostLimit = 192 * 1024 * 1024
        originals.totalCostLimit = 256 * 1024 * 1024
    }

    private var base: String? { AppModel.shared.host.api?.baseUrl }

    /// The display copy, if this image was loaded before; lets a row draw on its first frame.
    func cached(for source: TimelineImageSource, projectId: String?) -> NSImage? {
        guard let key = request(for: source, projectId: projectId)?.url?.absoluteString else { return nil }
        return display.object(forKey: key as NSString)
    }

    func image(for source: TimelineImageSource, projectId: String?) async -> NSImage? {
        let sizeKey = ImageSizes.key(source, projectId: projectId)
        if case let .attachment(id) = source {
            if TranscriptAttachments.metadata(id) == nil,
               let api = AppModel.shared.host.api,
               let metadata = try? await api.attachmentMetadata(attachmentId: id) {
                TranscriptAttachments.store(id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size)
            }
            if let metadata = TranscriptAttachments.metadata(id), !metadata.mimeType.hasPrefix("image/") {
                ImageSizes.fail(sizeKey)
                return nil
            }
        }
        guard let request = request(for: source, projectId: projectId), let key = request.url?.absoluteString else {
            ImageSizes.fail(sizeKey)
            return nil
        }
        if let hit = display.object(forKey: key as NSString) {
            ImageSizes.store(sizeKey, hit.size)
            return hit
        }
        if let running = inflight[key] { return await running.value }
        let task = Task<NSImage?, Never> {
            guard let data = await self.bytes(request, key: key) else { return nil }
            let edge = Self.displayEdge
            let image = await Task.detached(priority: .userInitiated) { Self.decode(data, maxEdge: edge) }.value
            if let image { self.display.setObject(image, forKey: key as NSString, cost: Self.cost(image)) }
            return image
        }
        inflight[key] = task
        let image = await task.value
        inflight[key] = nil
        if let image { ImageSizes.store(sizeKey, image.size) } else { ImageSizes.fail(sizeKey) }
        return image
    }

    /// The full-resolution image, for the viewer.
    func original(for source: TimelineImageSource, projectId: String?) async -> NSImage? {
        guard let data = await originalBytes(for: source, projectId: projectId) else { return nil }
        return await Task.detached(priority: .userInitiated) { NSImage(data: data) }.value
    }

    /// The original bytes in a temporary file with the right extension, for saving and opening.
    func file(for source: TimelineImageSource, projectId: String?, name: String) async -> URL? {
        guard let data = await originalBytes(for: source, projectId: projectId) else { return nil }
        return await Task.detached(priority: .userInitiated) {
            let files = FileManager.default
            // A private directory per export prevents same-name images from replacing one another.
            let directory = files.temporaryDirectory.appendingPathComponent("riffet-image-\(UUID().uuidString)", isDirectory: true)
            do {
                try files.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                var safe = (name as NSString).lastPathComponent
                if safe.isEmpty || safe == "." || safe == ".." { safe = "image" }
                if (safe as NSString).pathExtension.isEmpty, let source = CGImageSourceCreateWithData(data as CFData, nil),
                   let type = CGImageSourceGetType(source).flatMap({ UTType($0 as String) }), let ext = type.preferredFilenameExtension {
                    safe += ".\(ext)"
                }
                let url = directory.appendingPathComponent(safe)
                try data.write(to: url, options: .atomic)
                try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
                return url
            } catch {
                try? files.removeItem(at: directory)
                return nil
            }
        }.value
    }

    private func originalBytes(for source: TimelineImageSource, projectId: String?) async -> Data? {
        if case let .local(data) = source { return data }
        guard let request = request(for: source, projectId: projectId), let key = request.url?.absoluteString else { return nil }
        return await bytes(request, key: key)
    }

    private func bytes(_ request: URLRequest, key: String) async -> Data? {
        if let hit = originals.object(forKey: key as NSString) { return hit as Data }
        let data: Data?
        if let url = request.url, url.scheme == "data" {
            data = Self.decodeDataURL(url.absoluteString)
        } else if let (body, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 {
            data = body
        } else {
            data = nil
        }
        if let data { originals.setObject(data as NSData, forKey: key as NSString, cost: data.count) }
        return data
    }

    nonisolated private static func decode(_ data: Data, maxEdge: CGFloat) -> NSImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return NSImage(data: data) }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return NSImage(data: data) }
        // Points, not pixels: a 2x screenshot keeps its on-screen size.
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let dpi = (properties?[kCGImagePropertyDPIWidth] as? Double) ?? 72
        let scale = dpi > 100 ? 2.0 : 1.0
        let fullWidth = (properties?[kCGImagePropertyPixelWidth] as? Double) ?? Double(cgImage.width)
        let fullHeight = (properties?[kCGImagePropertyPixelHeight] as? Double) ?? Double(cgImage.height)
        return NSImage(cgImage: cgImage, size: NSSize(width: fullWidth / scale, height: fullHeight / scale))
    }

    private static func cost(_ image: NSImage) -> Int {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return 1 }
        return cg.bytesPerRow * cg.height
    }

    private func request(for source: TimelineImageSource, projectId: String?) -> URLRequest? {
        guard let base else { return nil }
        let url: URL?
        switch source {
        case let .attachment(id):
            url = URL(string: "\(base)/api/attachments/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")
        case let .projectFile(project, path):
            url = Self.projectImageURL(base: base, projectId: project, path: path)
        case let .url(raw):
            if raw.hasPrefix("data:") {
                url = URL(string: raw)
            } else if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
                url = URL(string: raw)
            } else if let projectId {
                let path = raw.hasPrefix("file://") ? (URL(string: raw)?.path ?? raw) : raw
                url = Self.projectImageURL(base: base, projectId: projectId, path: path)
            } else {
                url = nil
            }
        case .local:
            url = nil
        }
        guard let url else { return nil }
        return ProjectDownloads.authorized(url)
    }

    private static func projectImageURL(base: String, projectId: String, path: String) -> URL? {
        var components = URLComponents(string: "\(base)/api/projects/\(projectId)/file/image")
        components?.queryItems = [URLQueryItem(name: "path", value: path)]
        return components?.url
    }

    private static func decodeDataURL(_ value: String) -> Data? {
        guard let comma = value.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(value[value.index(after: comma)...]))
    }
}

struct TimelineImageView: View {
    let source: TimelineImageSource
    let label: String
    var maxHeight: CGFloat = 360
    var projectId: String?
    @Environment(\.palette) private var palette
    @Environment(\.conversationProjectId) private var conversationProjectId
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: NSImage?
    /// What [image] was loaded for; while another source loads, the previous picture stays up.
    @State private var imageSource: TimelineImageSource?
    @State private var failed = false
    @State private var imageAnchor = ImageViewer.Anchor()
    @State private var previewHidden = false

    private var project: String? { projectId ?? conversationProjectId }

    /// The current source's picture, or the previous one until the current one is decoded.
    private var shown: NSImage? {
        if imageSource == source { return image ?? ImageLoader.shared.cached(for: source, projectId: project) }
        return ImageLoader.shared.cached(for: source, projectId: project) ?? image
    }

    var body: some View {
        ZStack {
            if let image = shown {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: fittedWidth(image.size))
                    .fixedSize(horizontal: false, vertical: true)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.control))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(palette.line, lineWidth: 1))
                    .background(ImageViewerAnchorView(anchor: imageAnchor).id(source).allowsHitTesting(false))
                    .opacity(previewHidden ? 0 : 1)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        ImageViewer.shared.show(image: image, source: source, projectId: project, label: label,
                            origin: imageAnchor.origin(visibility: { previewHidden = !$0 }))
                    }
                    .draggable(Image(nsImage: image))
                    .help(label)
                    .id(ObjectIdentifier(image))
                    .transition(.opacity)
            } else if failed && imageSource == source {
                Label(label, icon: "photo").font(RiffetFont.caption).foregroundStyle(palette.fg3)
            } else {
                RoundedRectangle(cornerRadius: Radius.control).fill(palette.bgSubtle)
                    .frame(width: 180, height: 110)
                    .shimmering()
            }
        }
        .task(id: source) {
            if imageSource == source, image != nil { return }
            let loaded = await ImageLoader.shared.image(for: source, projectId: project)
            guard !Task.isCancelled else { return }
            let changes = imageSource != nil && imageSource != source
            withAnimation(changes && !reduceMotion ? Motion.standard : nil) {
                image = loaded
                imageSource = source
                failed = loaded == nil
            }
        }
    }

    /// The width at which the image fits 720pt across and [maxHeight] down, never enlarged.
    private func fittedWidth(_ size: NSSize) -> CGFloat {
        guard size.width > 0, size.height > 0 else { return 0 }
        return min(size.width, 720, size.width * maxHeight / size.height)
    }
}

private struct ConversationProjectKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    /// The open conversation's project: relative image paths in its answers resolve against it.
    var conversationProjectId: String? {
        get { self[ConversationProjectKey.self] }
        set { self[ConversationProjectKey.self] = newValue }
    }
}
