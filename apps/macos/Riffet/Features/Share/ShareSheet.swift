import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// 导出图片: a sheet with the card at its real size on the left and its options on the right; the
/// picture is saved as a PNG or copied.
@MainActor
enum ShareImage {
    private static var sheet: NSWindow?

    static func present(_ source: ShareSource, over window: NSWindow? = nil) {
        guard sheet == nil, let parent = window ?? NSApp.keyWindow ?? NSApp.mainWindow else { return }
        let size = NSSize(width: min(1000, max(860, parent.frame.width - 48)), height: min(680, max(560, parent.frame.height - 80)))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        let close = { [weak parent, weak window] in
            guard let window else { return }
            parent?.endSheet(window)
        }
        let host = NSHostingController(rootView: ShareImageView(source: source, close: close).environment(\.palette, ThemeStore.shared.palette))
        host.sizingOptions = []
        window.contentViewController = host
        window.setContentSize(size)
        window.contentMinSize = NSSize(width: 860, height: 560)
        sheet = window
        parent.beginSheet(window) { _ in sheet = nil }
    }

    /// The card as a bitmap at its export scale. [height] is the card's height in points when it is
    /// already known (the preview measured it); otherwise it is measured here first.
    static func render(_ card: ShareCard, height: CGFloat? = nil) -> NSBitmapImageRep? {
        let renderer = ImageRenderer(content: card)
        renderer.proposedSize = ProposedViewSize(width: card.metrics.width, height: nil)
        var points = height ?? 0
        if points <= 0 {
            renderer.scale = 1
            points = renderer.cgImage.map { CGFloat($0.height) } ?? 0
        }
        let scale = card.metrics.scale(height: points)
        renderer.scale = scale
        guard let image = renderer.cgImage else { return nil }
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = NSSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale)
        return rep
    }

    /// `Riffet-<title>-<yyyyMMdd-HHmm>.png`, the title without path separators or control characters.
    static func fileName(title: String, date: Date = Date()) -> String {
        let banned = CharacterSet(charactersIn: "/:\\").union(.controlCharacters)
        let cleaned = String(String.UnicodeScalarView(title.unicodeScalars.filter { !banned.contains($0) })).trimmingCharacters(in: .whitespaces)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmm"
        return ["Riffet", String(cleaned.prefix(40)), formatter.string(from: date)].filter { !$0.isEmpty }.joined(separator: "-") + ".png"
    }
}

private struct ShareImageView: View {
    let source: ShareSource
    let close: () -> Void
    private let content: ShareContent
    @State private var options = ShareOptions.load()
    @State private var prompt: String?
    @State private var promptLoading: Bool
    @State private var cardHeight: CGFloat = 0
    /// Bumped once the code blocks are coloured; the highlighter's cache is not observable.
    @State private var colored = 0
    @State private var exporting = false
    @State private var toast: String?
    @State private var toastFailed = false
    @State private var toastTicket = 0
    @State private var toastDismissal = UUID()
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme

    init(source: ShareSource, close: @escaping () -> Void) {
        self.source = source
        self.close = close
        content = ShareContent(source)
        _promptLoading = State(initialValue: source.kind == .message && source.prompt != nil)
    }

    private var metrics: ShareMetrics { ShareMetrics(kind: source.kind, width: options.width, content: content) }
    private var colors: ShareColors { ShareColors(options.theme, dark: colorScheme == .dark, palette: palette) }
    private var card: ShareCard {
        ShareCard(source: source, content: content, options: options, metrics: metrics, colors: colors, prompt: options.ask && source.kind == .message ? prompt : nil)
    }

    var body: some View {
        HStack(spacing: 0) {
            preview
            Rectangle().fill(palette.line).frame(width: 1)
            panel.frame(width: 280).disabled(exporting)
        }
        .frame(minWidth: 860, maxWidth: .infinity, minHeight: 560, maxHeight: .infinity)
        .background(palette.bg)
        // Re-run when the card's colours change: a formula is painted in them.
        .task(id: "\(options.theme.rawValue)|\(colorScheme)|\(palette.values.id)|\(palette.revision)") {
            guard source.kind == .message else { return }
            await ShareMarkdown.prepare(content.text, colors: colors, projectId: source.projectId)
            colored += 1
        }
        .task {
            guard promptLoading, let load = source.prompt else { return }
            let text = await load()?.trimmingCharacters(in: .whitespacesAndNewlines)
            prompt = text?.isEmpty == false ? text : nil
            promptLoading = false
        }
        .onChange(of: options) { _, next in next.save() }
    }

    // MARK: Preview

    private var preview: some View {
        GeometryReader { proxy in
            ScrollView([.vertical, .horizontal]) {
                card
                    .id(colored)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { cardHeight = $0 }
                    .padding(.vertical, 40)
                    .padding(.horizontal, 32)
                    .frame(minWidth: proxy.size.width, minHeight: proxy.size.height, alignment: .top)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(colors.dark ? Color(.sRGB, red: 0x2A / 255, green: 0x2B / 255, blue: 0x2E / 255) : Color(.sRGB, red: 0xE7 / 255, green: 0xE8 / 255, blue: 0xEB / 255))
        .overlay(alignment: .bottom) {
            VStack(spacing: Space.xs) {
                FeedbackRegion(value: toast.map { ToastFeedback(text: $0, failed: toastFailed) }, renewal: toastTicket) { held, _ in
                    HStack(alignment: .top, spacing: Space.sm) {
                        if held.failed { Image(icon: "exclamationmark.circle").foregroundStyle(palette.toastDanger) }
                        Text(held.text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        if held.failed {
                            Button {
                                self.toast = nil
                                toastDismissal = UUID()
                            } label: { Image(icon: "xmark") }
                                .buttonStyle(.plain).help("关闭")
                        }
                    }
                    .font(.riffet(size: S(12.5))).foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).fill(palette.toast))
                    .transition(.opacity.combined(with: .offset(y: 8)))
                }
                .id(toastDismissal)
                // This export sheet is an AppKit NSHostingController, outside a SwiftUI Scene.
                // FeedbackRegion observes application activation independently.
                .environment(\.scenePhase, .active)
            }
            .padding(.bottom, 28)
        }
        .animation(.easeOut(duration: 0.2), value: toast)
    }

    // MARK: Options

    private struct ToastFeedback: Equatable {
        let text: String
        let failed: Bool
    }

    private var panel: some View {
        VStack(spacing: 0) {
            HStack {
                Text("导出图片").font(.riffet(size: S(14), weight: .semibold)).foregroundStyle(palette.fg)
                Spacer()
                Button(action: close) { Image(icon: "xmark").font(.riffet(size: S(11.5), weight: .medium)) }
                    .buttonStyle(IconButtonStyle(size: 24))
                    .keyboardShortcut(.cancelAction)
                    .help("关闭")
            }
            .padding(.horizontal, 20)
            .frame(height: 52)
            Rectangle().fill(palette.line).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    option(String(localized: "主题")) { Segments(selection: $options.theme, values: ShareTheme.allCases, title: \.title) }
                    option(String(localized: "字体")) { Segments(selection: $options.face, values: ShareFace.allCases, title: \.title) }
                    option(String(localized: "宽度")) { Segments(selection: $options.width, values: ShareWidth.allCases, title: \.title) }
                    VStack(alignment: .leading, spacing: 12) {
                        toggle(String(localized: "显示提问"), hint: askHint, isOn: $options.ask, disabled: source.kind != .message || prompt == nil)
                        toggle(String(localized: "显示批注"), hint: source.note == nil ? String(localized: "这条收藏没有备注") : String(localized: "收藏时写的备注"), isOn: $options.note, disabled: source.note == nil)
                        toggle(String(localized: "显示来源"), hint: String(localized: "会话标题、Agent、项目与日期"), isOn: $options.source, disabled: false)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 18)
            }
            Rectangle().fill(palette.line).frame(height: 1)
            VStack(alignment: .leading, spacing: 10) {
                Text(dimensions)
                    .font(.riffet(size: S(11.5)))
                    .monospacedDigit()
                    .foregroundStyle(palette.fg4)
                HStack(spacing: 8) {
                    Button(action: save) { Text("保存 PNG").frame(maxWidth: .infinity) }
                        .buttonStyle(SolidButtonStyle())
                    Button(action: copy) { Text("复制图片").frame(maxWidth: .infinity) }
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                        .keyboardShortcut("c")
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
    }

    private var askHint: String {
        if source.kind != .message { return String(localized: "仅整条回复可用") }
        if promptLoading { return String(localized: "正在查找对应的提问…") }
        return prompt == nil ? String(localized: "找不到对应的提问") : String(localized: "这条回复对应的用户提问")
    }

    private var dimensions: String {
        let scale = metrics.scale(height: cardHeight)
        let label = scale == scale.rounded() ? String(Int(scale)) : String(format: "%.2f", scale)
        return "\(Int((metrics.width * scale).rounded())) × \(Int((cardHeight * scale).rounded())) px · PNG · \(label)×"
    }

    private func option<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg2)
            content()
        }
    }

    private func toggle(_ title: String, hint: String, isOn: Binding<Bool>, disabled: Bool) -> some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.riffet(size: S(13))).foregroundStyle(palette.fg2)
                Text(hint).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4)
            }
            Spacer(minLength: 0)
            Toggle(title, isOn: Binding(get: { isOn.wrappedValue && !disabled }, set: { isOn.wrappedValue = $0 }))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.mini)
                .disabled(disabled)
        }
    }

    // MARK: Export

    private func picture() -> (png: Data, rep: NSBitmapImageRep)? {
        guard let rep = ShareImage.render(card),
              let png = rep.representation(using: .png, properties: [:]) else {
            show(String(localized: "无法生成图片"), failed: true)
            return nil
        }
        return (png, rep)
    }

    private func copy() {
        Task { @MainActor in
            guard !exporting else { return }
            exporting = true
            defer { exporting = false }
            if source.kind == .message { await ShareMarkdown.prepare(content.text, colors: colors, projectId: source.projectId) }
            colored += 1
            guard let (png, rep) = picture() else { return }
            let item = NSPasteboardItem()
            item.setData(png, forType: .png)
            if let tiff = rep.tiffRepresentation { item.setData(tiff, forType: .tiff) }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.writeObjects([item])
            show(String(localized: "已复制图片"))
        }
    }

    private func save() {
        Task { @MainActor in
            guard !exporting else { return }
            exporting = true
            defer { exporting = false }
            if source.kind == .message { await ShareMarkdown.prepare(content.text, colors: colors, projectId: source.projectId) }
            colored += 1
            guard let (png, _) = picture() else { return }
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.png]
            panel.canCreateDirectories = true
            panel.nameFieldStringValue = ShareImage.fileName(title: source.sessionTitle)
            guard panel.runModal() == .OK, let url = panel.url else { return }
            do {
                try png.write(to: url, options: .atomic)
                show(String(localized: "已保存图片"))
            } catch {
                show(String(localized: "保存失败：\(error.localizedDescription)"), failed: true)
            }
        }
    }

    private func show(_ message: String, failed: Bool = false) {
        toastTicket += 1
        let ticket = toastTicket
        toast = message
        toastFailed = failed
        guard !failed else { return }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            if ticket == toastTicket { toast = nil }
        }
    }
}

/// A segmented choice spanning the panel's width in equal parts; AppKit's segmented control keeps
/// its natural width under SwiftUI.
private struct Segments<Value: Hashable>: View {
    @Binding var selection: Value
    let values: [Value]
    let title: KeyPath<Value, String>
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            ForEach(values, id: \.self) { value in
                let on = value == selection
                Button { selection = value } label: {
                    Text(value[keyPath: title])
                        .font(.riffet(size: S(12.5), weight: on ? .medium : .regular))
                        .foregroundStyle(on ? palette.fg : palette.fg3)
                        .frame(maxWidth: .infinity)
                        .frame(height: 24)
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                    .fill(palette.bgElevated)
                                    .shadow(color: .black.opacity(0.06), radius: 1, y: 1)
                                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
    }
}
