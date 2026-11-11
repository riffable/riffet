import SwiftUI

// 界面风格: which components the workbench is drawn with. The styles and their recipes are data,
// generated into InterfaceStyles.swift from packages/contracts/src/interface-styles.ts; this file
// holds what is not. A style is independent of the palette (colours), the window material and the
// text size, and is stored on this Mac only, as on Android. Views read `StyleSpec` fields, never
// the identity, so a style that recombines existing forms needs no view code.

extension InterfaceStyle {
    static let defaultValue: InterfaceStyle = .native

    var title: String {
        switch self {
        case .native: String(localized: "原生")
        case .riffet: "Riffet"
        case .claude: "Claude"
        }
    }
}

/// Corner radii of the style on screen. Reading one inside a view's body tracks the style, as `S()`
/// tracks the text size.
@MainActor
enum Radius {
    static var control: CGFloat { DisplayPreferences.shared.style.radii.control }
    static var container: CGFloat { DisplayPreferences.shared.style.radii.container }
    static var card: CGFloat { DisplayPreferences.shared.style.radii.card }
    static var floating: CGFloat { DisplayPreferences.shared.style.radii.floating }
}

extension Palette {
    /// The paper the content sits on. A flat window (`StyleSpec.Window.flat`) sets the conversation,
    /// its panel and its cards on the palette's brightest paper, so the sidebar beside it, on the
    /// page colour, reads a shade darker; elsewhere it is the page colour.
    @MainActor var page: Color { DisplayPreferences.shared.style.window == .flat ? self.bgElevated : self.bg }

    /// The hairline under a drawn title bar: barely there on a flat window, where the sidebar's edge
    /// and the content already divide the window.
    @MainActor var headerRule: Color { DisplayPreferences.shared.style.window == .flat ? self.lineSoft : self.line }
}

/// The one text-size ladder. Half-point sizes read as misalignment rather than hierarchy, so a size
/// between two steps settles on the step above. Pure, so the transcript's layout queue uses it too.
nonisolated func ladderTextSize(_ size: CGFloat) -> CGFloat {
    size.rounded(.toNearestOrAwayFromZero)
}
