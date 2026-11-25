import AppKit
import SwiftUI
import RiffetKit

/// The drawn sidebar's single footer entry opens the shared personal menu.
struct CustomSidebarFooter: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openSettings) private var openSettings
    @State private var menuAnchor = MenuAnchor()

    var body: some View {
        HStack {
            Button { SidebarFooterSupport.popUp(menuAnchor, scheme: scheme, workbench: workbench, openSettings: openSettings) } label: {
                OwnerAvatar(workbench: workbench, size: Space.xl)
                    .overlay(alignment: .bottomTrailing) {
                        if SidebarFooterSupport.unhealthy(workbench) || workbench.backendNotice != nil {
                            Circle()
                                .fill(palette.warning)
                                .frame(width: Space.sm, height: Space.sm)
                                .overlay(Circle().strokeBorder(palette.bgSidebar, lineWidth: 1))
                                .allowsHitTesting(false)
                        }
                    }
            }
            // A ring around the avatar, as the web's `rounded-full`, not the square wash of the icon buttons.
            .buttonStyle(IconButtonStyle(size: Space.xl + Space.xs, round: true))
            .background(MenuAnchorView(anchor: menuAnchor))
            .help(SidebarFooterSupport.menuHelp(workbench))
            .accessibilityLabel(SidebarFooterSupport.menuHelp(workbench))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.md)
        .frame(height: 48)
    }
}
