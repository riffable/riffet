import AppKit

/// What the page asks of whoever draws the canvas: the surface items and the ground decorations for a layout.
/// The page never paints; swapping the implementation (`CanvasNodesScene` today) changes nothing else.
@MainActor
protocol CanvasScene: AnyObject {
    var renderer: SurfaceRenderer { get }
    /// One item per node (and the slot for the next question), ids being the node ids of the layout.
    func items(for layout: CanvasLayout, state: CanvasPaintState) -> [SurfaceItem]
    /// Edges, frames, track lines and the like, under the items.
    func decorations(for layout: CanvasLayout, state: CanvasPaintState) -> [SurfaceDecoration]
    /// The theme, the language or the fonts changed: every bitmap is stale.
    func invalidate(palette: RiffetPaletteValues, dark: Bool, faces: CanvasFaces)
    /// The output rate of each running turn, by run id; the cards that show one are stale on the next `items`.
    func setPulses(_ pulses: [String: CanvasPulse])
}

extension CanvasFaces {
    /// The families the interface style and an appearance plugin name now (read on the main thread; the value is usable anywhere).
    @MainActor
    static func current() -> CanvasFaces {
        let plugin = AppearanceStore.shared.fonts
        let style = DisplayPreferences.shared.style.fonts
        func family(_ resolved: ResolvedFont?, _ name: String) -> String? {
            resolved?.family ?? (name == "system" ? nil : BundledFonts.faces[name]?.family)
        }
        return CanvasFaces(ui: family(plugin.ui, style.ui), mono: family(plugin.mono, style.mono))
    }
}

/// What changes how the canvas looks without changing its layout.
struct CanvasPaintState: Equatable {
    var selected: String?
    /// The hovered card's column, or the cards and edges a hovered file links; nil when nothing is hovered.
    var related: Set<String>?
    var hovered: String?
    /// The card under the pointer, at once (the hover column above follows after a rest).
    var pointer: String?
    /// The file hovered across ledgers.
    var focusPath: String?
    /// The call of a strip or bar under the pointer.
    var marked: Mark?
    /// A question sent from the slot, standing until its turn comes.
    var sending = false
    /// Replay shows what had happened by this time (epoch milliseconds); infinity outside replay.
    var cutoff = Double.infinity
    /// Zoomed out so far that cards are blocks: the slot and the edge to it are not drawn.
    var far = false
    var replaying = false

    struct Mark: Equatable { var node: String, index: Int }
}
