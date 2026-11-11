import AppKit
import SwiftUI
import RiffetKit

enum VisualizationPresentation {
    static func title(path: String, supplied: String?) -> String {
        let value = supplied?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? (path as NSString).lastPathComponent : value
    }

    static func sheetSize(wide: Bool, visibleFrame: CGRect?) -> CGSize {
        let bounds = visibleFrame ?? CGRect(x: 0, y: 0, width: 1280, height: 900)
        return CGSize(
            width: min(wide ? 1120 : 820, max(320, bounds.width - 40)),
            height: min(wide ? 820 : 680, max(300, bounds.height - 56))
        )
    }

    static func readFailure(code: String?, message: String) -> String {
        if code == "PATH_OUTSIDE_PROJECT" || code == "INVALID_PATH" {
            return String(localized: "该文件在项目目录之外。可在「设置 → 文件与编辑器」中允许只读预览项目外文件。")
        }
        return message
    }
}

enum VisualizationLoadState: Equatable {
    case checking
    case loading
    case ready
    case failed(String)

    var showsWebPage: Bool { self == .loading || self == .ready }
    var showsLoadingOverlay: Bool { self == .loading }
}

/// The interactive page a visualization card opens, validated and loaded only once opened.
@MainActor
struct VisualizationSheet: View {
    let path: String
    let title: String
    let projectId: String?

    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var state: VisualizationLoadState = .checking
    @State private var filePreview: FilePreview?
    @State private var showingSource = false
    @State private var retryToken = 0

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            pageContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.bg)
            Divider()
            footer
        }
        .background(palette.bg)
        .task(id: retryToken) { await validateAndLoad() }
    }

    private var header: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.riffet(size: S(14), weight: .semibold))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Text(path)
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg4)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: Space.sm)
            Button { retryToken += 1 } label: {
                Image(icon: "arrow.clockwise").font(.riffet(size: S(12)))
            }
            .buttonStyle(IconButtonStyle())
            .help("重新加载")
        }
        .padding(.horizontal, Space.lg)
        .frame(height: 54)
    }

    @ViewBuilder
    private var pageContent: some View {
        if state.showsWebPage {
            ZStack {
                webPage
                if showingSource, let filePreview {
                    sourcePage(filePreview)
                }
            }
                .overlay {
                    if !showingSource && state.showsLoadingOverlay {
                        ProgressView("正在加载交互预览…")
                            .padding(Space.lg)
                            .background(palette.bgPopover.opacity(0.92), in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
                    }
                }
        } else if showingSource, let filePreview {
            sourcePage(filePreview)
        } else {
            switch state {
            case .checking:
                ProgressView("正在读取预览文件…")
                    .controlSize(.regular)
                    .foregroundStyle(palette.fg3)
            case let .failed(message):
                ContentUnavailableView {
                    Label("无法打开交互预览", icon: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("重试") { retryToken += 1 }
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                }
            case .loading, .ready:
                EmptyView()
            }
        }
    }

    private func sourcePage(_ preview: FilePreview) -> some View {
        VStack(spacing: 0) {
            CodeTextView(
                text: preview.content,
                language: CodeHighlighter.language(forPath: preview.path),
                palette: palette,
                fontSize: S(12)
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if preview.truncated {
                Divider()
                Text("文件过大，仅显示前一部分")
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Space.md)
                    .frame(height: 28)
            }
        }
        .background(palette.bg)
    }

    private var webPage: some View {
        Group {
            if let projectId,
               let url = ProjectDownloads.visualizationURL(projectId: projectId, path: path, scheme: colorScheme == .dark ? "dark" : "light") {
                SandboxedPage(
                    request: ProjectDownloads.authorized(url),
                    navigation: .samePage,
                    onLoadingChange: { loading in
                        if loading {
                            state = .loading
                        } else if case .loading = state {
                            state = .ready
                        }
                    },
                    onFailure: { message in state = .failed(message) }
                )
                .id("\(path)|\(retryToken)")
            } else {
                ContentUnavailableView("无法连接项目", icon: "network.slash", description: Text("当前会话没有可用的服务器。"))
            }
        }
    }

    private var footer: some View {
        HStack(spacing: Space.sm) {
            Button { showingSource.toggle() } label: {
                Label(showingSource ? "返回预览" : "查看源码", icon: showingSource ? "arrow.uturn.backward" : "chevron.left.forwardslash.chevron.right")
            }
            .buttonStyle(ChipButtonStyle())
            .disabled(filePreview == nil)
            Spacer()
            Button("完成") { dismiss() }
                .buttonStyle(SolidButtonStyle(kind: .primary))
                .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, Space.lg)
        .frame(height: 52)
        .background(palette.bgSubtle)
    }

    private func validateAndLoad() async {
        state = .checking
        filePreview = nil
        showingSource = false
        guard let projectId else {
            state = .failed(String(localized: "当前会话没有关联项目，无法读取预览文件。"))
            return
        }
        guard let api = AppModel.shared.host.api else {
            state = .failed(String(localized: "未连接服务器。"))
            return
        }
        do {
            let preview = try await api.preview(projectId: projectId, path: path)
            guard !Task.isCancelled else { return }
            guard !preview.binary else {
                state = .failed(String(localized: "该文件是二进制文件，无法作为交互预览打开。"))
                return
            }
            guard preview.size <= 1_000_000 else {
                filePreview = preview
                state = .failed(String(localized: "交互预览超过 1 MB，请查看源码。"))
                return
            }
            guard ProjectDownloads.visualizationURL(projectId: projectId, path: path, scheme: colorScheme == .dark ? "dark" : "light") != nil else {
                state = .failed(String(localized: "无法连接服务器。"))
                return
            }
            filePreview = preview
            state = .loading
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(VisualizationPresentation.readFailure(code: error.riffetCode, message: error.riffetMessage))
        }
    }
}
