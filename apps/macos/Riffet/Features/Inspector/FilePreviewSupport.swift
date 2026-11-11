import AppKit
import QuickLookUI
import SwiftUI

/// Shared preview pages are isolated server documents. Only their initial native request receives
/// credentials; appearance travels as ordinary query parameters and participates in reload identity.
struct FilePreviewTheme {
    let scheme: String
    let color: String
    let background: String
    let line: String
    let accent: String

    init(palette: Palette, dark: Bool) {
        let values = dark ? palette.values.dark : palette.values.light
        scheme = dark ? "dark" : "light"
        color = values.fg.hex
        background = values.bg.hex
        line = values.lineStrong.hex
        accent = values.accent.hex
    }

    func url(_ raw: URL) -> URL? {
        guard var components = URLComponents(url: raw, resolvingAgainstBaseURL: false) else { return nil }
        let existing = components.queryItems ?? []
        components.queryItems = existing + [
            URLQueryItem(name: "render", value: "preview"),
            URLQueryItem(name: "scheme", value: scheme),
            URLQueryItem(name: "color", value: color),
            URLQueryItem(name: "background", value: background),
            URLQueryItem(name: "line", value: line),
            URLQueryItem(name: "accent", value: accent),
        ]
        let encoded = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        components.percentEncodedQuery = encoded
        return components.url
    }
}

/// The system fallback stays inside the same panel and reads a private local copy; no external app
/// is launched. The local copy belongs to this view and is removed when the preview closes.
struct SystemFilePreview: View {
    let url: URL
    let name: String
    @State private var local: URL?
    @State private var failure: String?

    var body: some View {
        Group {
            if let local {
                QuickLookDocument(url: local)
            } else if let failure {
                ContentUnavailableView("无法预览", icon: "doc", description: Text(failure))
            } else {
                ProgressView()
            }
        }
        .task(id: url) {
            if let local {
                try? FileManager.default.removeItem(at: local.deletingLastPathComponent())
                self.local = nil
            }
            failure = nil
            do {
                let file = try await ProjectDownloads.previewFile(url, name: name)
                if Task.isCancelled {
                    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
                } else {
                    local = file
                }
            } catch {
                if !Task.isCancelled { failure = error.riffetMessage }
            }
        }
        .onDisappear {
            if let local {
                try? FileManager.default.removeItem(at: local.deletingLastPathComponent())
                self.local = nil
            }
        }
    }
}

private struct QuickLookDocument: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        let view = QLPreviewView(frame: .zero, style: .normal)!
        view.autostarts = false
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: QLPreviewView, context: Context) {
        if (view.previewItem as? NSURL) != url as NSURL { view.previewItem = url as NSURL }
    }

    static func dismantleNSView(_ view: QLPreviewView, coordinator: ()) { view.close() }
}

/// A shared rendered document, with Quick Look as the fallback if the server cannot render it.
struct RenderedFilePreview: View {
    let url: URL
    let rawURL: URL
    let name: String
    @State private var fallback = false

    var body: some View {
        Group {
            if fallback {
                SystemFilePreview(url: rawURL, name: name)
            } else {
                SandboxedPage(request: ProjectDownloads.authorized(url), navigation: .samePage,
                              onFailure: { _ in fallback = true }, onUnsupportedContent: { fallback = true })
            }
        }
        .onChange(of: url) { _, _ in fallback = false }
    }
}

@MainActor
enum AttachmentPreview {
    private static var sheet: NSWindow?

    static func present(id: String, name: String) {
        guard sheet == nil, let parent = NSApp.keyWindow ?? NSApp.mainWindow,
              let url = ProjectDownloads.attachmentURL(id: id) else { return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 650),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = name
        window.contentMinSize = NSSize(width: 480, height: 360)
        let close = { [weak parent, weak window] in if let window { parent?.endSheet(window) } }
        let root = AttachmentPreviewPage(id: id, name: name, url: url, close: close)
        window.contentViewController = NSHostingController(rootView: root)
        sheet = window
        parent.beginSheet(window) { _ in sheet = nil }
    }
}

private struct AttachmentPreviewPage: View {
    let id: String
    let name: String
    let url: URL
    let close: () -> Void
    @State private var theme = ThemeStore.shared
    @Environment(\.colorScheme) private var colorScheme
    @State private var notice: String?
    private var palette: Palette { theme.palette }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button {
                    Task { notice = await ProjectDownloads.saveAttachment(id: id, name: name) }
                } label: { Image(icon: "arrow.down.circle") }
                    .help("下载")
                Button(action: close) { Image(icon: "xmark") }
                    .help("关闭")
            }
            .buttonStyle(IconButtonStyle())
            .padding(.horizontal, Space.sm)
            .frame(height: InspectorMetrics.headerHeight)
            PanelRule()
            if let rendered = FilePreviewTheme(palette: palette, dark: colorScheme == .dark).url(url) {
                RenderedFilePreview(url: rendered, rawURL: url, name: name)
            }
            if let notice { Text(notice).font(.riffet(size: S(12))).foregroundStyle(palette.danger).padding(6) }
        }
        .background(palette.bg)
        .environment(\.palette, palette)
        .tint(palette.accent)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
