import SwiftUI

/// Measures of the drawn window shared by its frame, its header and the workbench's own layout.
@MainActor
enum CustomChrome {
    /// Where the first control after the traffic lights starts, from the window's leading edge. In
    /// the toolbar's title bar (52pt) the lights end at 73pt and sit 26pt down.
    static let trafficLights: CGFloat = 84

    /// How far the traffic lights are moved down from the title bar's middle: they sit level with
    /// the card's header, which starts a card gap below the window's top (30pt down rather than the
    /// toolbar's 26).
    static func trafficLightsDrop(_ style: StyleSpec) -> CGFloat {
        Space.sm + style.layout.header / 2 - 26
    }

    /// The drawn sidebar's top row, level with the traffic lights: the header's height and the
    /// card's gap above and below it, so its middle is the card header's.
    static func titleRow(_ style: StyleSpec) -> CGFloat {
        style.layout.header + 2 * Space.sm
    }
    static let sidebarWidths: ClosedRange<Double> = 210...400
    /// The sidebar's width as the reader left it; 0 until dragged, which means the style's own.
    static let sidebarWidthKey = "riffet.sidebar-width"

    static func sidebarWidth(stored: Double, style: StyleSpec) -> CGFloat {
        CGFloat(clamp(stored > 0 ? stored : Double(style.layout.sidebarWidth)))
    }

    /// The header's square controls, a little shorter than the header (28 in a 44pt one).
    static func control(_ style: StyleSpec) -> CGFloat { (style.layout.header * 0.64).rounded() }

    /// The sidebar's slide, shared by the sidebar and the content beside it so they move as one.
    static let sidebarMotion = Motion.slide

    static func clamp(_ width: Double) -> Double {
        min(max(width, sidebarWidths.lowerBound), sidebarWidths.upperBound)
    }
}

/// Whether the drawn sidebar shows, apart from the view that owns it so that only the views drawing
/// the sidebar's room re-render when it changes.
@MainActor
@Observable
final class SidebarState {
    var shown: Bool
    /// Slides under way (sidebar, side panel, terminal): while one runs the window's views take no pointer.
    private(set) var sliding = 0
    @ObservationIgnored private var slides: Set<Int> = []
    @ObservationIgnored private var nextSlide = 0

    init(shown: Bool) { self.shown = shown }

    func beginSlide() -> Int {
        nextSlide += 1
        slides.insert(nextSlide)
        sliding = slides.count
        return nextSlide
    }

    /// Ends [slide] once: from its animation's completion or, should that never come (the window
    /// closed mid-slide), from a fallback after its duration, so the window never stays unclickable.
    func endSlide(_ slide: Int) {
        guard slides.remove(slide) != nil else { return }
        sliding = slides.count
    }
}

/// Nothing under the pointer moves into or out of a hover while the sidebar slides: hit-testing every
/// hover region again on each frame cost more than drawing it. Its own view, so that the count
/// changing at the slide's start and end re-renders this modifier only.
private struct SlideHitTesting: ViewModifier {
    let sidebar: SidebarState

    func body(content: Content) -> some View {
        content.allowsHitTesting(sidebar.sliding == 0)
    }
}

extension EnvironmentValues {
    /// The drawn sidebar is on screen; without it the header leaves the traffic lights their room.
    @Entry var customSidebarShown = true
    /// The hidden sidebar is slid out over the content by the pointer at the window's edge; its toggle pins it.
    @Entry var customSidebarPeeking = false
}

/// The main window drawn by the app instead of the system: the sidebar column beside the content,
/// which sits in inset cards on the window's canvas. The conversation, its panel and terminal
/// (`content`) are the same views a conversation window shows; this only frames them.
struct CustomWorkbench<Content: View>: View {
    let workbench: Workbench
    /// The reader's (or the panel's) choice.
    let sidebar: SidebarState
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(CustomChrome.sidebarWidthKey) private var storedSidebarWidth: Double = 0
    /// The sidebar's width while its edge is dragged: the column follows, the content waits for the end.
    @State private var draggedWidth: CGFloat?
    /// The hidden sidebar slid out over the content (`use-sidebar-peek.ts`).
    @State private var peeking = false
    @State private var peek = SidebarPeek()

    private var sidebarShown: Bool { sidebar.shown }

    var body: some View {
        let style = DisplayPreferences.shared.style
        let width = CustomChrome.sidebarWidth(stored: storedSidebarWidth, style: style)
        ZStack(alignment: .leading) {
            PaletteCanvasBackground(opacity: DisplayPreferences.shared.sidebarTint)
            // The content follows the sliding sidebar frame by frame (the toggle's animation); a
            // drag of the sidebar's edge moves only the sidebar, and the content waits for its end.
            HStack(spacing: 0) {
                Color.clear
                    .frame(width: sidebarShown ? width : 0)
                main
            }
            if !sidebarShown {
                Color.clear.frame(width: 6).frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .onHover { peek.edge($0) { peeking = true } onClose: { peeking = false } }
            }
            sidebar(style, width: draggedWidth ?? width)
        }
        .modifier(SlideHitTesting(sidebar: sidebar))
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

    /// The sidebar's background: docked, the full-window canvas shows through so there is no seam;
    /// sliding, peeking or dragging over the content, it paints its own.
    @ViewBuilder
    private var sidebarBackdrop: some View {
        if !sidebarShown || peeking || draggedWidth != nil {
            PaletteCanvasBackground(opacity: DisplayPreferences.shared.sidebarTint)
        } else {
            Color.clear
        }
    }

    /// The content beside the sidebar, keeping the card gaps; the cards themselves are the content's
    /// (`CustomCard`): the conversation's column, and the side panel as a card of its own.
    private var main: some View {
        content
            .padding(.leading, sidebarShown ? 0 : Space.sm)
            .padding([.top, .trailing, .bottom], Space.sm)
            .background(alignment: .top) { WindowDragArea().frame(height: Space.sm) }
    }

    /// Always built: hiding moves it off the window's edge, so its list, scroll position and sheets stay.
    private func sidebar(_ style: StyleSpec, width: CGFloat) -> some View {
        let visible = sidebarShown || peeking
        // Compared by its workbench: this body runs on every toggle, and the list (each row and its
        // menu) need not be rebuilt for a change of place.
        return CustomSidebar(workbench: workbench).equatable()
            .frame(width: width)
            .frame(maxHeight: .infinity)
            // The sidebar's top row is title bar too: its gaps move the window.
            .background(alignment: .top) {
                WindowDragArea().frame(height: CustomChrome.titleRow(style))
            }
            .background { sidebarBackdrop }
            .overlay(alignment: .trailing) {
                SidebarResizeHandle(
                    dragged: $draggedWidth, current: width,
                    commit: { storedSidebarWidth = CustomChrome.clamp($0) },
                    reset: { storedSidebarWidth = 0 }
                )
            }
            .elevation(peeking && !sidebarShown ? .peek : nil)
            .onHover { if peeking { peek.panel($0) { peeking = false } } }
            .offset(x: visible ? 0 : -(width + Space.sm))
            .opacity(visible || !reduceMotion ? 1 : 0)
            .allowsHitTesting(visible)
            // Off-screen, it must not take Tab focus either; its state stays.
            .disabled(!visible)
            .accessibilityHidden(!visible)
            // The same curve as the content's (`CustomChrome.sidebarMotion`); peeking slides it alone.
            .transaction(value: visible) { $0.animation = reduceMotion ? Motion.fast : CustomChrome.sidebarMotion }
    }
}

/// A card of the drawn window: the content's colour, rounded, with a faint shadow; the colour
/// against the sidebar's is its edge, with no hairline. Outside a drawn window (`drawn` false: a
/// conversation window) it is not applied at all, and the content keeps running up under the
/// toolbar; that choice never changes for a view that exists.
struct CustomCard: ViewModifier {
    let drawn: Bool
    @Environment(\.palette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if drawn {
            let shape = RoundedRectangle(cornerRadius: Radius.floating, style: .continuous)
            let fillOpacity = DisplayPreferences.shared.contentTint * palette.cardOpacity
            content
                .clipShape(shape)
                .background(
                    shape.fill(palette.bg.opacity(fillOpacity))
                        .elevation(fillOpacity > 0.05 ? .raised : nil)
                )
        } else {
            content
        }
    }
}

/// The sidebar's trailing edge: drag to resize. It is the gap beside the card and draws nothing.
private struct SidebarResizeHandle: View {
    @Binding var dragged: CGFloat?
    let current: CGFloat
    let commit: (Double) -> Void
    /// A double-click: back to the style's own width.
    let reset: () -> Void
    @State private var start: CGFloat?

    var body: some View {
        Color.clear
            .frame(width: 1)
            .overlay(
                Color.clear.frame(width: 8)
                    .contentShape(Rectangle())
                    .pointerStyle(.columnResize)
            )
            .onTapGesture(count: 2, perform: reset)
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
