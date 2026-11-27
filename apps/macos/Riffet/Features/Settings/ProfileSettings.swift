import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import RiffetKit

/// 个人资料: the name and avatar of this server's owner, shared by every device that connects to it.
struct ProfileSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        if let workbench = model.workbench {
            ProfileForm(workbench: workbench)
        } else {
            NeedsServerView()
        }
    }
}

private struct ProfileForm: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var draft = ""
    @State private var save = SettingsSaveState()
    @State private var styles: [OwnerAvatarStyle] = []
    @State private var picking = false
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var scheme

    private var owner: OwnerInfo? { workbench.owner }

    var body: some View {
        Form {
            Section {
                HStack(spacing: Space.md) {
                    OwnerAvatar(workbench: workbench, size: 56)
                    Spacer(minLength: Space.sm)
                    Button("更换头像…") { chooseAvatar() }
                        .buttonStyle(SolidButtonStyle(kind: .secondary))
                        .controlSize(.small)
                    if !styles.isEmpty {
                        Button { picking = true } label: { Image(icon: "dice") }
                            .buttonStyle(IconButtonStyle(size: 24))
                            .help("随机头像")
                            .accessibilityLabel("随机头像")
                            .popover(isPresented: $picking, arrowEdge: .bottom) {
                                AvatarStylePicker(workbench: workbench, styles: styles, ink: inkHex, paper: paperHex) { style, seed in
                                    picking = false
                                    Task { await save.run { try await workbench.generateOwnerAvatar(style: style, seed: seed, ink: inkHex, paper: paperHex) } }
                                }
                            }
                    }
                    if owner?.avatar != nil {
                        Button("移除") { Task { await save.run { try await workbench.removeOwnerAvatar() } } }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                            .controlSize(.small)
                    }
                }
                .disabled(save.busy)
                SettingsRow("名称") {
                    TextField("名称", text: $draft)
                        .labelsHidden()
                        .formField(bezeled: true)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 220)
                        .focused($focused)
                        .onSubmit { commitName() }
                        .onChange(of: draft) { _, value in
                            if value.unicodeScalars.count > OwnerLimits.nameMax {
                                draft = String(String.UnicodeScalarView(value.unicodeScalars.prefix(OwnerLimits.nameMax)))
                            }
                        }
                }
                if let history = owner?.history, !history.isEmpty {
                    let recent = Array(history.prefix(12))
                    let contentWidth = CGFloat(recent.count) * 28 + CGFloat(max(recent.count - 1, 0)) * Space.sm
                    SettingsRow("历史头像") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: Space.sm) {
                                ForEach(recent, id: \.sha256) { avatar in
                                    Button {
                                        Task { await save.run { try await workbench.restoreOwnerAvatar(sha256: avatar.sha256) } }
                                    } label: {
                                        AvatarPreview(url: workbench.ownerAvatarUrl(avatar), size: 28)
                                    }
                                    .buttonStyle(.plain)
                                    .contextMenu {
                                        Button("删除", role: .destructive) {
                                            Task { await save.run { try await workbench.deleteOwnerAvatarHistory(sha256: avatar.sha256) } }
                                        }
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: min(contentWidth, 28 * 8 + Space.sm * 7))
                        .fixedSize(horizontal: false, vertical: true)
                        .disabled(save.busy)
                    }
                }
                SettingsFeedback(state: save)
            }
            SettingsScopeFooter()
        }
        .riffetForm()
        .onAppear { draft = owner?.name ?? "" }
        .task { styles = await workbench.ownerAvatarStyles() }
        .onChange(of: owner?.name) { _, name in if !focused { draft = name ?? "" } }
        .onChange(of: focused) { _, isFocused in if !isFocused { commitName() } }
        .onDisappear { commitName() }
    }

    /// The current theme's text and background colours, which the generated picture keeps.
    private var inkHex: String { Self.rgbHex((scheme == .dark ? palette.values.dark : palette.values.light).fg) }
    private var paperHex: String { Self.rgbHex((scheme == .dark ? palette.values.dark : palette.values.light).bg) }

    private static func rgbHex(_ color: RiffetRGBA) -> String { String(color.hex.prefix(7)) }

    private func commitName() {
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value != (owner?.name ?? "") else { return }
        Task { await save.run { try await workbench.setOwnerName(value) } }
    }

    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.png, .jpeg, .webP, .heic]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            await save.run {
                let prepared = try await Task.detached(priority: .userInitiated) { try AvatarEncoder.prepare(contentsOf: url) }.value
                try await workbench.setOwnerAvatar(prepared.data, type: prepared.type)
            }
        }
    }
}

/// The grid of generated avatar styles, each tile drawn from its own random seed.
private struct AvatarStylePicker: View {
    let workbench: Workbench
    let styles: [OwnerAvatarStyle]
    let ink: String
    let paper: String
    let choose: (_ style: String, _ seed: String) -> Void
    @Environment(\.palette) private var palette
    @State private var seeds: [String: String] = [:]

    private var shown: [OwnerAvatarStyle] {
        let named = workbench.owner?.monogram != nil
        return styles.filter { named || !$0.needsName }
    }

    var body: some View {
        VStack(spacing: Space.md) {
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(64), spacing: Space.sm), count: 4), spacing: Space.md) {
                ForEach(shown, id: \.id) { style in
                    let seed = seeds[style.id] ?? Self.randomSeed()
                    Button { choose(style.id, seed) } label: {
                        VStack(spacing: Space.xs) {
                            AvatarPreview(url: workbench.ownerAvatarPreviewUrl(style: style.id, seed: seed, ink: ink, paper: paper))
                            Text(localizedText(style.title, fallback: style.id.split(separator: "/").last.map(String.init) ?? style.id))
                                .font(RiffetFont.footnote)
                                .foregroundStyle(palette.fg3)
                                .lineLimit(1)
                        }
                        .frame(width: 64)
                    }
                    .buttonStyle(.plain)
                    .help(style.credit ?? "")
                }
            }
            Button("换一批") { seeds = Dictionary(uniqueKeysWithValues: styles.map { ($0.id, Self.randomSeed()) }) }
                .buttonStyle(SolidButtonStyle(kind: .secondary))
                .controlSize(.small)
        }
        .padding(Space.md)
        .onAppear { seeds = Dictionary(uniqueKeysWithValues: styles.map { ($0.id, Self.randomSeed()) }) }
    }

    /// Base36 of a UUID, at most 16 characters.
    private static func randomSeed() -> String {
        let value = UUID().uuid
        let high = withUnsafeBytes(of: value) { $0.load(as: UInt64.self) }
        return String(String(high, radix: 36).prefix(16))
    }
}

private struct AvatarPreview: View {
    let url: String?
    var size: CGFloat = 52
    @Environment(\.palette) private var palette
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            if let image = image ?? url.flatMap({ ImageLoader.shared.cached(for: .url($0), projectId: nil) }) {
                Image(nsImage: image).resizable().interpolation(.high).scaledToFill()
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
}

private enum OwnerLimits {
    static let nameMax = 32
    static let side = 512
    static let maxBytes = 1024 * 1024
}

/// Center-crops a picture to a square, scales it to at most 512 px and encodes it under 1 MiB: PNG,
/// else JPEG at falling quality. The server does not resize.
private enum AvatarEncoder {
    static func prepare(contentsOf url: URL) throws -> (data: Data, type: String) {
        let failure = SettingsFailure(String(localized: "无法读取这张图片"))
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw failure }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw failure }
        let side = min(image.width, image.height)
        let crop = CGRect(x: (image.width - side) / 2, y: (image.height - side) / 2, width: side, height: side)
        guard let square = image.cropping(to: crop) else { throw failure }
        let target = min(side, OwnerLimits.side)
        guard let png = render(square, side: target, opaque: false).flatMap({ encode($0, type: .png) }) else { throw failure }
        if png.count <= OwnerLimits.maxBytes { return (png, "image/png") }
        guard let flat = render(square, side: target, opaque: true) else { throw failure }
        for quality in [0.9, 0.8, 0.65, 0.5] {
            if let jpeg = encode(flat, type: .jpeg, quality: quality), jpeg.count <= OwnerLimits.maxBytes { return (jpeg, "image/jpeg") }
        }
        throw SettingsFailure(String(localized: "图片太大"))
    }

    /// An sRGB bitmap of [side] px; a JPEG has no alpha, so it is flattened onto white.
    private static func render(_ image: CGImage, side: Int, opaque: Bool) -> CGImage? {
        guard let context = CGContext(
            data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        let rect = CGRect(x: 0, y: 0, width: side, height: side)
        if opaque {
            context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            context.fill(rect)
        }
        context.interpolationQuality = .high
        context.draw(image, in: rect)
        return context.makeImage()
    }

    private static func encode(_ image: CGImage, type: UTType, quality: Double? = nil) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        let properties = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
        CGImageDestinationAddImage(destination, image, properties)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}
