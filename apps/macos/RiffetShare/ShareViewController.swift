import AppKit
import UniformTypeIdentifiers

/// "共享 > Riffet": turns what was shared (text, a web link, files) into one prompt and hands it to
/// the app as `riffet://new?prompt=…`, which opens the quick prompt prefilled. The extension itself
/// has no controls: it gathers, opens and finishes. Files go in as a path list; the agent reads
/// them from disk, nothing is uploaded from here.
final class ShareViewController: NSViewController {
    /// A link has a length limit somewhere along the way, and every non-ASCII character costs nine of
    /// its characters once encoded; a shared page of text is cut well before it.
    private static let textLimit = 4_000

    private let spinner = NSProgressIndicator()
    private let label = NSTextField(labelWithString: String(localized: "正在交给 Riffet…"))
    private lazy var closeButton: NSButton = {
        let button = NSButton(title: String(localized: "关闭"), target: self, action: #selector(close))
        button.isHidden = true
        return button
    }()

    override func loadView() {
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        label.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [spinner, label, closeButton])
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 32, bottom: 24, right: 32)
        view = stack
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        Task { await handOver() }
    }

    private func handOver() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var texts: [String] = []
        var links: [String] = []
        var files: [String] = []
        for item in items {
            var found = false
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier), let url = await load(provider, UTType.fileURL) as? URL {
                    files.append(url.path)
                    found = true
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = await load(provider, UTType.url) as? URL {
                    if url.isFileURL { files.append(url.path) } else { links.append(url.absoluteString) }
                    found = true
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let text = await load(provider, UTType.plainText) as? String {
                    texts.append(text)
                    found = true
                }
            }
            // Some apps put the text on the item itself instead of an attachment.
            if !found, let text = item.attributedContentText?.string, !text.isEmpty { texts.append(text) }
        }
        // The payload carries only content and neutral structure: the main app adds the localized
        // "truncated" and file-list labels when it shows the prompt. A shared link lives in the URL
        // query, so every part is encoded once by URLComponents rather than by hand.
        let text = texts.joined(separator: "\n\n")
        let truncated = text.count > Self.textLimit
        let body = truncated ? String(text.prefix(Self.textLimit)) : text
        guard !body.isEmpty || !links.isEmpty || !files.isEmpty else { return fail(String(localized: "没有可交给 Riffet 的内容")) }
        var queryItems = [URLQueryItem(name: "prompt", value: body)]
        if truncated { queryItems.append(URLQueryItem(name: "truncated", value: "1")) }
        if !links.isEmpty { queryItems.append(URLQueryItem(name: "links", value: links.joined(separator: "\n"))) }
        if !files.isEmpty, let data = try? JSONEncoder().encode(files), let json = String(data: data, encoding: .utf8) {
            queryItems.append(URLQueryItem(name: "files", value: json))
        }
        var components = URLComponents()
        components.scheme = "riffet"
        components.host = "new"
        components.queryItems = queryItems
        guard let url = components.url else { return fail(String(localized: "无法生成要交给 Riffet 的内容")) }
        guard NSWorkspace.shared.open(url) else { return fail(String(localized: "无法打开 Riffet，请确认应用已安装后重试")) }
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// Stays on screen with the reason instead of finishing as if the hand-over had worked.
    private func fail(_ message: String) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        label.stringValue = message
        closeButton.isHidden = false
    }

    @objc private func close() {
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    /// A file shared from Finder arrives as a URL or as its data representation, depending on the sender.
    private func load(_ provider: NSItemProvider, _ type: UTType) async -> Any? {
        guard let value = try? await provider.loadItem(forTypeIdentifier: type.identifier) else { return nil }
        if let data = value as? Data, type == .fileURL || type == .url { return URL(dataRepresentation: data, relativeTo: nil) }
        return value
    }
}
