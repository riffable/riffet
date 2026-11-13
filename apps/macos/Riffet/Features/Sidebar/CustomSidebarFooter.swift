import AppKit
import SwiftUI
import RiffetKit

/// The foot of the drawn sidebar. A tree keeps the avatar with the server's state beside the pages
/// menu and settings; the time layout names the account and puts its menu behind a chevron.
/// The menus and the status wording are `SidebarFooterSupport`'s.
struct CustomSidebarFooter: View {
    let workbench: Workbench
    let style: StyleSpec
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openSettings) private var openSettings
    @State private var menuAnchor = MenuAnchor()

    var body: some View {
        HStack(spacing: Space.xs) {
            if style.sidebar == .timeGroups { account } else { avatar }
            Spacer(minLength: 0)
            if style.sidebar != .timeGroups {
                Button { menu(pages: WorkbenchPage.footerMenu, profile: false) } label: { Image(icon: "ellipsis") }
                    .buttonStyle(IconButtonStyle())
                    .background(MenuAnchorView(anchor: menuAnchor))
                    .accessibilityLabel("扩展管理、数据统计、活动与外观")
                    .help("扩展管理、数据统计、活动与外观")
            }
            Button { openSettings() } label: { Image(icon: "gearshape") }
                .buttonStyle(IconButtonStyle())
                .overlay(alignment: .topTrailing) {
                    if workbench.backendNotice != nil {
                        Circle().fill(palette.warning).frame(width: 6, height: 6).padding(5).allowsHitTesting(false)
                    }
                }
                .help(settingsHelp)
                .accessibilityLabel(settingsHelp)
        }
        .padding(.leading, style.sidebar == .timeGroups ? 18 : Space.md)
        .padding(.trailing, Space.md)
        .frame(height: style.sidebar == .timeGroups ? 52 : 48)
        .overlay(alignment: .top) {
            if style.sidebar == .timeGroups { palette.lineSoft.frame(height: 1) }
        }
    }

    /// The avatar opens 个人资料; the dot says whether the server answers.
    private var avatar: some View {
        Button { SidebarFooterSupport.openSettings(openSettings, on: .profile) } label: {
            OwnerAvatar(workbench: workbench, size: 26)
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(unhealthy ? palette.warning : palette.success)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().strokeBorder(palette.bgSidebar, lineWidth: 1.5))
                        .offset(x: 2, y: 2)
                }
        }
        .buttonStyle(.plain)
        .help(statusText)
    }

    private var account: some View {
        Button { menu(pages: [], profile: true) } label: {
            HStack(spacing: Space.sm) {
                if workbench.owner != nil {
                    OwnerAvatar(workbench: workbench, size: 22)
                } else {
                    BrandMark(front: palette.fg, back: palette.accent).frame(width: S(style.text.body + 6), height: S(style.text.body + 6))
                }
                Text(workbench.owner?.name ?? "Riffet")
                    .font(.riffet(size: S(style.text.sidebar), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Text(verbatim: "· \(hostName)")
                    .font(.riffet(size: S(style.text.label)))
                    .foregroundStyle(unhealthy ? palette.warning : palette.fg4)
                    .lineLimit(1)
                Image(icon: "chevron.down")
                    .font(.riffet(size: S(style.text.label - 4), weight: .bold))
                    .foregroundStyle(palette.fg4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(MenuAnchorView(anchor: menuAnchor))
        .help(statusText)
    }

    private func menu(pages: [WorkbenchPage], profile: Bool) {
        var entries: [SidebarFooterSupport.Entry] = []
        if profile {
            entries.append(SidebarFooterSupport.Entry(title: String(localized: "个人资料"), symbol: "person.crop.circle") { SidebarFooterSupport.openSettings(openSettings, on: .profile) })
        }
        entries += pages.map { page in SidebarFooterSupport.Entry(title: page.title, symbol: page.symbol) { workbench.page = page } }
        SidebarFooterSupport.popUp(menuAnchor, scheme: scheme, entries: entries)
    }

    private var unhealthy: Bool { SidebarFooterSupport.unhealthy(workbench) }
    private var hostName: String { SidebarFooterSupport.hostName(workbench) }
    private var settingsHelp: String { SidebarFooterSupport.settingsHelp(workbench) }
    private var statusText: String { SidebarFooterSupport.statusText(workbench) }
}
