import SwiftUI

// The workbench's sizes come from InterfaceStyles.swift, generated from
// packages/contracts/src/interface-styles.ts; this file holds what is not generated.

/// Corner radii of the workbench.
enum Radius {
    static let control: CGFloat = StyleSpec.riffet.radii.control
    static let container: CGFloat = StyleSpec.riffet.radii.container
    static let card: CGFloat = StyleSpec.riffet.radii.card
    static let floating: CGFloat = StyleSpec.riffet.radii.floating
    /// Menus and popovers: the web's `rounded-xl`, a step under the composer's.
    static let menu: CGFloat = StyleSpec.riffet.radii.menu
}

/// The one text-size ladder. Half-point sizes read as misalignment rather than hierarchy, so a size
/// between two steps settles on the step above. Pure, so the transcript's layout queue uses it too.
nonisolated func ladderTextSize(_ size: CGFloat) -> CGFloat {
    size.rounded(.toNearestOrAwayFromZero)
}
