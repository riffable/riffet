import SwiftUI
import WebKit

/// The drafts a drawn style was designed from (`docs/design/interface-styles/pages`), bundled as
/// `pages/<style id>/index.html`. A style without a folder there (the native one) has none.
enum InterfaceStyleDrafts {
    /// The styles that have drafts.
    static var styles: [InterfaceStyle] { InterfaceStyle.allCases.filter { url(for: $0) != nil } }

    static func url(for style: InterfaceStyle) -> URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "pages/\(style.rawValue)")
    }
}

/// The drafts of the drawn styles, from the Help menu: one style at a time, picked at the top.
struct InterfaceStyleDraftsWindow: View {
    static let id = "interface-style-drafts"
    @State private var style: InterfaceStyle = InterfaceStyleDrafts.styles.first ?? .riffet
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            Picker("界面风格", selection: $style) {
                ForEach(InterfaceStyleDrafts.styles) { Text($0.title).tag($0) }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .fixedSize()
            .frame(height: 44)
            Rectangle().fill(palette.line).frame(height: 1)
            if let url = InterfaceStyleDrafts.url(for: style) {
                DraftPage(url: url).id(style)
            }
        }
        .frame(minWidth: 960, idealWidth: 1240, minHeight: 640, idealHeight: 860)
        .onAppear {
            let current = DisplayPreferences.shared.interfaceStyle
            if InterfaceStyleDrafts.url(for: current) != nil { style = current }
        }
    }
}

private struct DraftPage: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        // The frames are drawn at 1440pt; a little smaller fits a sheet without hiding their edges.
        view.pageZoom = 0.8
        view.allowsMagnification = true
        // The page reads its scripts from the shared folder beside it.
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent().deletingLastPathComponent())
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}
}
