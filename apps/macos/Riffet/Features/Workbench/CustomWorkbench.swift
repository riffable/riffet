import SwiftUI

/// Measures of the drawn window shared by its frame, its header and the workbench's own layout.
@MainActor
enum CustomChrome {
    /// Where the first control after the traffic lights starts, from the window's leading edge. In
    /// the toolbar's title bar (52pt) the lights end at 73pt and sit 26pt down; the compact one
    /// (40pt) draws them 7pt further left and 20pt down.
    static func trafficLights(_ style: StyleSpec) -> CGFloat { style.titleBar == .compact ? 77 : 84 }

    /// How far the traffic lights are moved down from the title bar's middle: beside an inset card
    /// they sit level with the card's header, which starts a card gap below the window's top
    /// (30pt down rather than the toolbar's 26).
    static func trafficLightsDrop(_ style: StyleSpec) -> CGFloat {
        style.window == .insetCard && style.titleBar == .unified ? Space.sm + style.layout.header / 2 - 26 : 0
    }

    /// The drawn sidebar's top row, level with the traffic lights: the header's height, and beside a
    /// card the card's gap above and below it, so its middle is the card header's.
    static func titleRow(_ style: StyleSpec) -> CGFloat {
        style.layout.header + (style.window == .insetCard ? 2 * Space.sm : 0)
    }
    static let sidebarWidths: ClosedRange<Double> = 210...400
    /// The sidebar's width as the reader left it; 0 until dragged, which means the style's own.
    static let sidebarWidthKey = "riffet.sidebar-width"

    static func sidebarWidth(stored: Double, style: StyleSpec) -> CGFloat {
        CGFloat(clamp(stored > 0 ? stored : Double(style.layout.sidebarWidth)))
    }

    /// The header's square controls, a little shorter than the header (28 in a 44pt one).
    static func control(_ style: StyleSpec) -> CGFloat { (style.layout.header * 0.64).rounded() }

    static func clamp(_ width: Double) -> Double {
        min(max(width, sidebarWidths.lowerBound), sidebarWidths.upperBound)
    }
}

extension EnvironmentValues {
    /// The drawn sidebar is on screen; without it the header leaves the traffic lights their room.
    @Entry var customSidebarShown = true
    /// The hidden sidebar is slid out over the content by the pointer at the window's edge; its toggle pins it.
    @Entry var customSidebarPeeking = false
}

/// The main window drawn by the app instead of the system (`StyleSpec.backend == .custom`): the
/// sidebar column, the content and the title bar, laid out by the style's `window` recipe. The
/// conversation, its panel and terminal (`content`) are the same views the native window shows;
/// this only frames them. One structure for every custom style: a recipe changes parameters, so
/// switching between two custom styles rebuilds nothing.
struct CustomWorkbench<Header: View, Content: View>: View {
    let workbench: Workbench
    /// The reader's (or the panel's) choice; the same state the native split view's columns follow.
    let sidebarShown: Bool
    @ViewBuilder let header: Header
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(CustomChrome.sidebarWidthKey) private var storedSidebarWidth: Double = 0
    /// The sidebar's width while its edge is dragged: the column follows, the content waits for the end.
    @State private var draggedWidth: CGFloat?
    /// The hidden sidebar slid out over the content (`use-sidebar-peek.ts`).
    @State private var peeking = false
    @State private var peek = SidebarPeek()

    var body: some View {
        let style = DisplayPreferences.shared.style
        let width = CustomChrome.sidebarWidth(stored: storedSidebarWidth, style: style)
        ZStack(alignment: .leading) {
            // The content takes its width in one step; the sidebar slides over the space it leaves,
            // so the transcript is laid out once, not on every frame of the slide or the drag.
            HStack(spacing: 0) {
                canvas.opacity(draggedWidth == nil ? 0 : 1)
                    .frame(width: sidebarShown ? width : 0)
                main(style).background(style.window == .insetCard ? canvas : .clear)
            }
            if !sidebarShown {
                Color.clear.frame(width: 6).frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .onHover { peek.edge($0) { peeking = true } onClose: { peeking = false } }
            }
            sidebar(style, width: draggedWidth ?? width)
        }
        .environment(\.customSidebarShown, sidebarShown)
        .environment(\.customSidebarPeeking, peeking && !sidebarShown)
        .onChange(of: sidebarShown) { peek.cancel(); peeking = false }
        .onChange(of: peeking) { _, on in
            if on { peek.listenForEscape { peeking = false } } else { peek.stopListening() }
        }
        .ignoresSafeArea(.container)
        // The system toolbar stays, empty and clear: hiding it takes the traffic lights with it, and
        // an empty one may shrink to a bare title bar. Its one item is a point in the middle of the
        // header, where nothing is drawn; elsewhere clicks reach the drawn header under it.
        .toolbar {
            ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) }
                .hideSharedToolbarBackground()
        }
        .toolbar(removing: .title)
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
    }

    /// The sidebar's colour, which a card sits on; a flat window is one sheet, the content's colour.
    /// The column paints its own, so it covers the content as it slides away.
    private var canvas: Color {
        DisplayPreferences.shared.style.window == .flat
            ? palette.bg.opacity(DisplayPreferences.shared.contentTint)
            : palette.bgSidebar.opacity(DisplayPreferences.shared.sidebarTint)
    }

    /// The content beside the sidebar. Beside a card it keeps the gaps; the cards themselves are the
    /// content's (`CustomCard`): the conversation's column, and the side panel as a card of its own.
    private func main(_ style: StyleSpec) -> some View {
        let card = style.window == .insetCard
        return VStack(spacing: 0) {
            header
            content
        }
        .padding(.leading, card && !sidebarShown ? Space.sm : 0)
        .padding([.top, .trailing, .bottom], card ? Space.sm : 0)
        .background(alignment: .top) { WindowDragArea().frame(height: card ? Space.sm : 0) }
    }

    /// Always built: hiding moves it off the window's edge, so its list, scroll position and sheets stay.
    private func sidebar(_ style: StyleSpec, width: CGFloat) -> some View {
        let visible = sidebarShown || peeking
        return CustomSidebar(workbench: workbench)
            .frame(width: width)
            .frame(maxHeight: .infinity)
            // The sidebar's top row is title bar too: its gaps move the window.
            .background(alignment: .top) {
                WindowDragArea().frame(height: CustomChrome.titleRow(style))
            }
            .background(canvas)
            .overlay(alignment: .trailing) {
                SidebarResizeHandle(
                    dragged: $draggedWidth, current: width, drawn: style.window == .flat,
                    commit: { storedSidebarWidth = CustomChrome.clamp($0) }
                )
            }
            .shadow(color: .black.opacity(peeking && !sidebarShown ? 0.16 : 0), radius: 12, x: 2)
            .onHover { if peeking { peek.panel($0) { peeking = false } } }
            .offset(x: visible ? 0 : -(width + Space.sm))
            .opacity(visible || !reduceMotion ? 1 : 0)
            .allowsHitTesting(visible)
            // Off-screen, it must not take Tab focus either; its state stays.
            .disabled(!visible)
            .accessibilityHidden(!visible)
            // A transform only, no layout per frame.
            .transaction(value: visible) { $0.animation = reduceMotion ? Motion.fast : Motion.standard }
    }
}

/// A surface of an `insetCard` window: the content's colour, rounded, with a faint shadow; the colour
/// against the sidebar's is its edge, with no hairline. Off in a drawn window, it changes nothing and cuts nothing, so the modifier stays in place
/// across the custom styles (a page may rise over the header above it). Outside a drawn window
/// (`drawn` false: the native window, a conversation window) it is not applied at all, and the
/// content keeps running up under the toolbar; that choice never changes for a view that exists.
struct CustomCard: ViewModifier {
    let on: Bool
    let drawn: Bool
    @Environment(\.palette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if drawn {
            let shape = CardShape(radius: on ? Radius.floating : 0)
            content
                .clipShape(shape)
                .background(
                    shape.fill(on ? palette.bg.opacity(DisplayPreferences.shared.contentTint) : .clear)
                        .shadow(color: .black.opacity(on ? 0.04 : 0), radius: 6, y: 2)
                )
        } else {
            content
        }
    }
}

/// A rounded rectangle; at radius 0, one far larger than any view, whose clip cuts nothing.
private struct CardShape: InsettableShape {
    let radius: CGFloat
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        guard radius > 0 else { return Path(rect.insetBy(dx: -8192, dy: -8192)) }
        return RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect.insetBy(dx: inset, dy: inset))
    }

    func inset(by amount: CGFloat) -> CardShape {
        var shape = self
        shape.inset += amount
        return shape
    }
}

/// The sidebar's trailing edge: drag to resize. A flat window draws it as the column's hairline;
/// beside a card it is the gap and draws nothing.
private struct SidebarResizeHandle: View {
    @Binding var dragged: CGFloat?
    let current: CGFloat
    let drawn: Bool
    let commit: (Double) -> Void
    @Environment(\.palette) private var palette
    @State private var start: CGFloat?
    @State private var hovering = false

    var body: some View {
        Rectangle()
            .fill(drawn ? (hovering || start != nil ? palette.lineStrong : palette.line) : .clear)
            .frame(width: 1)
            .overlay(
                Color.clear.frame(width: 8)
                    .contentShape(Rectangle())
                    .pointerStyle(.columnResize)
            )
            .onHover { hovering = $0 }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        let origin = start ?? current
                        start = origin
                        dragged = CGFloat(CustomChrome.clamp(Double(origin + value.translation.width)))
                    }
                    .onEnded { _ in
                        if let dragged { commit(Double(dragged)) }
                        dragged = nil
                        start = nil
                    }
            )
            .accessibilityElement()
            .accessibilityLabel("侧栏宽度")
            .accessibilityAdjustableAction { direction in
                commit(Double(current) + (direction == .increment ? 20 : -20))
            }
    }
}

/// The timing of a sidebar peek, as the web's: the pointer rests on the edge for 90 ms to open it, and
/// has been off the panel for 220 ms to close it, later while a popover from inside it is still open.
@MainActor
final class SidebarPeek {
    private var task: Task<Void, Never>?
    private var hovering = false
    private var monitor: Any?

    func cancel() { task?.cancel(); task = nil }

    /// A popover opened from a row is a window of its own; leaving for it must not take its anchor away.
    private var popoverOpen: Bool { NSApp.windows.contains { $0.isVisible && $0.parent != nil } }

    func edge(_ inside: Bool, open: @escaping () -> Void, onClose close: @escaping () -> Void) {
        cancel()
        hovering = inside
        if inside {
            task = Task {
                try? await Task.sleep(for: .milliseconds(90))
                if !Task.isCancelled, hovering { open() }
            }
        } else {
            settle(close)
        }
    }

    func panel(_ inside: Bool, close: @escaping () -> Void) {
        cancel()
        hovering = inside
        if !inside { settle(close) }
    }

    private func settle(_ close: @escaping () -> Void) {
        task = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(220))
                guard !Task.isCancelled, !hovering else { return }
                if popoverOpen { continue }
                close()
                return
            }
        }
    }

    func listenForEscape(_ close: @escaping () -> Void) {
        stopListening()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, self?.popoverOpen == false { close() }
            return event
        }
    }

    func stopListening() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}
