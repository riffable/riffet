import AppKit
import SwiftUI
import RiffetKit

/// The owner's avatar (个人资料): the picture, else the name's first character, else a person.
/// The picture goes through `ImageLoader`, which sends the device token like every other server image.
struct OwnerAvatar: View {
    let workbench: Workbench
    var size: CGFloat = 22
    @Environment(\.palette) private var palette
    @State private var image: NSImage?

    private var owner: OwnerInfo? { workbench.owner }

    private var url: String? {
        owner.flatMap { workbench.host.api?.ownerAvatarUrl(owner: $0) }
    }

    var body: some View {
        ZStack {
            if let image = shown {
                Image(nsImage: image).resizable().interpolation(.high).scaledToFill()
            } else if let monogram = owner?.monogram {
                Text(monogram).font(.riffet(size: size * 0.45, weight: .medium)).foregroundStyle(palette.fg2)
            } else {
                Image(icon: "person.fill").font(.riffet(size: size * 0.5)).foregroundStyle(palette.fg3)
            }
        }
        .frame(width: size, height: size)
        .background(palette.bgMuted)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(palette.lineSoft))
        .task(id: url) {
            guard let url else { image = nil; return }
            let loaded = await ImageLoader.shared.image(for: .url(url), projectId: nil)
            guard !Task.isCancelled else { return }
            image = loaded
        }
    }

    /// The loaded picture, or the cached one on the first frame; nothing once the avatar is gone.
    private var shown: NSImage? {
        guard let url else { return nil }
        return image ?? ImageLoader.shared.cached(for: .url(url), projectId: nil)
    }
}
