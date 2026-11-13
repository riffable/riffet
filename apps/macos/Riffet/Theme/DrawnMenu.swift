import AppKit

// 菜单配方: under `style.menu == .drawn` an NSMenu popped up from the app's own controls is shown
// as a drawn panel instead of the system's Liquid Glass menu. The menu object is the same one the
// call site built; this file only presents it. Right-click `.contextMenu`s stay the system's.
//
// The panel is a non-activating borderless window and never becomes key, so the window underneath
// keeps its first responder. Like NSMenu's own tracking, `popUp` runs a nested event loop and
// returns once the menu is dismissed, with the chosen item's action already fired. Events are
// read from that loop and are not forwarded to other windows while the menu is open.

extension NSMenu {
    /// `popUp(positioning:at:in:)`, drawn when the style's menu recipe says so. A menu with a
    /// custom item view (`NSMenuItem.view`) stays the system's.
    @MainActor
    @discardableResult
    func popUpStyled(at point: NSPoint, in view: NSView) -> Bool {
        if DisplayPreferences.shared.style.menu == .drawn, view.window != nil, !DrawnMenu.hasCustomView(self) {
            return DrawnMenu.popUp(self, at: point, in: view)
        }
        return popUp(positioning: nil, at: point, in: view)
    }
}

@MainActor
enum DrawnMenu {
    static func hasCustomView(_ menu: NSMenu) -> Bool {
        menu.items.contains { $0.view != nil || ($0.submenu.map(hasCustomView) ?? false) }
    }

    /// Shows [menu] under [point] in [view] (the NSMenu convention: the menu's top left corner) and
    /// returns whether an item was chosen. The item's action has run by then.
    static func popUp(_ menu: NSMenu, at point: NSPoint, in view: NSView) -> Bool {
        guard let window = view.window else { return false }
        let session = MenuSession(root: menu, view: view, window: window, point: point)
        return session.run()
    }
}

private enum MenuMetric {
    static let pad: CGFloat = 4
    static let rowHeight: CGFloat = 32
    static let subtitleRowHeight: CGFloat = 44
    static let headerHeight: CGFloat = 28
    static let separatorHeight: CGFloat = 9
    static let inset: CGFloat = 10
    static let gap: CGFloat = 10
    static let icon: CGFloat = 14
    static let minWidth: CGFloat = 176
    static let maxWidth: CGFloat = 360
    /// Room around the card for its shadow, which the panel draws itself.
    static let shadowMargin: CGFloat = 44
    static let submenuDelay: TimeInterval = 0.2
}

/// The style's menu colours, fonts and radii, read once per pop-up.
@MainActor
private struct MenuLook {
    let body: NSFont
    let small: NSFont
    let bg: NSColor
    let hover: NSColor
    let fg: NSColor
    let fg3: NSColor
    let fg4: NSColor
    let line: NSColor
    let border: NSColor
    let radius: CGFloat
    let rowRadius: CGFloat
    /// A raised surface lifts the card the way the web's `--shadow-pop` does; an outlined one keeps its warm shadow.
    let raised: Bool

    init() {
        let style = DisplayPreferences.shared.style
        let palette = ThemeStore.shared.palette
        func font(_ size: CGFloat) -> NSFont { .riffet(size: size) }
        body = font(S(style.text.body))
        small = font(S(12))
        bg = palette.nsColor(\.bgPopover)
        hover = palette.nsColor(\.bgHover)
        fg = palette.nsColor(\.fg)
        fg3 = palette.nsColor(\.fg3)
        fg4 = palette.nsColor(\.fg4)
        line = palette.nsColor(\.line)
        border = style.surface == .outlined ? palette.nsColor(\.lineStrong) : palette.nsColor(\.line)
        radius = style.radii.menu
        // A row's corner nests inside the card's, which is padded by `MenuMetric.pad`.
        rowRadius = min(style.radii.container, max(4, style.radii.menu - MenuMetric.pad))
        raised = style.surface == .raised
    }

    func attributed(_ text: String, font: NSFont, color: NSColor) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        return NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
    }

    /// A template image drawn in [color]; other images (swatches, coloured symbols) stay as they are.
    func tinted(_ image: NSImage, _ color: NSColor) -> NSImage {
        guard image.isTemplate else { return image }
        return NSImage(size: image.size, flipped: false) { rect in
            image.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
    }
}

private struct MenuRow {
    enum Kind { case item, separator, header }

    var kind: Kind
    var menuIndex = 0
    var enabled = false
    var hasSubmenu = false
    var checked = false
    var title = ""
    var titleText: NSAttributedString?
    var subtitleText: NSAttributedString?
    var keyText: NSAttributedString?
    var icon: NSImage?
    var y: CGFloat = 0
    var height: CGFloat = 0

    var selectable: Bool { kind == .item && enabled }
}

/// One row as an accessibility element, read from the list when asked.
@MainActor
private final class MenuRowElement: NSAccessibilityElement {
    private weak var list: MenuRowsView?
    private let index: Int

    init(list: MenuRowsView, index: Int) {
        self.list = list
        self.index = index
        super.init()
    }

    private var row: MenuRow? { list.flatMap { $0.rows.indices.contains(index) ? $0.rows[index] : nil } }

    override func accessibilityRole() -> NSAccessibility.Role? { row?.kind == .header ? .staticText : .menuItem }
    override func accessibilityLabel() -> String? { row?.title }
    override func accessibilityHelp() -> String? { row?.subtitleText?.string }
    override func isAccessibilityEnabled() -> Bool { row.map { $0.kind == .header || $0.enabled } ?? false }
    override func isAccessibilitySelected() -> Bool { list?.highlight == index }
    override func accessibilityValue() -> Any? { row?.checked == true ? "✓" : nil }
    override func isAccessibilityFocused() -> Bool { list?.highlight == index }
    override func accessibilityParent() -> Any? { list }
    override func accessibilityFrame() -> NSRect {
        guard let list, let window = list.window, list.rows.indices.contains(index) else { return .zero }
        return window.convertToScreen(list.convert(list.rect(index), to: nil))
    }

    override func accessibilityChildren() -> [Any]? {
        guard row?.hasSubmenu == true, let submenu = list?.submenuList?(index) else { return nil }
        return [submenu]
    }

    override func accessibilityPerformPress() -> Bool {
        guard row?.selectable == true, let list else { return false }
        list.onPress?(index)
        return true
    }
}

private final class DrawnMenuPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// The card: fill, border and shadow as one static layer, so hovering never repaints them.
private final class MenuCardView: NSView {
    private let look: MenuLook

    @MainActor
    init(look: MenuLook, size: CGSize) {
        self.look = look
        super.init(frame: NSRect(origin: .zero, size: size))
        wantsLayer = true
        guard let layer else { return }
        layer.cornerRadius = look.radius
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.masksToBounds = false
        layer.shadowRadius = look.raised ? 12 : 20
        layer.shadowOffset = CGSize(width: 0, height: look.raised ? -8 : -12)
        layer.shadowOpacity = 1
        layer.shadowPath = CGPath(roundedRect: NSRect(origin: .zero, size: size), cornerWidth: look.radius, cornerHeight: look.radius, transform: nil)
        refreshColors()
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshColors()
    }

    private func refreshColors() {
        guard let layer else { return }
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer.backgroundColor = look.bg.cgColor
            layer.borderColor = look.border.cgColor
            layer.shadowColor = (dark ? NSColor.black.withAlphaComponent(look.raised ? 0.55 : 0.5)
                : look.raised ? NSColor(srgbRed: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 0.14)
                : NSColor(srgbRed: 60 / 255, green: 50 / 255, blue: 40 / 255, alpha: 0.16)).cgColor
        }
    }
}

/// The rows of one menu level, drawn in one pass; hover and keyboard moves repaint two rows.
private final class MenuRowsView: NSView {
    let rows: [MenuRow]
    let look: MenuLook
    let hasIcons: Bool
    let trailingWidth: CGFloat
    let contentHeight: CGFloat
    private(set) var scrollY: CGFloat = 0
    var highlight: Int? {
        didSet {
            guard highlight != oldValue else { return }
            for index in [oldValue, highlight] { if let index { setNeedsDisplay(rect(index).insetBy(dx: -1, dy: -1)) } }
        }
    }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    /// Set by the session: fires the item at a row (VoiceOver's press), and finds a row's open submenu.
    var onPress: ((Int) -> Void)?
    var submenuList: ((Int) -> MenuRowsView?)?
    private var elements: [Int: MenuRowElement] = [:]

    // The list is the menu; its rows are menu items. Elements are made on first ask, so with
    // VoiceOver off nothing is created.
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .menu }
    override func accessibilityChildren() -> [Any]? { rows.indices.compactMap(element) }

    func element(_ index: Int) -> MenuRowElement? {
        guard rows.indices.contains(index), rows[index].kind != .separator else { return nil }
        if let element = elements[index] { return element }
        let element = MenuRowElement(list: self, index: index)
        elements[index] = element
        return element
    }

    /// Tells assistive technology the keyboard moved to [index].
    func announce(_ index: Int) {
        guard NSWorkspace.shared.isVoiceOverEnabled, let element = element(index) else { return }
        NSAccessibility.post(element: element, notification: .focusedUIElementChanged)
        NSAccessibility.post(element: self, notification: .selectedChildrenChanged)
    }

    @MainActor
    init(rows: [MenuRow], look: MenuLook, hasIcons: Bool, trailingWidth: CGFloat, contentHeight: CGFloat, size: CGSize) {
        self.rows = rows
        self.look = look
        self.hasIcons = hasIcons
        self.trailingWidth = trailingWidth
        self.contentHeight = contentHeight
        super.init(frame: NSRect(origin: .zero, size: size))
    }

    required init?(coder: NSCoder) { fatalError() }

    func rect(_ index: Int) -> NSRect {
        NSRect(x: MenuMetric.pad, y: MenuMetric.pad + rows[index].y - scrollY, width: bounds.width - 2 * MenuMetric.pad, height: rows[index].height)
    }

    func row(atLocalY y: CGFloat) -> Int? {
        guard y >= MenuMetric.pad, y <= bounds.height - MenuMetric.pad else { return nil }
        let content = y - MenuMetric.pad + scrollY
        return rows.firstIndex { content >= $0.y && content < $0.y + $0.height }
    }

    func scroll(by delta: CGFloat) {
        scrollTo(scrollY + delta)
    }

    private func scrollTo(_ value: CGFloat) {
        let next = min(max(0, value), max(0, contentHeight - bounds.height))
        guard next != scrollY else { return }
        scrollY = next
        needsDisplay = true
    }

    func reveal(_ index: Int) {
        let r = rect(index)
        if r.minY < MenuMetric.pad { scroll(by: r.minY - MenuMetric.pad) }
        else if r.maxY > bounds.height - MenuMetric.pad { scroll(by: r.maxY - (bounds.height - MenuMetric.pad)) }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSBezierPath(rect: NSRect(x: 0, y: MenuMetric.pad, width: bounds.width, height: bounds.height - 2 * MenuMetric.pad)).addClip()
        for index in rows.indices {
            let r = rect(index)
            guard r.maxY >= dirtyRect.minY, r.minY <= dirtyRect.maxY else { continue }
            let row = rows[index]
            switch row.kind {
            case .separator:
                look.line.setFill()
                NSRect(x: r.minX, y: r.midY - 0.5, width: r.width, height: 1).fill()
            case .header:
                guard let text = row.titleText else { continue }
                let height = ceil(text.size().height)
                text.draw(with: NSRect(x: r.minX + MenuMetric.inset, y: r.midY - height / 2, width: r.width - 2 * MenuMetric.inset, height: height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
            case .item:
                drawItem(row, in: r, highlighted: index == highlight)
            }
        }
    }

    private func drawItem(_ row: MenuRow, in r: NSRect, highlighted: Bool) {
        if highlighted, row.selectable {
            look.hover.setFill()
            let radius = min(look.rowRadius, r.height / 2)
            NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()
        }
        var left = r.minX + MenuMetric.inset
        if hasIcons {
            if let icon = row.icon {
                let image = look.tinted(icon, row.enabled ? look.fg3 : look.fg4)
                let scale = min(MenuMetric.icon / max(image.size.width, 1), MenuMetric.icon / max(image.size.height, 1), 1.2)
                let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
                let box = NSRect(x: left + (MenuMetric.icon - size.width) / 2, y: r.midY - size.height / 2, width: size.width, height: size.height)
                image.draw(in: box, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
            left += MenuMetric.icon + MenuMetric.gap
        }
        var right = r.maxX - MenuMetric.inset
        if trailingWidth > 0 {
            if row.hasSubmenu {
                drawSymbol("chevron.right", weight: .semibold, size: 11, color: look.fg3, rightEdge: right, midY: r.midY)
            } else if row.checked {
                drawSymbol("checkmark", weight: .semibold, size: 12, color: row.enabled ? look.fg : look.fg4, rightEdge: right, midY: r.midY)
            } else if let key = row.keyText {
                let size = key.size()
                key.draw(at: NSPoint(x: right - ceil(size.width), y: r.midY - size.height / 2))
            }
            right -= trailingWidth + MenuMetric.gap
        }
        guard let title = row.titleText else { return }
        let width = max(0, right - left)
        let titleHeight = ceil(title.size().height)
        if let subtitle = row.subtitleText {
            let subtitleHeight = ceil(subtitle.size().height)
            let top = r.midY - (titleHeight + subtitleHeight) / 2
            title.draw(with: NSRect(x: left, y: top, width: width, height: titleHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
            subtitle.draw(with: NSRect(x: left, y: top + titleHeight, width: width, height: subtitleHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        } else {
            title.draw(with: NSRect(x: left, y: r.midY - titleHeight / 2, width: width, height: titleHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
    }

    private func drawSymbol(_ name: String, weight: NSFont.Weight, size: CGFloat, color: NSColor, rightEdge: CGFloat, midY: CGFloat) {
        guard let symbol = NSImage.icon(name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: size, weight: weight)) else { return }
        let image = look.tinted(symbol, color)
        let box = NSRect(x: rightEdge - image.size.width, y: midY - image.size.height / 2, width: image.size.width, height: image.size.height)
        image.draw(in: box, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}

/// One open menu: its panel, card and rows.
@MainActor
private final class MenuLevel {
    let menu: NSMenu
    let panel: DrawnMenuPanel
    let list: MenuRowsView
    /// The row whose submenu is open as the next level.
    var openRow: Int?

    var cardFrame: NSRect { panel.frame.insetBy(dx: MenuMetric.shadowMargin, dy: MenuMetric.shadowMargin) }

    init(menu: NSMenu, look: MenuLook, maxHeight: CGFloat, appearance: NSAppearance) {
        self.menu = menu
        menu.update()

        var rows: [MenuRow] = []
        var y: CGFloat = 0
        var hasIcons = false
        var trailing: CGFloat = 0
        var textWidth: CGFloat = 0
        for (index, item) in menu.items.enumerated() where !item.isHidden {
            var row: MenuRow
            if item.isSeparatorItem {
                row = MenuRow(kind: .separator)
                row.height = MenuMetric.separatorHeight
            } else if item.isSectionHeader {
                row = MenuRow(kind: .header)
                row.title = item.title
                row.titleText = look.attributed(item.title, font: look.small, color: look.fg3)
                row.height = MenuMetric.headerHeight
                textWidth = max(textWidth, row.titleText?.size().width ?? 0)
            } else {
                row = MenuRow(kind: .item)
                row.enabled = item.isEnabled
                row.hasSubmenu = item.submenu != nil
                row.checked = item.state == .on
                row.icon = item.image
                row.title = item.title
                row.titleText = look.attributed(item.title, font: look.body, color: item.isEnabled ? look.fg : look.fg4)
                var width = row.titleText?.size().width ?? 0
                if let subtitle = item.subtitle, !subtitle.isEmpty {
                    row.subtitleText = look.attributed(subtitle, font: look.small, color: look.fg3)
                    width = max(width, row.subtitleText?.size().width ?? 0)
                    row.height = MenuMetric.subtitleRowHeight
                } else {
                    row.height = MenuMetric.rowHeight
                }
                textWidth = max(textWidth, width)
                if let key = Self.keyText(item) {
                    row.keyText = look.attributed(key, font: look.small, color: look.fg4)
                    trailing = max(trailing, row.keyText?.size().width ?? 0)
                }
                if row.hasSubmenu || row.checked { trailing = max(trailing, 14) }
                hasIcons = hasIcons || item.image != nil
            }
            row.menuIndex = index
            row.y = y
            y += row.height
            rows.append(row)
        }
        let contentHeight = y + 2 * MenuMetric.pad
        trailing = ceil(trailing)
        var width = 2 * MenuMetric.pad + 2 * MenuMetric.inset + ceil(textWidth) + (hasIcons ? MenuMetric.icon + MenuMetric.gap : 0) + (trailing > 0 ? trailing + MenuMetric.gap : 0)
        width = min(max(width, MenuMetric.minWidth), MenuMetric.maxWidth)
        let size = CGSize(width: width, height: min(contentHeight, maxHeight))

        let margin = MenuMetric.shadowMargin
        let panel = DrawnMenuPanel(contentRect: NSRect(x: 0, y: 0, width: size.width + 2 * margin, height: size.height + 2 * margin), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .popUpMenu
        panel.animationBehavior = .none
        panel.hidesOnDeactivate = false
        panel.acceptsMouseMovedEvents = true
        panel.collectionBehavior = [.fullScreenAuxiliary, .transient]
        panel.appearance = appearance
        let container = NSView(frame: NSRect(origin: .zero, size: panel.frame.size))
        let card = MenuCardView(look: look, size: size)
        card.frame.origin = NSPoint(x: margin, y: margin)
        let list = MenuRowsView(rows: rows, look: look, hasIcons: hasIcons, trailingWidth: trailing, contentHeight: contentHeight, size: size)
        card.addSubview(list)
        container.addSubview(card)
        panel.contentView = container
        self.panel = panel
        self.list = list
    }

    var size: CGSize { list.bounds.size }

    func place(cardTopLeft: NSPoint) {
        let margin = MenuMetric.shadowMargin
        panel.setFrameOrigin(NSPoint(x: cardTopLeft.x - margin, y: cardTopLeft.y - size.height - margin))
        panel.orderFrontRegardless()
    }

    func close() { panel.orderOut(nil) }

    /// The row under a screen point: `nil` outside the card, `.some(nil)` on its padding.
    func hit(_ point: NSPoint) -> Int?? {
        let card = cardFrame
        guard card.contains(point) else { return nil }
        let local = NSPoint(x: point.x - card.minX, y: card.maxY - point.y)
        guard local.x >= MenuMetric.pad, local.x <= card.width - MenuMetric.pad else { return .some(nil) }
        return .some(list.row(atLocalY: local.y))
    }

    func selectable(_ index: Int) -> Bool { list.rows.indices.contains(index) && list.rows[index].selectable }

    func step(_ direction: Int) {
        let rows = list.rows
        guard !rows.isEmpty else { return }
        var index = list.highlight ?? (direction > 0 ? -1 : rows.count)
        for _ in rows.indices {
            index = (index + direction + rows.count) % rows.count
            if rows[index].selectable { highlight(index, announce: true); return }
        }
    }

    func highlight(_ index: Int?, announce: Bool = false) {
        list.highlight = index
        if let index {
            list.reveal(index)
            if announce { list.announce(index) }
        }
    }

    /// Jumps to the next enabled item whose title starts with [prefix], after the current one.
    func jump(to prefix: String) {
        let rows = list.rows
        let start = (list.highlight ?? -1) + 1
        for offset in rows.indices {
            let index = (start + offset) % rows.count
            if rows[index].selectable, rows[index].title.lowercased().hasPrefix(prefix) { highlight(index, announce: true); return }
        }
    }

    private static func keyText(_ item: NSMenuItem) -> String? {
        let key = item.keyEquivalent
        guard !key.isEmpty else { return nil }
        let mask = item.keyEquivalentModifierMask
        var text = ""
        if mask.contains(.control) { text += "⌃" }
        if mask.contains(.option) { text += "⌥" }
        if mask.contains(.shift) { text += "⇧" }
        if mask.contains(.command) { text += "⌘" }
        switch key {
        case "\r": text += "↩"
        case "\u{7f}", "\u{8}": text += "⌫"
        case "\u{1b}": text += "⎋"
        case "\t": text += "⇥"
        case " ": text += "Space"
        default: text += key.uppercased()
        }
        return text
    }
}

/// One pop-up: the stack of open levels and the nested event loop that drives them.
@MainActor
private final class MenuSession {
    private let root: NSMenu
    private weak var anchor: NSView?
    private let window: NSWindow
    private let point: NSPoint
    private let look = MenuLook()
    private let visible: NSRect
    private var levels: [MenuLevel] = []
    private var chosen: (menu: NSMenu, index: Int)?
    private var done = false
    private var pressed = false
    private var pending: (level: MenuLevel, row: Int, due: Date)?
    private var observers: [NSObjectProtocol] = []
    private var globalMonitor: Any?

    init(root: NSMenu, view: NSView, window: NSWindow, point: NSPoint) {
        self.root = root
        anchor = view
        self.window = window
        self.point = point
        visible = ((window.screen ?? NSScreen.main)?.visibleFrame ?? window.frame).insetBy(dx: 8, dy: 8)
    }

    func run() -> Bool {
        guard let anchor else { return false }
        let level = MenuLevel(menu: root, look: look, maxHeight: visible.height, appearance: window.effectiveAppearance)
        let origin = window.convertPoint(toScreen: anchor.convert(point, to: nil))
        let anchorRect = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
        let size = level.size
        var top = origin.y
        if top - size.height < visible.minY {
            // No room below: above the anchor, or pinned to the screen's bottom if that does not fit either.
            let above = anchorRect.maxY + 4 + size.height
            top = above <= visible.maxY ? above : visible.minY + size.height
        }
        let x = min(max(origin.x, visible.minX), visible.maxX - size.width)
        level.place(cardTopLeft: NSPoint(x: x, y: top))
        levels = [level]
        wire(level)
        if NSWorkspace.shared.isVoiceOverEnabled { NSAccessibility.post(element: level.list, notification: .created) }

        NotificationCenter.default.post(name: NSMenu.didBeginTrackingNotification, object: root)
        installDismissals()
        while !done {
            let event = NSApp.nextEvent(matching: .any, until: pending?.due ?? .distantFuture, inMode: .eventTracking, dequeue: true)
            if let due = pending, due.due <= Date() {
                pending = nil
                openSubmenu(of: due.level, row: due.row, selectFirst: false)
            }
            if let event { handle(event) }
        }
        teardown()
        NotificationCenter.default.post(name: NSMenu.didEndTrackingNotification, object: root)
        guard let chosen else { return false }
        chosen.menu.performActionForItem(at: chosen.index)
        return true
    }

    // MARK: Ending

    private func finish(_ choice: (menu: NSMenu, index: Int)? = nil) {
        chosen = choice
        done = true
        // A nextEvent blocked without a deadline needs something to wake it.
        if let wake = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) {
            NSApp.postEvent(wake, atStart: true)
        }
    }

    private func installDismissals() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish() }
        }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish() }
        })
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish() }
        })
    }

    private func teardown() {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        globalMonitor = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        levels.forEach { $0.close() }
        levels = []
        pending = nil
    }

    // MARK: Events

    private func screenPoint(_ event: NSEvent) -> NSPoint {
        event.window.map { $0.convertPoint(toScreen: event.locationInWindow) } ?? NSEvent.mouseLocation
    }

    private func hit(_ point: NSPoint) -> (level: MenuLevel, row: Int?)? {
        for level in levels.reversed() {
            if let row = level.hit(point) { return (level, row) }
        }
        return nil
    }

    private func handle(_ event: NSEvent) {
        switch event.type {
        case .keyDown:
            key(event)
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            let location = screenPoint(event)
            guard let target = hit(location) else { finish(); return }
            if event.type == .leftMouseDown {
                pressed = true
                hover(target.level, target.row)
            }
        case .leftMouseUp:
            guard pressed else { return }
            pressed = false
            if let target = hit(screenPoint(event)), let row = target.row, target.level.selectable(row) {
                activate(target.level, row, byKey: false)
            }
        case .mouseMoved, .leftMouseDragged:
            if let target = hit(screenPoint(event)) { hover(target.level, target.row) }
        case .scrollWheel:
            let location = NSEvent.mouseLocation
            let target = hit(location)?.level ?? levels.last
            let delta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 8
            target?.list.scroll(by: -delta)
        case .appKitDefined, .systemDefined, .applicationDefined, .flagsChanged:
            // Activation and system events still reach the app, so leaving it with ⌘-Tab ends the menu.
            NSApp.sendEvent(event)
        default:
            break
        }
    }

    private func hover(_ level: MenuLevel, _ row: Int?) {
        if let pending, pending.level !== level || pending.row != row { self.pending = nil }
        let selectable = row.map(level.selectable) ?? false
        if level !== levels.last {
            // The pointer is in a parent of the deepest level: only another row there closes the submenu.
            guard let row, selectable, row != level.openRow else { return }
            closeLevels(after: level)
            level.highlight(row)
            scheduleSubmenu(level, row)
            return
        }
        guard let row, selectable else { level.highlight(nil); return }
        guard level.list.highlight != row else { return }
        level.highlight(row)
        scheduleSubmenu(level, row)
    }

    private func scheduleSubmenu(_ level: MenuLevel, _ row: Int) {
        if level.list.rows[row].hasSubmenu { pending = (level, row, Date(timeIntervalSinceNow: MenuMetric.submenuDelay)) }
    }

    private func activate(_ level: MenuLevel, _ row: Int, byKey: Bool) {
        if level.list.rows[row].hasSubmenu {
            openSubmenu(of: level, row: row, selectFirst: byKey)
        } else {
            finish((level.menu, level.list.rows[row].menuIndex))
        }
    }

    private func key(_ event: NSEvent) {
        guard let level = levels.last else { return }
        switch event.keyCode {
        case 125: level.step(1)
        case 126: level.step(-1)
        case 124:
            if let row = level.list.highlight, level.list.rows[row].hasSubmenu { openSubmenu(of: level, row: row, selectFirst: true) }
        case 123:
            if levels.count > 1 { closeLevels(after: levels[levels.count - 2]) }
        case 36, 76, 49:
            if let row = level.list.highlight, level.selectable(row) { activate(level, row, byKey: true) }
        case 53:
            if levels.count > 1 { closeLevels(after: levels[levels.count - 2]) } else { finish() }
        default:
            guard event.modifierFlags.isDisjoint(with: [.command, .control, .option]),
                  let characters = event.charactersIgnoringModifiers?.lowercased(), characters.count == 1,
                  let scalar = characters.unicodeScalars.first, CharacterSet.alphanumerics.contains(scalar) else { return }
            level.jump(to: characters)
        }
    }

    // MARK: Submenus

    private func closeLevels(after level: MenuLevel) {
        guard let index = levels.firstIndex(where: { $0 === level }) else { return }
        levels[(index + 1)...].forEach { $0.close() }
        levels.removeSubrange((index + 1)...)
        level.openRow = nil
        pending = nil
    }

    private func wire(_ level: MenuLevel) {
        level.list.onPress = { [weak self, weak level] row in
            guard let self, let level else { return }
            self.activate(level, row, byKey: false)
        }
        level.list.submenuList = { [weak self, weak level] row in
            guard let self, let level, level.openRow == row, let index = self.levels.firstIndex(where: { $0 === level }), self.levels.indices.contains(index + 1) else { return nil }
            return self.levels[index + 1].list
        }
    }

    private func openSubmenu(of parent: MenuLevel, row: Int, selectFirst: Bool) {
        guard parent.openRow != row, let submenu = parent.menu.items[parent.list.rows[row].menuIndex].submenu else { return }
        closeLevels(after: parent)
        let level = MenuLevel(menu: submenu, look: look, maxHeight: visible.height, appearance: window.effectiveAppearance)
        let card = parent.cardFrame
        let rowTop = card.maxY - parent.list.rect(row).minY
        var x = card.maxX - 4
        if x + level.size.width > visible.maxX { x = card.minX - level.size.width + 4 }
        var top = min(rowTop + MenuMetric.pad, visible.maxY)
        if top - level.size.height < visible.minY { top = visible.minY + level.size.height }
        level.place(cardTopLeft: NSPoint(x: max(x, visible.minX), y: top))
        parent.openRow = row
        parent.highlight(row)
        levels.append(level)
        wire(level)
        if selectFirst { level.step(1) }
    }
}
