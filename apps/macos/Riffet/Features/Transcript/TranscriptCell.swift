import AppKit
import RiffetKit

/// One transcript row on screen. Only the fragments near the visible part of the row have views:
/// a turn's process block can hold hundreds of them and run many screens tall, and drawing all of
/// them whenever the row is reused cost hundreds of milliseconds. Configuring the cell with the
/// layout it already shows does nothing.
@MainActor
final class TranscriptCell: NSView, FragmentHost {
    static let identifier = NSUserInterfaceItemIdentifier("transcript.cell")

    weak var controller: TranscriptController?
    /// Where actions go when the cell stands outside a transcript.
    var onAction: ((TranscriptAction) -> Void)?
    var fileMenu: ((String) -> [NSMenuItem])?
    private(set) var key = ""
    private(set) var rowLayout: RowLayout?
    private(set) var style: TranscriptStyle
    /// Views by fragment index, for the fragments currently materialised.
    private var shown: [Int: NSView] = [:]
    var debugShown: String { "shown=\(shown.keys.sorted()) window=\(window_)" }
    private var window_ = CGRect.null
    private var pool: [ObjectIdentifier: [NSView]] = [:]
    private var poolCursor: [ObjectIdentifier: Int] = [:]
    private var spares: [ObjectIdentifier: [NSView]] = [:]
    private var highlight: CALayer?
    /// The row's marks (收藏) as last applied, and the bookmark drawn in the gutter for a saved answer.
    private var marks = RowMarks.none
    private var bookmark: CALayer?

    init(style: TranscriptStyle) {
        self.style = style
        super.init(frame: .zero)
        identifier = Self.identifier
        wantsLayer = true
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    /// Message footers show while the pointer is over the row, and always on the newest row.
    var rowHovered = false { didSet { if rowHovered != oldValue { revealFooters() } } }
    var footerPinned = false { didSet { if footerPinned != oldValue { revealFooters() } } }

    private func revealFooters() {
        for view in subviews { (view as? FooterView)?.revealed = rowHovered || footerPinned }
    }

    var rowMessage: String? { rowLayout?.message }
    var turnActionsEnabled: Bool { controller?.actions.turn != nil }

    /// Where the reading column starts in the row: the row's content is drawn from there.
    func setInset(_ inset: CGFloat) {
        if bounds.origin.x != -inset { setBoundsOrigin(NSPoint(x: -inset, y: 0)) }
    }

    /// Shows [layout]; [visible] is the part of the row on screen, in the row's coordinates.
    func configure(key: String, layout: RowLayout, style: TranscriptStyle, visible: CGRect? = nil) {
        let restyled = style.key != self.style.key
        guard layout !== rowLayout || key != self.key || restyled else {
            if let visible { show(visible) }
            return
        }
        self.key = key
        self.style = style
        rowLayout = layout
        // Spares were drawn in the old colours, and views skip a redraw when their content is the same.
        if restyled { spares.removeAll() }
        // Views are handed out in their previous order, so a fragment that did not change lands on
        // the view already showing it and draws nothing.
        pool.removeAll(keepingCapacity: true)
        poolCursor.removeAll(keepingCapacity: true)
        for index in shown.keys.sorted() {
            guard let view = shown[index] else { continue }
            pool[ObjectIdentifier(type(of: view)), default: []].append(view)
        }
        shown.removeAll(keepingCapacity: true)
        let area = window(for: visible ?? CGRect(x: 0, y: 0, width: layout.fragments.first?.frame.maxX ?? 2000, height: 1600))
        window_ = area
        var views: [NSView] = []
        var indices: [Int] = []
        for (index, fragment) in layout.fragments.enumerated() where fragment.frame.intersects(area) {
            let view = make(fragment)
            view.frame = fragment.frame
            views.append(view)
            indices.append(index)
            shown[index] = view
        }
        // What the pool did not hand out leaves the row and waits for the next fragments.
        for (type, views) in pool {
            let used = poolCursor[type] ?? 0
            guard used < views.count else { continue }
            for view in views[used...] {
                view.removeFromSuperview()
                if spares[type, default: []].count < 12 { spares[type, default: []].append(view) }
            }
        }
        if subviews != views { subviews = views }
        for (position, index) in indices.enumerated() { configure(views[position], layout.fragments[index]) }
        if restyled { views.forEach(Self.redraw) }
        setAccessibilityLabel(layout.message.map { String($0.prefix(200)) })
        if let highlight { layer?.insertSublayer(highlight, at: 0) }
    }

    // MARK: Marks

    /// Shows [next]: the bookmark beside a saved answer and the highlights in the text blocks on
    /// screen. Blocks that come into view later get theirs in `show(_:)`; a new layout clears the
    /// old highlights itself, so a row without marks costs nothing here.
    func applyMarks(_ next: RowMarks) {
        let had = !marks.isEmpty
        marks = next
        guard had || !next.isEmpty else { return }
        for (index, view) in shown { applyHighlights(to: view, fragment: index) }
        updateBookmark()
    }

    private func applyHighlights(to view: NSView, fragment index: Int) {
        let byCell = marks.highlights[index] ?? [:]
        switch view {
        case let text as TextLayoutView: text.highlights = byCell[0] ?? []
        case let code as CodeBodyView: code.textView.highlights = byCell[0] ?? []
        case let table as TableBlockView:
            for (cell, text) in table.textViews.enumerated() { text.highlights = byCell[cell] ?? [] }
        default: break
        }
    }

    private func updateBookmark() {
        guard marks.saved, let first = rowLayout?.fragments.first(where: { if case .text = $0.kind { return true }; return false }) else {
            bookmark?.removeFromSuperlayer()
            bookmark = nil
            return
        }
        let layer = bookmark ?? CALayer()
        let size = style.s(12)
        layer.frame = CGRect(x: first.frame.minX - size - 10, y: first.frame.minY + 3, width: size, height: size)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer.contents = symbolImage("bookmark.fill", size: size, color: style.color(style.mark))
        }
        layer.contentsGravity = .resizeAspect
        if bookmark == nil { self.layer?.addSublayer(layer) }
        bookmark = layer
    }

    private static func redraw(_ view: NSView) {
        view.needsDisplay = true
        view.needsLayout = true
        view.subviews.forEach(redraw)
    }

    /// The visible part grown by a screen each way, so scrolling finds views already drawn.
    private func window(for visible: CGRect) -> CGRect {
        let margin = max(600, visible.height)
        return CGRect(x: -10_000, y: visible.minY - margin, width: 20_000, height: visible.height + margin * 2)
    }

    /// Adds views for fragments scrolling into [visible] and returns the ones far outside it.
    func show(_ visible: CGRect) {
        guard let layout = rowLayout else { return }
        let area = window(for: visible)
        // Small moves inside the materialised window need nothing.
        if !window_.isNull, window_.contains(CGRect(x: 0, y: visible.minY, width: 1, height: visible.height)),
           abs(window_.midY - area.midY) < area.height / 4 { return }
        window_ = area
        for (index, view) in shown where !layout.fragments[index].frame.intersects(area) {
            view.removeFromSuperview()
            shown[index] = nil
            let type = ObjectIdentifier(Swift.type(of: view))
            if spares[type, default: []].count < 12 { spares[type, default: []].append(view) }
        }
        for (index, fragment) in layout.fragments.enumerated() where shown[index] == nil && fragment.frame.intersects(area) {
            let view = spare(for: fragment)
            view.frame = fragment.frame
            // Keep fragment order as z-order: backgrounds stay behind what they hold.
            if let above = shown.filter({ $0.key > index }).min(by: { $0.key < $1.key })?.value {
                addSubview(view, positioned: .below, relativeTo: above)
            } else {
                addSubview(view)
            }
            shown[index] = view
            configure(view, fragment)
            if !marks.highlights.isEmpty { applyHighlights(to: view, fragment: index) }
        }
    }

    private func spare(for fragment: Fragment) -> NSView {
        pool.removeAll(keepingCapacity: true)
        poolCursor.removeAll(keepingCapacity: true)
        return make(fragment)
    }

    private func take<T: NSView>(_ make: () -> T) -> T {
        let id = ObjectIdentifier(T.self)
        let index = poolCursor[id] ?? 0
        if let list = pool[id], index < list.count, let view = list[index] as? T {
            poolCursor[id] = index + 1
            return view
        }
        if var list = spares[id], let view = list.popLast() as? T {
            spares[id] = list
            return view
        }
        return make()
    }

    private func make(_ fragment: Fragment) -> NSView {
        switch fragment.kind {
        case .box: take { BoxView() }
        case .text: take { TextLayoutView() }
        case .disclosure: take { DisclosureView() }
        case .footer: take { FooterView() }
        case .codeHeader: take { CodeHeaderView() }
        case .codeBody: take { CodeBodyView() }
        case .diffHeader: take { DiffHeaderView() }
        case .diff: take { DiffView() }
        case .table: take { TableBlockView() }
        case .image: take { ImageFragmentView() }
        case .math: take { MathImageView() }
        case .card: take { CardView() }
        case .chip: take { ChipView() }
        case .button: take { ChipButtonView() }
        case .working, .progress: take { WorkingView() }
        }
    }

    private func configure(_ view: NSView, _ fragment: Fragment) {
        (view as? FragmentView)?.host = self
        switch fragment.kind {
        case let .box(spec): (view as? BoxView)?.configure(spec)
        case let .text(layout, selectable):
            guard let text = view as? TextLayoutView else { return }
            text.layout = layout
            text.selectable = selectable
            text.onLink = { [weak self] url in self?.perform(.openURL(url)) }
            text.menuProvider = { [weak self] view in self?.messageMenu(selection: view.selectedText, in: view) }
        case let .disclosure(spec): (view as? DisclosureView)?.configure(spec)
        case let .footer(spec):
            guard let footer = view as? FooterView else { return }
            footer.configure(spec)
            footer.revealed = rowHovered || footerPinned
            // The ⋯ button opens the row's menu on an answer that can be saved (收藏回复) or exported.
            footer.hasActions = !spec.copy.isEmpty && rowLayout != nil
                && (controller?.markContext(row: key) != nil || controller?.shareAnswer(row: key) != nil)
        case let .codeHeader(spec): (view as? CodeHeaderView)?.configure(spec)
        case let .codeBody(spec): (view as? CodeBodyView)?.configure(spec)
        case let .diffHeader(spec): (view as? DiffHeaderView)?.configure(spec)
        case let .diff(spec): (view as? DiffView)?.configure(spec)
        case let .table(spec): (view as? TableBlockView)?.configure(spec)
        case let .image(spec): (view as? ImageFragmentView)?.configure(spec)
        case let .math(image): (view as? MathImageView)?.image = image
        case let .card(spec): (view as? CardView)?.configure(spec)
        case let .chip(spec): (view as? ChipView)?.configure(spec)
        case let .button(spec): (view as? ChipButtonView)?.configure(spec)
        case let .working(spec): (view as? WorkingView)?.configure(spec)
        case .progress: (view as? WorkingView)?.configure(controller?.progress(in: key))
        }
    }

    /// Shows the working line in this row's held footer slot again, as the controller now has it;
    /// the row's layout does not change with it.
    func refreshProgress() {
        guard let rowLayout else { return }
        for (index, view) in shown where index < rowLayout.fragments.count {
            if case .progress = rowLayout.fragments[index].kind { (view as? WorkingView)?.configure(controller?.progress(in: key)) }
        }
    }

    /// Re-reads clocks in headers, expanded task details and the working line.
    func tick() {
        for view in subviews {
            (view as? DisclosureView)?.tick()
            (view as? FooterView)?.tick()
            (view as? WorkingView)?.tick()
        }
    }

    /// Tints the row's content for a moment (a search hit or a jump).
    func flash() {
        guard let rowLayout, let first = rowLayout.fragments.first else { return }
        let content = rowLayout.fragments.dropFirst().reduce(first.frame) { $0.union($1.frame) }
        let layer = highlight ?? CALayer()
        layer.frame = content.insetBy(dx: -8, dy: -6)
        layer.cornerRadius = style.radii.container
        layer.cornerCurve = .continuous
        effectiveAppearance.performAsCurrentDrawingAppearance { layer.backgroundColor = style.color(\.accentSoft).cgColor }
        highlight = layer
        self.layer?.insertSublayer(layer, at: 0)
        layer.opacity = 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak layer] in
            CATransaction.begin()
            CATransaction.setAnimationDuration(0.3)
            layer?.opacity = 0
            CATransaction.commit()
        }
    }

    // MARK: FragmentHost

    func perform(_ action: TranscriptAction) {
        if let controller { controller.perform(action, row: key) } else { onAction?(action) }
    }

    /// The run of this row's finished answer, for fork and rewind, where the host offers them.
    private var turnRunId: String? {
        guard turnActionsEnabled, let rowLayout else { return nil }
        for fragment in rowLayout.fragments {
            if case let .footer(spec) = fragment.kind, let runId = spec.turnRunId { return runId }
        }
        return nil
    }

    /// Runs [action] once the menu that chose it has closed: a sheet or request started inside the
    /// menu's tracking loop is unreliable. Dropped when the row has left its window meanwhile.
    private func afterMenu(_ action: @escaping () -> Void) -> () -> Void {
        { [weak self] in
            let window = self?.window
            RunLoop.main.perform(inModes: [.default]) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, window != nil, self.window === window else { return }
                    action()
                }
            }
        }
    }

    /// The row's menu: the right-click menu and the footer's ⋯ button show the same one.
    func messageMenu(selection: String?, in view: TextLayoutView?) -> NSMenu? {
        let menu = NSMenu()
        let marking = controller?.markContext(row: key)
        if let marking, let highlight = view?.highlightAtMenu, let mark = marking.mark(highlight.markId) {
            menu.addItem(colorMenu(String(localized: "修改颜色"), selected: mark.markColor) { color in marking.perform(.recolor(id: mark.id, color: color)) })
            menu.addItem(MenuAction.item(mark.note?.isEmpty == false ? String(localized: "编辑备注…") : String(localized: "添加备注…"), symbol: "square.and.pencil") { marking.perform(.editNote(mark)) })
            menu.addItem(MenuAction.item(String(localized: "删除高亮"), symbol: "trash") { marking.perform(.delete(id: mark.id)) })
            menu.addItem(.separator())
        }
        if let selection, !selection.isEmpty {
            menu.addItem(MenuAction.item(String(localized: "复制所选文字"), symbol: "doc.on.doc") { copyToPasteboard(selection) })
            if let marking, let view, let rowLayout, view.selection.length > 0 {
                let text = RowText(rowLayout)
                if let block = text.block(showing: view.layout) {
                    let quote = text.quote(view.selection, in: block)
                    menu.addItem(colorMenu(String(localized: "高亮所选文字"), selected: nil) { color in
                        marking.perform(.highlight(marking.item, quote: quote, text: marking.item.text, color: color))
                        view.clearSelection()
                    })
                }
            }
            // Like 高亮, only a settled answer's words are offered: the card credits them to the agent.
            if marking != nil, let controller, let source = controller.shareSource(row: key, kind: .span, text: selection) {
                menu.addItem(MenuAction.item(String(localized: "导出所选文字为图片"), symbol: "square.and.arrow.up") { controller.exportImage(source) })
            }
            if rowMessage != nil { menu.addItem(.separator()) }
        }
        if let message = rowMessage {
            menu.addItem(MenuAction.item(String(localized: "复制"), symbol: "doc.on.doc") { copyToPasteboard(message) })
            if let quote = controller?.actions.quote {
                menu.addItem(MenuAction.item(String(localized: "引用回复"), symbol: "text.quote", afterMenu { quote(plainSummary(markdown: message, limit: 200)) }))
            }
            if let marking {
                let saved = marking.saved
                // The Markdown source, as the web saves it: the marks page and the exported card
                // re-render it, and a plain-text snapshot would lose the formatting there.
                let item = MenuAction.item(saved ? String(localized: "取消收藏") : String(localized: "收藏回复"), afterMenu {
                    marking.perform(.toggleMessage(marking.item, text: marking.item.text))
                })
                item.image = NSImage.icon(saved ? "bookmark.slash" : "bookmark", accessibilityDescription: nil)
                menu.addItem(item)
            }
            if let controller, let source = controller.shareAnswer(row: key) {
                let item = MenuAction.item(String(localized: "导出为图片")) { controller.exportImage(source) }
                item.image = NSImage.icon("square.and.arrow.up", accessibilityDescription: nil)
                menu.addItem(item)
            }
        }
        if let runId = turnRunId, let turn = controller?.actions.turn {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            let fork = MenuAction.item(String(localized: "从此处另开会话"), afterMenu { turn(.fork, runId) })
            fork.image = NSImage.icon("arrow.triangle.branch", accessibilityDescription: nil)
            let rewind = MenuAction.item(String(localized: "回退代码到本轮开始前"), afterMenu { turn(.rewind, runId) })
            rewind.image = NSImage.icon("arrow.counterclockwise", accessibilityDescription: nil)
            menu.addItem(fork)
            menu.addItem(rewind)
        }
        if let restore = controller?.restoreInput(row: key) {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            menu.addItem(MenuAction.item(String(localized: "恢复到输入框"), symbol: "arrow.uturn.backward", restore))
        }
        if let link = view?.menuLink, let target = FileLink.parse(link),
           let provider = controller?.actions.fileMenu ?? fileMenu {
            let items = provider(controller?.actions.resolveFile(target.path) ?? target.path)
            if !items.isEmpty, !menu.items.isEmpty { menu.insertItem(.separator(), at: 0) }
            for (offset, item) in items.enumerated() { menu.insertItem(item, at: offset) }
        }
        return menu.items.isEmpty ? nil : menu
    }

    /// The row's menu for fragment [view], led by saving what its process item shows (收藏): the
    /// picture right-clicked, or the file a tool call read or changed.
    func fragmentMenu(_ view: NSView) -> NSMenu? {
        let menu = messageMenu(selection: nil, in: nil) ?? NSMenu()
        let saving = assetItems(for: view)
        if !saving.isEmpty {
            if !menu.items.isEmpty { menu.insertItem(.separator(), at: 0) }
            for (offset, item) in saving.enumerated() { menu.insertItem(item, at: offset) }
        }
        return menu.items.isEmpty ? nil : menu
    }

    private func assetItems(for view: NSView) -> [NSMenuItem] {
        guard let index = shown.first(where: { $0.value === view })?.key,
              let context = controller?.assetContext(row: key, fragment: index) else { return [] }
        func entry(_ saved: Bool, _ title: String, _ run: @escaping () -> Void) -> NSMenuItem {
            let item = MenuAction.item(saved ? String(localized: "取消收藏") : title, run)
            item.image = NSImage.icon(saved ? "bookmark.slash" : "bookmark", accessibilityDescription: nil)
            return item
        }
        if let picture = view as? ImageFragmentView, let image = picture.loadedImage {
            let (name, path) = picture.asset
            let saved = context.marks.contains { $0.kind == "image" && $0.asset?.name == name && ($0.asset?.path ?? "") == (path ?? "") }
            return [entry(saved, String(localized: "收藏图片")) { context.perform(.toggleImage(context.item, image: image, name: name, path: path)) }]
        }
        guard let tool = context.item as? TimelineItemTool else { return [] }
        let presentation = toolPresentation(item: tool, root: nil, stale: true)
        let labels = ["read": String(localized: "读取"), "edit": String(localized: "修改"), "delete": String(localized: "删除"), "move": String(localized: "移动")]
        guard let label = labels[presentation.kind], let path = presentation.locations.first?.path else { return [] }
        let name = (path as NSString).lastPathComponent
        let counts = [presentation.added > 0 ? "+\(presentation.added)" : "", presentation.removed > 0 ? "−\(presentation.removed)" : ""].filter { !$0.isEmpty }.joined(separator: " ")
        let saved = context.marks.contains { $0.kind == "file" && $0.asset?.path == path }
        return [entry(saved, String(localized: "收藏文件")) { context.perform(.toggleFile(context.item, path: path, name: name, detail: counts.isEmpty ? label : counts)) }]
    }

    /// A submenu of the four highlight colours.
    private func colorMenu(_ title: String, selected: MarkColor?, _ action: @escaping (MarkColor) -> Void) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.image = NSImage.icon(selected == nil ? "highlighter" : "paintpalette", accessibilityDescription: nil)
        let submenu = NSMenu()
        for color in MarkColor.allCases {
            let entry = MenuAction.item(color.label) { action(color) }
            entry.image = NSImage.icon("circle.fill", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(paletteColors: [color.nsColor]))
            entry.state = color == selected ? .on : .off
            submenu.addItem(entry)
        }
        item.submenu = submenu
        return item
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        messageMenu(selection: nil, in: nil)
    }
}

/// A menu item that runs a closure.
final class MenuAction: NSObject {
    private let action: () -> Void

    private init(_ action: @escaping () -> Void) { self.action = action }

    static func item(_ title: String, symbol: String? = nil, _ action: @escaping () -> Void) -> NSMenuItem {
        let target = MenuAction(action)
        let item = NSMenuItem(title: title, action: #selector(invoke), keyEquivalent: "")
        item.target = target
        if let symbol { item.image = NSImage.icon(symbol, accessibilityDescription: nil) }
        // The item holds its target weakly.
        item.representedObject = target
        return item
    }

    @objc private func invoke() { action() }
}

/// A row view that never draws selection.
final class TranscriptRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {}
    override func drawBackground(in dirtyRect: NSRect) {}
    override var isOpaque: Bool { false }
}
