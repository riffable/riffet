import SwiftUI

/// The plugin background over the workbench: a non-interactive full-bleed layer, so the surfaces
/// underneath keep their layout and their own colours. The image carries its own alpha (a paper
/// grain, say) and `opacity` scales it. Nothing draws when no background is in effect.
struct AppearanceBackdrop: View {
    var body: some View {
        if let layer = AppearanceStore.shared.backgroundLayer {
            Group {
                if layer.tile {
                    Image(nsImage: layer.image).resizable(resizingMode: .tile)
                } else {
                    Color.clear.overlay { Image(nsImage: layer.image).resizable().scaledToFill() }.clipped()
                }
            }
            .opacity(layer.opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}
