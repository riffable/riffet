import SwiftUI
import RiffetKit

/// The canvas of one session: its conversation and the forks around it as flows, over the ground they happened in. Drawn natively
/// (no web view); the layout is the web canvas's own, run in JavaScriptCore.
///
/// The page replaces the transcript in the session's detail column. [showTranscript] switches back to it (the "open in
/// conversation" action). The conversation's bottom composer is not shown here: pressing the slot for the next question opens
/// the same composer over the slot, pinned to its place on the plane, until a press away, Escape, or a send.
struct CanvasPage: View {
    let workbench: Workbench
    let session: Session
    let composer: AnyView
    var showTranscript: () -> Void = {}

    var body: some View {
        CanvasPageBody(workbench: workbench, session: session, composer: composer, showTranscript: showTranscript)
            .id(session.id)
    }
}

private struct CanvasPageBody: View {
    let workbench: Workbench
    let session: Session
    let composer: AnyView
    let showTranscript: () -> Void
    @State private var controller: CanvasController?
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            if let controller { CanvasPlane(controller: controller, workbench: workbench, composer: composer) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .onAppear { start() }
        .onDisappear { stop() }
        .onChange(of: palette.revision) { _, _ in theme() }
        .onChange(of: colorScheme) { _, _ in theme() }
        .onChange(of: CanvasFaces.current()) { _, _ in theme() }
        .onChange(of: workbench.sendState.sending) { _, sending in controller?.noteSending(sending) }
    }

    private func start() {
        guard controller == nil else { return }
        let made = CanvasController(workbench: workbench, session: session, showTranscript: showTranscript)
        made.setTheme(palette: palette, dark: colorScheme == .dark)
        made.start()
        controller = made
    }

    private func stop() {
        controller?.stop()
        controller = nil
    }

    private func theme() { controller?.setTheme(palette: palette, dark: colorScheme == .dark) }
}

/// The plane and the SwiftUI pieces above it.
private struct CanvasPlane: View {
    let controller: CanvasController
    let workbench: Workbench
    let composer: AnyView
    @Environment(\.palette) private var palette

    var body: some View {
        CanvasSurfaceHost(container: controller.container)
            .overlay {
                if controller.nextOpen {
                    CanvasNextPanel(anchor: controller.nextAnchor, onClose: controller.closeNext, content: composer)
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.12), value: controller.nextOpen)
            .overlay(alignment: .bottomLeading) { bottomLeading }
            .overlay(alignment: .bottomTrailing) {
                CanvasZoomHost(controller: controller)
            }
            .overlay(alignment: .trailing) {
                CanvasInspector(controller: controller)
                    .animation(.easeOut(duration: 0.2), value: controller.selectedNode?.id)
            }
            .overlay {
                if controller.failed != nil {
                    Text("画布无法加载").font(.riffet(size: S(13))).foregroundStyle(palette.fg3)
                } else if !controller.ready {
                    Spinner()
                }
            }
            .environment(\.workbenchScope, workbench)
            .environment(\.conversationProjectId, controller.projectId)
    }

    @ViewBuilder
    private var bottomLeading: some View {
        if let replay = controller.replay, controller.canReplay {
            CanvasReplayBar(
                strings: controller.strings, count: controller.momentCount,
                index: Binding(get: { replay.index }, set: { controller.setReplayIndex($0) }),
                playing: replay.playing, stamp: controller.replayStamp, onToggle: controller.toggleReplay, onEnd: controller.endReplay
            )
            .padding(16)
            .padding(.trailing, controller.inspectorOpen ? CanvasController.inspectorWidth : 0)
        } else if let pulse = controller.pulse, pulse.rate >= 1 {
            CanvasPulseBadge(pulse: pulse).padding(16)
        }
    }
}

/// The zoom controls. The percent changes with every frame of a zoom, so it is read here and not by the plane around it.
private struct CanvasZoomHost: View {
    let controller: CanvasController

    var body: some View {
        CanvasZoomControls(
            percent: controller.percent, strings: controller.strings, canReplay: controller.canReplay, canLatest: controller.hasLatest, replaying: controller.replay != nil,
            onZoom: { controller.zoom(by: $0) }, onReset: controller.resetZoom, onFit: controller.fit, onReplay: controller.startReplay, onLatest: controller.latestTapped
        )
        .padding(16)
        .padding(.trailing, controller.inspectorOpen ? CanvasController.inspectorWidth - 12 : 0)
        .animation(.easeOut(duration: 0.2), value: controller.inspectorOpen)
    }
}

/// Hosts the controller's container, which lives as long as the controller does.
private struct CanvasSurfaceHost: NSViewRepresentable {
    let container: CanvasContainerView
    func makeNSView(context: Context) -> CanvasContainerView { container }
    func updateNSView(_ view: CanvasContainerView, context: Context) {}
}

/// The composer over the next question's slot: as wide as the slot or 520 points, inside the plane (less the inspector).
/// Only the placement modifier reads the anchor, so the camera moving re-places the composer (its content stays opaque to the
/// modifier) without evaluating the composer again.
private struct CanvasNextPanel: View {
    let anchor: CanvasNextAnchor
    let onClose: () -> Void
    let content: AnyView

    var body: some View {
        content
            .environment(\.composerEscape, onClose)
            .modifier(CanvasNextPlacement(anchor: anchor))
            .onExitCommand(perform: onClose)
    }
}

private struct CanvasNextPlacement: ViewModifier {
    let anchor: CanvasNextAnchor

    func body(content: Content) -> some View {
        let slot = anchor.slot, open = anchor.open
        let width = max(120, min(max(slot.width, 520), open - 24))
        let x = min(max(slot.minX, 12), max(12, open - width - 12))
        let y = min(max(slot.minY, 12), max(12, anchor.viewHeight - anchor.height - 12))
        content
            .frame(width: width)
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if anchor.height != $0 { anchor.height = $0 } }
            .offset(x: x, y: y)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
