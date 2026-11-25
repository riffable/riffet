import Foundation
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ImportedAttachment: Identifiable, Sendable {
    let id: UUID
    let url: URL
    let name: String
    let mimeType: String
    let byteCount: Int
    let width: Int?
    let height: Int?

    func data() throws -> Data { try Data(contentsOf: url, options: .mappedIfSafe) }
    /// Called off the main actor before a draft persists its URL. Source picker files are
    /// already imported into our cache, so their security/provider lifetime has ended.
    func durableCopy() throws -> ImportedAttachment {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("DraftAttachments/\(id.uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(name)
        do { try FileManager.default.copyItem(at: url, to: destination) }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
        removeLocalCopy()
        return ImportedAttachment(id: id, url: destination, name: name, mimeType: mimeType, byteCount: byteCount, width: width, height: height)
    }
    func removeLocalCopy() { try? FileManager.default.removeItem(at: url) }
}

enum AttachmentImportError: LocalizedError {
    case notAFile, tooLarge, unreadableImage, unavailable
    var errorDescription: String? {
        switch self {
        case .notAFile: String(localized: "请选择文件，文件夹不能作为附件发送。", bundle: .riffet)
        case .tooLarge: String(localized: "附件超过 24 MiB，请选择较小的文件。", bundle: .riffet)
        case .unreadableImage: String(localized: "无法处理这张图片，请重新选择或通过文件发送。", bundle: .riffet)
        case .unavailable: String(localized: "无法读取选中的附件，请重新选择。", bundle: .riffet)
        }
    }
}

/// Mirrors the shared upload contract: <=24 MiB, images downsampled to a 2048 px long edge.
/// Files live in Caches until the composer uploads/removes them. Persist draft references only
/// after copying into the application's durable draft storage; Caches may be reclaimed by iOS.
enum AttachmentImporter {
    static let maximumBytes = 24 * 1024 * 1024
    static let maximumImageEdge = 2048

    static func importImage(_ data: Data) throws -> ImportedAttachment {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try data.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        return try importFile(source, preferredName: "paste.png")
    }

    static func importFile(_ source: URL, preferredName: String? = nil) throws -> ImportedAttachment {
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
        guard values.isRegularFile == true else { throw AttachmentImportError.notAFile }
        let type = values.contentType ?? UTType(filenameExtension: source.pathExtension) ?? .data
        let id = UUID()
        let leaf = URL(fileURLWithPath: preferredName ?? source.lastPathComponent).lastPathComponent
        let name = leaf.isEmpty || leaf == "." || leaf == ".." ? "attachment" : leaf
        let directory = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appending(path: "ImportedAttachments", directoryHint: .isDirectory)
            .appending(path: id.uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            if type.conforms(to: .image), let imageSource = CGImageSourceCreateWithURL(source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
               let image = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumImageEdge,
                kCGImageSourceShouldCacheImmediately: true,
               ] as CFDictionary) {
                let alpha = image.alphaInfo
                let hasAlpha = alpha == .first || alpha == .last || alpha == .premultipliedFirst || alpha == .premultipliedLast
                let outputType: UTType = hasAlpha ? .png : .jpeg
                let outputName = URL(fileURLWithPath: name).deletingPathExtension().lastPathComponent + (hasAlpha ? ".png" : ".jpg")
                let output = directory.appending(path: outputName)
                guard let destination = CGImageDestinationCreateWithURL(output as CFURL, outputType.identifier as CFString, 1, nil) else { throw AttachmentImportError.unreadableImage }
                CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
                guard CGImageDestinationFinalize(destination) else { throw AttachmentImportError.unreadableImage }
                let bytes = try output.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard bytes <= maximumBytes else { throw AttachmentImportError.tooLarge }
                return ImportedAttachment(id: id, url: output, name: outputName, mimeType: outputType.preferredMIMEType ?? "image/jpeg", byteCount: bytes, width: image.width, height: image.height)
            }
            guard (values.fileSize ?? maximumBytes + 1) <= maximumBytes else { throw AttachmentImportError.tooLarge }
            let output = directory.appending(path: name.isEmpty ? "attachment" : name)
            try FileManager.default.copyItem(at: source, to: output)
            // Check the copied bytes as well: external providers can change while a file is copied.
            let bytes = try output.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard bytes <= maximumBytes else { throw AttachmentImportError.tooLarge }
            return ImportedAttachment(id: id, url: output, name: output.lastPathComponent, mimeType: type.preferredMIMEType ?? "application/octet-stream", byteCount: bytes, width: nil, height: nil)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }
}

struct DocumentAttachmentPicker: UIViewControllerRepresentable {
    var onPicked: @MainActor (Result<[ImportedAttachment], Error>) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let controller = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        controller.allowsMultipleSelection = true
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    @MainActor final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPicked: @MainActor (Result<[ImportedAttachment], Error>) -> Void
        init(onPicked: @escaping @MainActor (Result<[ImportedAttachment], Error>) -> Void) { self.onPicked = onPicked }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onPicked(.success([])) }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            let callback = onPicked
            Task {
                let result = await Task.detached(priority: .userInitiated) { () -> Result<[ImportedAttachment], Error> in
                    var imported: [ImportedAttachment] = []
                    do {
                        for url in urls { imported.append(try AttachmentImporter.importFile(url)) }
                        return .success(imported)
                    } catch {
                        imported.forEach { $0.removeLocalCopy() }
                        return .failure(error)
                    }
                }.value
                callback(result)
            }
        }
    }
}

/// PHPicker exposes only the selected photos and videos and does not request full photo-library access.
/// Photos are downsampled like any image; videos (screen recordings) go up as files, under the same limit.
struct PhotoAttachmentPicker: UIViewControllerRepresentable {
    var onPicked: @MainActor (Result<[ImportedAttachment], Error>) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked) }
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .any(of: [.images, .videos])
        configuration.selectionLimit = 10
        let controller = PHPickerViewController(configuration: configuration)
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    @MainActor final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPicked: @MainActor (Result<[ImportedAttachment], Error>) -> Void
        init(onPicked: @escaping @MainActor (Result<[ImportedAttachment], Error>) -> Void) { self.onPicked = onPicked }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            Task {
                var attachments: [ImportedAttachment] = []
                do {
                    for result in results {
                        let provider = result.itemProvider
                        let types = provider.registeredTypeIdentifiers
                        guard let identifier = types.first(where: { UTType($0)?.conforms(to: .image) == true })
                                ?? types.first(where: { UTType($0)?.conforms(to: .movie) == true }) else { throw AttachmentImportError.unavailable }
                        let suggested = provider.suggestedName
                        let attachment: ImportedAttachment = try await withCheckedThrowingContinuation { continuation in
                            provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                                if let error { continuation.resume(throwing: error); return }
                                guard let url else { continuation.resume(throwing: AttachmentImportError.unavailable); return }
                                // The library's name without the temporary file's; the extension comes from the file.
                                let name = suggested.map { URL(fileURLWithPath: $0).pathExtension.isEmpty && !url.pathExtension.isEmpty ? $0 + "." + url.pathExtension : $0 }
                                // The provider URL is valid only during this callback. Import before returning.
                                do { continuation.resume(returning: try AttachmentImporter.importFile(url, preferredName: name)) }
                                catch { continuation.resume(throwing: error) }
                            }
                        }
                        attachments.append(attachment)
                    }
                    onPicked(.success(attachments))
                } catch {
                    attachments.forEach { $0.removeLocalCopy() }
                    onPicked(.failure(error))
                }
            }
        }
    }
}

extension AttachmentImporter {
    /// Copies what was dropped while each provider's file is still readable. Text and links are
    /// left to the text field they were dropped on.
    static func importDropped(_ providers: [NSItemProvider]) async -> Result<[ImportedAttachment], Error> {
        var files: [ImportedAttachment] = []
        do {
            for provider in providers {
                let types = provider.registeredContentTypes
                guard let type = types.first(where: { $0.conforms(to: .image) }) ?? types.first(where: { $0.conforms(to: .data) && !$0.conforms(to: .text) && !$0.conforms(to: .url) })
                else { continue }
                let name = provider.suggestedName
                files.append(try await withCheckedThrowingContinuation { continuation in
                    _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, error in
                        guard let url else { continuation.resume(throwing: error ?? AttachmentImportError.notAFile); return }
                        let named = name.map { $0 + (URL(fileURLWithPath: $0).pathExtension.isEmpty && !url.pathExtension.isEmpty ? "." + url.pathExtension : "") }
                        continuation.resume(with: Result { try importFile(url, preferredName: named) })
                    }
                })
            }
            return .success(files)
        } catch {
            files.forEach { $0.removeLocalCopy() }
            return .failure(error)
        }
    }
}

extension View {
    /// Files and images dragged in from another app on iPad or an unfolded Duo, under the composer's own limits.
    func attachmentDrop(enabled: Bool = true, _ onPicked: @escaping (Result<[ImportedAttachment], Error>) -> Void) -> some View {
        onDrop(of: [.image, .data], isTargeted: nil) { providers in
            guard enabled else { return false }
            Task { @MainActor in
                let result = await AttachmentImporter.importDropped(providers)
                if case let .success(files) = result, files.isEmpty { return }
                onPicked(result)
            }
            return true
        }
    }
}
