import AppKit
import SwiftUI

/// An agent's Markdown outside the transcript (an interaction card's plan, a rendered code block's
/// preview): the transcript's own layout and views, sized to the width SwiftUI offers.
struct MarkdownView: View {
    let source: String
    var compact = false
    var muted = false
    @State private var model = MarkdownViewModel()
    @Environment(\.conversationProjectId) private var projectId
    @Environment(\.workbenchScope) private var workbench
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        MarkdownRepresentable(source: source, compact: compact, muted: muted, projectId: projectId, workbench: workbench, dark: colorScheme == .dark, model: model, revision: model.revision)
    }
}

/// The disclosures of one standalone Markdown view and a revision that re-measures it.
@MainActor
@Observable
final class MarkdownViewModel {
    var revision = 0
    @ObservationIgnored let ui = TranscriptUIStore(completedProcessesOpen: false)
    @ObservationIgnored var pending: Set<String> = []
    @ObservationIgnored private var observer: NSObjectProtocol?

    init() {
        observer = NotificationCenter.default.addObserver(forName: TranscriptResources.notification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let self, let token = note.userInfo?["token"] as? String, self.pending.contains(token) else { return }
                self.revision += 1
            }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}

private struct MarkdownRepresentable: NSViewRepresentable {
    let source: String
    let compact: Bool
    let muted: Bool
    let projectId: String?
    /// The window the view is in; clicks reach no window without it.
    let workbench: Workbench?
    let dark: Bool
    let model: MarkdownViewModel
    let revision: Int

    /// Layouts by width for the current content: SwiftUI probes several widths before placing.
    final class Coordinator {
        var key = ""
        var layouts: [CGFloat: RowLayout] = [:]
    }

    /// Shows the layout for its own width once placed, and keeps the row's fragment window on what
    /// is on screen: a plan is taller than any sheet, and only the fragments near the visible part
    /// have views.
    final class HostView: NSView {
        let cell: TranscriptCell
        var provider: ((CGFloat) -> (RowLayout, TranscriptStyle))?
        private weak var observedClip: NSClipView?

        init(cell: TranscriptCell) {
            self.cell = cell
            super.init(frame: .zero)
            addSubview(cell)
        }

        required init?(coder: NSCoder) { fatalError() }

        override var isFlipped: Bool { true }

        override func layout() {
            super.layout()
            cell.frame = bounds
            guard bounds.width > 0, let (layout, style) = provider?(bounds.width) else { return }
            cell.configure(key: "markdown", layout: layout, style: style)
            observeClip()
            showVisible()
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observeClip()
            showVisible()
        }

        /// The scroll view can appear after the view is in the window; follow it when it does.
        private func observeClip() {
            guard let clip = enclosingScrollView?.contentView else { return }
            guard clip !== observedClip else { return }
            if let old = observedClip {
                NotificationCenter.default.removeObserver(self, name: NSView.boundsDidChangeNotification, object: old)
            }
            observedClip = clip
            clip.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(self, selector: #selector(visiblePartChanged), name: NSView.boundsDidChangeNotification, object: clip)
        }

        @objc private func visiblePartChanged() {
            showVisible()
        }

        private func showVisible() {
            let visible = visibleRect
            guard cell.rowLayout != nil, !visible.isNull, !visible.isEmpty else { return }
            cell.show(visible)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> HostView {
        let cell = TranscriptCell(style: TranscriptStyle.current(dark: dark))
        cell.fileMenu = { [workbench] path in
            FileOpener.menuItems(path: path, projectId: projectId, workbench: workbench)
        }
        cell.onAction = { [model, workbench] action in
            switch action {
            case .toggleWrap, .toggleRendered:
                model.ui.toggle(action, row: "markdown")
                model.revision += 1
            case let .openURL(url):
                if let target = FileLink.parse(url) {
                    FileOpener.activate(path: target.path, line: target.line, projectId: projectId, workbench: workbench)
                } else if url.scheme != MathText.scheme {
                    NSWorkspace.shared.open(url)
                }
            case let .openFile(path, line):
                FileOpener.activate(path: path, line: line, projectId: projectId, workbench: workbench)
            case let .openImage(item):
                ImageViewer.shared.show(item)
            case let .openVisualization(path, title, wide):
                guard let workbench else { break }
                NotificationCenter.default.post(name: .riffetOpenVisualization, object: workbench, userInfo: ["path": path, "title": title, "wide": wide])
            default:
                break
            }
        }
        return HostView(cell: cell)
    }

    func updateNSView(_ view: HostView, context: Context) {
        view.provider = { [self] width in (layout(width, context.coordinator), TranscriptStyle.current(dark: dark)) }
        view.needsLayout = true
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: HostView, context: Context) -> CGSize? {
        let width = (proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }) ?? 600
        return CGSize(width: width, height: layout(width, context.coordinator).height)
    }

    private func layout(_ width: CGFloat, _ coordinator: Coordinator) -> RowLayout {
        let style = TranscriptStyle.current(dark: dark)
        let key = "\(style.key)|\(revision)|\(compact)|\(muted)|\(source.hashValue)"
        if key != coordinator.key {
            coordinator.key = key
            coordinator.layouts.removeAll()
        }
        if let hit = coordinator.layouts[width] { return hit }
        var builder = RowBuilder(style: style, width: width, ui: model.ui, root: nil, projectId: projectId, stale: true)
        let layout = builder.markdownLayout(source, key: "markdown", muted: muted, compact: compact)
        if coordinator.layouts.count > 8 { coordinator.layouts.removeAll() }
        coordinator.layouts[width] = layout
        model.pending.formUnion(layout.pending)
        return layout
    }
}
