import SwiftUI
import UIKit
import RiffetKit

/// Sizes that transcript content only learns after it loads or renders — images, formulas,
/// scrollable tool output. A row that scrolls back in (its cell, and so its view state, was
/// reused meanwhile) starts at the size it settled to, so heights do not change mid-scroll.
@MainActor
final class ConversationLayoutMemo {
    static let shared = ConversationLayoutMemo()

    /// How an image reserves its space. Decided once per image for this launch.
    enum ImageShape: Equatable {
        /// Width over height, known before loading: the frame is exact from the first frame.
        case aspect(CGFloat)
        /// Unknown until loaded: a fixed box the picture is fitted into once it arrives.
        case box
    }

    private static let aspectsKey = "riffet.ios.conversation.imageAspects"
    private static let aspectLimit = 2_000
    private var heights: [String: CGFloat] = [:]
    private var shapes: [String: ImageShape] = [:]
    private var attachmentMetadata: [String: Attachment] = [:]
    /// Aspects persisted by earlier launches. Aspects learned in this launch are saved for the
    /// next one but not used now: an image already shown boxed stays boxed until relaunch.
    private let savedAspects: [String: Double]
    private var learnedAspects: [String: Double]
    private var saveScheduled = false
    private let images: NSCache<NSString, UIImage> = CacheRegistry.cache("conversation.images", bytes: CacheRegistry.Budget.images)

    private init() {
        let stored = AppStateDefaults.object(forKey: Self.aspectsKey) as? [String: Double] ?? [:]
        savedAspects = stored
        learnedAspects = stored
    }

    /// Server metadata of an attachment the timeline knows only by id, kept for this launch.
    func metadata(attachment id: String) -> Attachment? { attachmentMetadata[id] }
    func setMetadata(_ metadata: Attachment, attachment id: String) {
        if attachmentMetadata.count > 1_024 { attachmentMetadata.removeAll(keepingCapacity: true) }
        attachmentMetadata[id] = metadata
    }

    func height(_ key: String) -> CGFloat? { heights[key] }
    func setHeight(_ height: CGFloat, for key: String) {
        guard height > 0 else { return }
        if heights.count > 4_096 { heights.removeAll(keepingCapacity: true) }
        heights[key] = height
    }

    func imageShape(_ key: String, pixelSize: CGSize?) -> ImageShape {
        if let decided = shapes[key] { return decided }
        let shape: ImageShape
        if let pixelSize, pixelSize.width > 0, pixelSize.height > 0 { shape = .aspect(pixelSize.width / pixelSize.height) }
        else if let aspect = savedAspects[key], aspect > 0 { shape = .aspect(aspect) }
        else { shape = .box }
        if shapes.count > 4_096 { shapes.removeAll(keepingCapacity: true) }
        shapes[key] = shape
        return shape
    }

    func image(_ key: String) -> UIImage? { images.object(forKey: key as NSString) }
    func store(_ image: UIImage, for key: String) {
        let pixels = image.size.width * image.size.height * image.scale * image.scale
        images.setObject(image, forKey: key as NSString, cost: Int(pixels * 4))
        guard image.size.width > 0, image.size.height > 0 else { return }
        let aspect = Double(image.size.width / image.size.height)
        guard learnedAspects[key].map({ abs($0 - aspect) > 0.001 }) ?? true else { return }
        if learnedAspects.count >= Self.aspectLimit { learnedAspects.removeAll(keepingCapacity: true) }
        learnedAspects[key] = aspect
        scheduleSave()
    }

    private func scheduleSave() {
        guard !saveScheduled else { return }
        saveScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.saveScheduled = false
            AppStateDefaults.store.set(self.learnedAspects, forKey: Self.aspectsKey)
        }
    }

    /// A stable key for an image source; inline `data:` sources are hashed rather than stored.
    static func imageKey(source: String, attachmentID: String?, projectID: String) -> String {
        if let attachmentID { return "attachment:" + attachmentID }
        guard source.utf8.count > 256 else { return projectID + "|" + source }
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in source.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return "data:\(source.utf8.count):" + String(hash, radix: 16)
    }
}

/// A recorded pixel size, when both dimensions are present.
func conversationPixelSize(_ width: Double?, _ height: Double?) -> CGSize? {
    guard let width, let height, width > 0, height > 0 else { return nil }
    return CGSize(width: width, height: height)
}

/// Lays an image out at a height known before it loads: the exact aspect when known, else a
/// fixed box. The picture and its placeholder are fitted inside and centred, or hug the
/// trailing edge on the user's side of the conversation.
struct ConversationImageFrame: Layout {
    let shape: ConversationLayoutMemo.ImageShape
    var trailing = false
    static let maximumHeight: CGFloat = 360
    static let boxHeight: CGFloat = 220

    private func size(width: CGFloat) -> CGSize {
        switch shape {
        case let .aspect(aspect):
            let height = min(Self.maximumHeight, width / max(aspect, 0.01))
            return CGSize(width: min(width, height * aspect), height: height)
        case .box:
            return CGSize(width: width, height: min(Self.boxHeight, width * 0.75))
        }
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width.map { $0.isFinite ? $0 : 320 } ?? 320
        return CGSize(width: width, height: size(width: width).height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let fitted = size(width: bounds.width)
        for subview in subviews {
            let offered = ProposedViewSize(fitted)
            let width = min(fitted.width, subview.sizeThatFits(offered).width)
            let x = trailing ? bounds.maxX - width : bounds.midX - width / 2
            subview.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: offered)
        }
    }
}
