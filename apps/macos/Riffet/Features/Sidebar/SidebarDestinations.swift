import AppKit
import SwiftUI
import RiffetKit

/// The sidebar's destinations by the ids `AppSettings.sidebarPinned` stores (`SIDEBAR_DESTINATIONS` in
/// `packages/contracts/src/settings.ts`). Ids this Mac does not offer keep their places and are skipped.
extension WorkbenchPage {
    /// The pages this Mac offers, in the catalog's order.
    static let destinations: [WorkbenchPage] = [.tasks, .marks, .plugins, .extensions, .stats, .activity]

    private static let defaultPinned = ["assistant", "tasks", "automations"]

    /// The stored id: 自动化 is `automations` on every client.
    var destinationId: String { self == .tasks ? "automations" : rawValue }

    private static func page(forId id: String) -> WorkbenchPage? { destinations.first { $0.destinationId == id } }

    /// The pinned rows in the saved order, and the 更多 menu's pages in the catalog's.
    static func split(saved: [String]?) -> (pinned: [WorkbenchPage], more: [WorkbenchPage]) {
        let pinned = (saved ?? defaultPinned).compactMap(page(forId:))
        return (pinned, destinations.filter { !pinned.contains($0) })
    }

    /// [saved] with [page] pinned last or unpinned; ids this Mac does not offer keep their places.
    static func toggled(saved: [String]?, page: WorkbenchPage, pinned: Bool) -> [String] {
        let rest = (saved ?? defaultPinned).filter { $0 != page.destinationId }
        return pinned ? rest + [page.destinationId] : rest
    }

    /// [saved] with the pinned pages in the order of [shown] (destination ids); ids this Mac does not offer keep their places.
    static func reordered(saved: [String]?, shown: [String]) -> [String] {
        var queue = shown
        return (saved ?? defaultPinned).map { page(forId: $0) != nil && !queue.isEmpty ? queue.removeFirst() : $0 }
    }
}

extension Workbench {
    var sidebarDestinations: (pinned: [WorkbenchPage], more: [WorkbenchPage]) {
        WorkbenchPage.split(saved: settings?.sidebarPinned)
    }

    /// The 更多 row's menu: the unpinned pages, then 自定义侧栏. The chosen action runs after the menu closes.
    func popUpSidebarMore(_ anchor: MenuAnchor, openSettings: OpenSettingsAction) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var chosen: (() -> Void)?
        for page in sidebarDestinations.more {
            let item = MenuAction.item(page.title, symbol: page.symbol) { chosen = { self.page = page } }
            item.state = self.page == page ? .on : .off
            menu.addItem(item)
        }
        if menu.numberOfItems > 0 { menu.addItem(.separator()) }
        menu.addItem(MenuAction.item(String(localized: "自定义侧栏"), symbol: "slider.horizontal.3") {
            chosen = { SidebarFooterSupport.openSettings(openSettings, on: .sidebar) }
        })
        if anchor.popUp(menu) { chosen?() }
    }
}
