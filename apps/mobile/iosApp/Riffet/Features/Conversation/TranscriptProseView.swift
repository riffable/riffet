import SwiftUI
import UIKit
import RiffetKit

/// What prose rows reach outside the list: links, quoting, the selection sheet, and the SwiftUI views of
/// the blocks that keep them. Set by the page; one per transcript.
@MainActor
final class TranscriptProseActions {
    var open: (URL) -> Void = { _ in }
    var quote: ((String) -> Void)?
    var selectText: ((String) -> Void)?
    var block: (TranscriptProseBlock) -> AnyView = { _ in AnyView(EmptyView()) }
}

/// Where find's mark is drawn, for the list to bring it into view: a text view, or drawn prose.
@MainActor
protocol ConversationFindMarking: UIView {
    /// In the view's own coordinates; nil before it is laid out or when it draws no mark.
    var findMarkRect: CGRect? { get }
}
extension UITextView: ConversationFindMarking {}

/// A transcript cell showing a laid-out prose row (`TranscriptProse`). Its height is the layout's;
/// nothing is fitted here.
@MainActor
final class TranscriptProseCell: UICollectionViewCell {
    let prose = TranscriptProseView()
    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        contentView.addSubview(prose)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func layoutSubviews() {
        super.layoutSubviews()
        prose.frame = contentView.bounds
    }
    /// The row moved without the list scrolling (rows above it settled to their heights): what part of it
    /// shows changed, so the pieces built for it must follow.
    override func apply(_ layoutAttributes: UICollectionViewLayoutAttributes) {
        super.apply(layoutAttributes)
        guard let list = superview as? UIScrollView else { return }
        showVisible(of: list, frame: layoutAttributes.frame)
    }
    /// Tells the prose which part of the row the list shows; `frame` is the row's frame in the list.
    func showVisible(of list: UIScrollView, frame: CGRect) {
        prose.updateVisible(list.bounds.offsetBy(dx: -frame.minX, dy: -frame.minY))
    }
    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        guard let height = prose.layout?.height else { return layoutAttributes }
        let fitted = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
        fitted.size = CGSize(width: layoutAttributes.size.width, height: height)
        return fitted
    }
    override func prepareForReuse() {
        super.prepareForReuse()
        prose.prepareForReuse()
    }
}

/// Places a prose layout's pieces, building views only for those near the visible part of the row
/// (`updateVisible`): however long a reply is, a frame costs what is on screen (ios-performance.md §2.16).
@MainActor
final class TranscriptProseView: UIView, UITextViewDelegate {
    private(set) var layout: TranscriptProseLayout?
    private(set) var rowID: String?
    var actions: TranscriptProseActions?
    var environment: TranscriptHostingEnvironment?
    weak var probe: ConversationTranscriptProbe?
    /// The reader touched something in the row (a disclosure in a hosted block): the list keeps it still.
    var onRead: (String) -> Void = { _ in }
    /// The row's layout changed here: a hosted block settled to a height other than the one reserved.
    var onResized: (String, TranscriptProseLayout) -> Void = { _, _ in }
    /// A code block was expanded or collapsed: the row is laid out again.
    var onCodeToggled: (String) -> Void = { _ in }

    private var realized: [Int: UIView] = [:]
    private var visibleRect: CGRect?
    private var texts: [TranscriptTextPieceView] = []
    private var bars: [UIView] = []
    private var checkboxes: [UIImageView] = []
    private var hosts: [String: UIView & UIContentView] = [:]
    /// Per hosted block: the content it shows (`TranscriptProseBlock.signature`) and the height it last measured.
    private var hostSignatures: [String: Int] = [:]
    private var hostHeights: [String: CGFloat] = [:]
    /// Heights reported while pieces are being placed, applied once placing is done: applying one moves the
    /// pieces the loop is still placing.
    private var pendingHeights: [String: CGFloat] = [:]
    private var realizing = false
    /// Code blocks shown, by block key: laid out again, a block keeps its view and where it is scrolled to.
    private var codes: [String: TranscriptCodeBlockView] = [:]
    private var codePool: [TranscriptCodeBlockView] = []
    private var footer: TranscriptProseFooterView?
    private var selecting: (view: ConversationParagraphTextView, drawn: UIView)?
    private let flash = CALayer()
    private var flashedRequest: Int64?
    /// Margin around the visible part of the row in which pieces get views ahead of scrolling.
    private static let realizeAhead: CGFloat = 400

    override init(frame: CGRect) {
        super.init(frame: frame)
        flash.cornerRadius = RiffetMetrics.rowRadius
        flash.cornerCurve = .continuous
        flash.opacity = 0
        layer.addSublayer(flash)
        isAccessibilityElement = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    func prepareForReuse() {
        endSelection()
        for view in realized.values { recycle(view) }
        realized.removeAll()
        // Blocks scrolled out of the row's window stay built while the row is shown; not once it is gone.
        for host in hosts.values { host.removeFromSuperview() }
        hosts.removeAll(); hostSignatures.removeAll(); hostHeights.removeAll(); pendingHeights.removeAll()
        for code in codes.values { recycle(code) }
        layout = nil; rowID = nil; visibleRect = nil
        flash.removeAllAnimations(); flash.opacity = 0
    }

    /// Shows `layout` for the row `id`. The same row laid out again (a block settled, a formula arrived,
    /// more text streamed) keeps its hosted blocks and only moves what moved.
    func apply(_ layout: TranscriptProseLayout, row id: String, highlight: ConversationFindHighlight?, palette: Palette) {
        if rowID != id { prepareForReuse() } else if self.layout === layout { return }
        let sameRow = rowID == id
        rowID = id
        let previous = realized
        realized.removeAll()
        self.layout = layout
        if sameRow {
            // Text and bars are cheap to place again; hosted blocks (by key) and the footer stay.
            for view in previous.values {
                if let kept = view as? TranscriptProseFooterView { footer = kept }
                else if !(view is UIContentView || view is TranscriptCodeBlockView) { recycle(view) }
            }
        } else {
            for view in previous.values { recycle(view) }
        }
        accessibilityCustomActions = [UIAccessibilityCustomAction(name: String(localized: "复制这段内容", bundle: .riffet)) { _ in
            UIPasteboard.general.string = layout.copyText; return true
        }]
        flash.backgroundColor = UIColor(palette.warning).withAlphaComponent(0.18).cgColor
        showFlash(highlight)
        realizeVisible()
        // Hosted blocks and the footer of the previous layout that are not shown any more.
        let shown = Set(realized.values.map(ObjectIdentifier.init))
        for view in previous.values where !shown.contains(ObjectIdentifier(view)) && (view is UIContentView || view is TranscriptProseFooterView || view is TranscriptCodeBlockView) { recycle(view) }
        // Blocks the new layout no longer has; and blocks kept whose reserved height is not the one they
        // measured (a cached height purged, a relayout computed before the block settled).
        var keys: [String: CGFloat] = [:]
        for piece in layout.pieces { if case let .block(block) = piece.kind { keys[block.key] = piece.frame.height } }
        for (key, host) in hosts where keys[key] == nil { recycle(host) }
        for (key, height) in hostHeights where keys[key].map({ abs($0 - height) > 0.5 }) == true { pendingHeights[key] = height }
        flushHeights()
        if let spare = footer, spare.superview != nil, !shown.contains(ObjectIdentifier(spare)) { spare.removeFromSuperview() }
    }

    /// The part of the row on screen, in this view's coordinates; pieces near it get views.
    func updateVisible(_ rect: CGRect) {
        let rounded = rect.integral
        if let visibleRect, abs(visibleRect.minY - rounded.minY) < 40, abs(visibleRect.maxY - rounded.maxY) < 40 { return }
        visibleRect = rounded
        realizeVisible()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        flash.frame = bounds.insetBy(dx: TranscriptProse.rowInset - 6, dy: -2)
        if visibleRect == nil { realizeVisible() }
    }

    private func realizeVisible() {
        guard let layout else { return }
        let outer = !realizing
        realizing = true
        defer { if outer { realizing = false; flushHeights() } }
        let window = (visibleRect ?? CGRect(x: 0, y: 0, width: bounds.width, height: UIScreen.main.bounds.height)).insetBy(dx: 0, dy: -Self.realizeAhead)
        for (index, piece) in layout.pieces.enumerated() {
            let wanted = piece.frame.intersects(window) || piece.frame.height == 0 && window.contains(piece.frame.origin)
            if wanted {
                if let view = realized[index] { if view.frame != piece.frame { view.frame = piece.frame } }
                else if let view = makeView(piece) { view.frame = piece.frame; realized[index] = view; if view.superview !== self { addSubview(view) } }
            } else if case let .block(block) = piece.kind {
                // Kept while the row is shown (rebuilding it costs a SwiftUI tree), and kept in place.
                realized[index] = nil
                if let host = hosts[block.key], host.frame != piece.frame { host.frame = piece.frame }
            } else if let view = realized.removeValue(forKey: index) {
                recycle(view)
            }
        }
    }

    private func makeView(_ piece: TranscriptProseLayout.Piece) -> UIView? {
        switch piece.kind {
        case let .text(text):
            let view = texts.popLast() ?? TranscriptTextPieceView()
            view.owner = self
            view.show(text, layout: text.layout, interactive: true)
            if text.findMark != nil { probe?.report(view, marked: true) }
            return view
        case let .marker(marker):
            let view = texts.popLast() ?? TranscriptTextPieceView()
            view.owner = nil
            view.show(nil, layout: marker, interactive: false)
            return view
        case let .checkbox(checked):
            let view = checkboxes.popLast() ?? UIImageView()
            view.image = UIImage(systemName: checked ? "checkmark.square" : "square")
            view.contentMode = .center
            view.preferredSymbolConfiguration = UIImage.SymbolConfiguration(font: RiffetText.body.uiFont(compatibleWith: traitCollection))
            view.tintColor = environment.map { UIColor($0.values.palette.fg3) } ?? .secondaryLabel
            view.isAccessibilityElement = true
            view.accessibilityLabel = checked ? String(localized: "已完成", bundle: .riffet) : String(localized: "未完成", bundle: .riffet)
            return view
        case let .bar(radius):
            let view = bars.popLast() ?? UIView()
            view.layer.cornerRadius = radius
            view.backgroundColor = environment.map { UIColor($0.values.palette.line) } ?? .separator
            view.isUserInteractionEnabled = false
            return view
        case .rule:
            let view = bars.popLast() ?? UIView()
            view.layer.cornerRadius = 0
            view.backgroundColor = environment.map { UIColor($0.values.palette.line) } ?? .separator
            view.isUserInteractionEnabled = false
            return view
        case let .block(block):
            if let host = hosts[block.key] {
                if hostSignatures[block.key] != block.signature {
                    hostSignatures[block.key] = block.signature
                    host.configuration = hostConfiguration(block)
                }
                return host
            }
            return makeHost(block, width: piece.frame.width)
        case let .code(code):
            let view = codes[code.key] ?? codePool.popLast() ?? TranscriptCodeBlockView()
            codes[code.key] = view
            view.owner = self
            view.show(code, palette: environment?.values.palette)
            return view
        case let .footer(value):
            let view = footer ?? TranscriptProseFooterView()
            footer = nil
            view.show(value, actions: actions, palette: environment?.values.palette)
            return view
        }
    }

    private func recycle(_ view: UIView) {
        view.removeFromSuperview()
        switch view {
        case let text as TranscriptTextPieceView:
            if selecting?.drawn === text { endSelection() }
            probe?.report(text, marked: false)
            text.show(nil, layout: nil, interactive: false)
            if texts.count < 64 { texts.append(text) }
        case let image as UIImageView:
            if checkboxes.count < 16 { checkboxes.append(image) }
        case let footer as TranscriptProseFooterView:
            self.footer = footer
        case let code as TranscriptCodeBlockView:
            if let drawn = selecting?.drawn, drawn.isDescendant(of: code) { endSelection() }
            if let key = codes.first(where: { $0.value === code })?.key { codes.removeValue(forKey: key) }
            code.prepareForReuse()
            if codePool.count < 8 { codePool.append(code) }
        case is UIContentView:
            if let key = hosts.first(where: { $0.value === view })?.key {
                hosts.removeValue(forKey: key); hostSignatures.removeValue(forKey: key); hostHeights.removeValue(forKey: key)
            }
        default:
            if bars.count < 32 { bars.append(view) }
        }
    }

    // MARK: Hosted blocks

    private func hostConfiguration(_ block: TranscriptProseBlock) -> UIContentConfiguration {
        let id = rowID ?? ""
        let content = TranscriptProseHostedBlock(block: block, environment: environment, actions: actions,
                                                 onRead: { [weak self] in self?.onRead(id) },
                                                 onHeight: { [weak self] height in self?.blockHeight(block.key, height, row: id) })
        return UIHostingConfiguration { content }.margins(.all, 0).minSize(width: 0, height: 0)
    }

    private func makeHost(_ block: TranscriptProseBlock, width: CGFloat) -> UIView & UIContentView {
        let id = rowID ?? ""
        let host = hostConfiguration(block).makeContentView()
        host.clipsToBounds = true
        hosts[block.key] = host
        hostSignatures[block.key] = block.signature
        // Measured once now, before it is drawn: a reserved height that was only an estimate is corrected
        // in the same frame instead of after it.
        let fitted = host.systemLayoutSizeFitting(CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
                                                  withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
        if fitted.isFinite, fitted > 0 { blockHeight(block.key, fitted, row: id) }
        return host
    }

    private func blockHeight(_ key: String, _ height: CGFloat, row: String) {
        guard rowID == row, let layout, height > 0, height.isFinite else { return }
        let scale = max(1, traitCollection.displayScale)
        let rounded = (height * scale).rounded(.up) / scale
        hostHeights[key] = rounded
        guard let piece = layout.pieces.first(where: { if case let .block(block) = $0.kind { block.key == key } else { false } }),
              abs(piece.frame.height - rounded) > 0.5 else { return }
        TranscriptProseHeights.shared.set(rounded, for: key, width: piece.frame.width)
        pendingHeights[key] = rounded
        if !realizing { flushHeights() }
    }

    /// Moves what is below blocks that settled to new heights and tells the list the row's new height.
    private func flushHeights() {
        guard !pendingHeights.isEmpty else { return }
        let heights = pendingHeights
        pendingHeights.removeAll()
        guard var resized = layout, let rowID else { return }
        var changed = false
        for (key, height) in heights {
            if let next = resized.resizing(block: key, to: height) { resized = next; changed = true }
        }
        guard changed else { return }
        layout = resized
        realizeVisible()
        onResized(rowID, resized)
    }

    // MARK: Find

    private func showFlash(_ highlight: ConversationFindHighlight?) {
        guard let highlight else { flashedRequest = nil; flash.removeAllAnimations(); flash.opacity = 0; return }
        guard flashedRequest != highlight.request else { return }
        flashedRequest = highlight.request
        flash.removeAllAnimations()
        flash.opacity = 1
        // Marked words carry the find; an empty needle keeps the tint until the next step.
        guard !highlight.needle.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.flashedRequest == highlight.request else { return }
            if UIAccessibility.isReduceMotionEnabled { self.flash.opacity = 0; return }
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1; fade.toValue = 0; fade.duration = 0.35
            fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.flash.opacity = 0
            self.flash.add(fade, forKey: "fade")
        }
    }

    // MARK: Selecting

    /// A long press swaps the drawn block for a text view holding the same text, so the system's selection
    /// handles, loupe and edit menu (with 引用) work as in any text view. One block at a time.
    /// `drawn` is the view that draws `text` at `frame` in its superview; `point` is in `drawn`.
    func beginSelection(_ text: NSAttributedString, drawn: UIView, frame: CGRect, at point: CGPoint) {
        guard let container = drawn.superview else { return }
        endSelection()
        let view = ConversationParagraphTextView.reused() ?? ConversationParagraphTextView.make()
        view.backgroundColor = .clear; view.isEditable = false; view.isSelectable = true; view.isScrollEnabled = false
        view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.linkTextAttributes = [:]
        view.attributedText = text
        view.delegate = self
        view.frame = frame
        container.addSubview(view)
        drawn.isHidden = true
        selecting = (view, drawn)
        let inText = view.convert(point, from: drawn)
        if let position = view.closestPosition(to: inText),
           let range = view.tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: .storage(.forward)) ?? view.tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: .storage(.backward)) {
            view.selectedTextRange = range
        }
        _ = view.becomeFirstResponder()
        if let menu = view.interactions.lazy.compactMap({ $0 as? UIEditMenuInteraction }).first {
            menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: inText))
        }
    }

    private func endSelection() {
        guard let (view, drawn) = selecting else { return }
        selecting = nil
        drawn.isHidden = false
        view.recycle()
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        guard textView === selecting?.view, textView.selectedRange.length == 0 else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let current = self.selecting, current.view === textView, textView.selectedRange.length == 0 else { return }
            self.endSelection()
        }
    }
    func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
        guard case let .link(url) = textItem.content else { return defaultAction }
        return UIAction { [weak self] _ in self?.actions?.open(url) }
    }
    func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard let quote = actions?.quote, range.length > 0 else { return nil }
        let text = ConversationFormulaText.copyText(textView.attributedText, range: range)
        let action = UIAction(title: String(localized: "引用", bundle: .riffet), image: UIImage(systemName: "text.quote")) { _ in quote(text) }
        var items = suggestedActions; items.insert(action, at: min(1, items.count))
        return UIMenu(children: items)
    }

    /// A tap on a link in drawn text.
    func open(_ url: URL) { actions?.open(url) }

    /// Expands or collapses a code block; the list lays the row out again.
    func toggle(_ code: TranscriptProseCode) {
        guard let rowID else { return }
        onRead(rowID)
        TranscriptProseCodeState.shared.set(code.stateID, expanded: code.disclosure != .collapse)
        onCodeToggled(rowID)
    }
}

/// A laid-out block of text, drawn straight from its glyphs.
@MainActor
final class TranscriptTextPieceView: UIView, ConversationFindMarking {
    private(set) var text: TranscriptProseText?
    private var drawn: TextLayout?
    weak var owner: TranscriptProseView?
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    private lazy var press: UILongPressGestureRecognizer = {
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0.4
        return press
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        addGestureRecognizer(tap)
        addGestureRecognizer(press)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    func show(_ text: TranscriptProseText?, layout: TextLayout?, interactive: Bool) {
        self.text = text
        isHidden = false
        tap.isEnabled = interactive && text?.hasLinks == true
        press.isEnabled = interactive
        isUserInteractionEnabled = interactive
        isAccessibilityElement = interactive && text != nil
        accessibilityLabel = text.map { $0.layout.plain(NSRange(location: 0, length: $0.layout.length)) }
        accessibilityTraits = text?.heading == true ? .header : .staticText
        guard drawn !== layout else { return }
        drawn = layout
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let drawn else { return }
        let manager = drawn.manager
        let glyphs = manager.glyphRange(forBoundingRect: rect, in: drawn.container)
        guard glyphs.length > 0 else { return }
        manager.drawBackground(forGlyphRange: glyphs, at: .zero)
        manager.drawGlyphs(forGlyphRange: glyphs, at: .zero)
    }

    var findMarkRect: CGRect? {
        guard let text, let range = text.findMark, bounds.width > 0 else { return nil }
        let manager = text.layout.manager
        let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        return manager.boundingRect(forGlyphRange: glyphs, in: text.layout.container)
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let text else { return }
        let point = gesture.location(in: self)
        let layout = text.layout
        var fraction: CGFloat = 0
        let glyph = layout.manager.glyphIndex(for: point, in: layout.container, fractionOfDistanceThroughGlyph: &fraction)
        let line = layout.manager.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
        guard line.insetBy(dx: -4, dy: -2).contains(point) else { return }
        let index = layout.manager.characterIndexForGlyph(at: glyph)
        guard index < layout.length else { return }
        let value = layout.storage.attribute(.transcriptLink, at: index, effectiveRange: nil)
        if let url = value as? URL { owner?.open(url) }
        else if let string = value as? String, let url = URL(string: string) { owner?.open(url) }
    }

    @objc private func pressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, let text else { return }
        owner?.beginSelection(text.selectable, drawn: self, frame: frame, at: gesture.location(in: self))
    }
}

/// A code block without a preview (`TranscriptProseCode`), as `ConversationCode` shows it: a title bar
/// with the language and a copy button, the code in its own scroller (lines never wrap), and the line that
/// expands a long block. Only the part of the code in view is drawn.
@MainActor
final class TranscriptCodeBlockView: UIView, UIScrollViewDelegate {
    private(set) var code: TranscriptProseCode?
    weak var owner: TranscriptProseView?
    private let bar = UIView()
    private let title = UILabel()
    private let copy = UIButton(type: .system)
    private let scroll = UIScrollView()
    private let canvas = TranscriptCodeCanvas()
    private let divider = UIView()
    private let disclosure = UIButton(type: .system)
    private var copiedUntil: Date?
    private lazy var press: UILongPressGestureRecognizer = {
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0.4
        return press
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = RiffetMetrics.controlRadius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        addSubview(bar); bar.addSubview(title); bar.addSubview(copy)
        addSubview(scroll); scroll.addSubview(canvas)
        addSubview(divider); addSubview(disclosure)
        title.adjustsFontForContentSizeCategory = true
        copy.addTarget(self, action: #selector(copied), for: .touchUpInside)
        disclosure.addTarget(self, action: #selector(toggled), for: .touchUpInside)
        scroll.delegate = self
        scroll.scrollsToTop = false
        scroll.isDirectionalLockEnabled = true
        scroll.alwaysBounceVertical = false
        scroll.alwaysBounceHorizontal = false
        scroll.showsHorizontalScrollIndicator = true
        scroll.accessibilityIdentifier = "codeOutputScroll"
        scroll.addGestureRecognizer(press)
        canvas.isAccessibilityElement = true
        canvas.accessibilityTraits = .staticText
        accessibilityContainerType = .semanticGroup
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    func show(_ code: TranscriptProseCode, palette: Palette?) {
        if self.code?.key != code.key { scroll.contentOffset = .zero }
        self.code = code
        let muted = palette.map { UIColor($0.fg3) } ?? .secondaryLabel
        backgroundColor = palette.map { UIColor($0.bgSubtle) }
        bar.backgroundColor = palette.map { UIColor($0.press) }
        divider.backgroundColor = palette.map { UIColor($0.line) } ?? .separator
        let font = RiffetText.monoSmall.uiFont(compatibleWith: traitCollection)
        title.attributedText = NSAttributedString(string: code.title, attributes: [.font: font, .foregroundColor: muted, .kern: code.cited ? 0 : 0.8])
        title.lineBreakMode = code.cited ? .byTruncatingHead : .byTruncatingTail
        copy.tintColor = muted
        refreshCopy()
        switch code.disclosure {
        case .none:
            disclosure.isHidden = true; divider.isHidden = true
        case let .expand(lines):
            showDisclosure(String(localized: "展开全部 \(lines) 行", bundle: .riffet), symbol: "chevron.down", color: muted)
        case .collapse:
            showDisclosure(String(localized: "收起代码", bundle: .riffet), symbol: "chevron.up", color: muted)
        }
        canvas.accessibilityLabel = code.layout.string
        canvas.isHidden = false
        canvas.layout = code.layout
        setNeedsLayout()
    }

    func prepareForReuse() {
        code = nil
        canvas.layout = nil
        copiedUntil = nil
    }

    private func showDisclosure(_ text: String, symbol: String, color: UIColor) {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: symbol)
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(font: RiffetText.caption.uiFont(compatibleWith: traitCollection))
        configuration.imagePadding = 6
        configuration.baseForegroundColor = color
        configuration.attributedTitle = AttributedString(text, attributes: AttributeContainer([.font: RiffetText.caption.uiFont(compatibleWith: traitCollection)]))
        disclosure.configuration = configuration
        disclosure.isHidden = false; divider.isHidden = false
    }

    private func refreshCopy() {
        let done = copiedUntil != nil
        copy.setImage(UIImage(systemName: done ? "checkmark" : "doc.on.doc"), for: .normal)
        copy.setPreferredSymbolConfiguration(UIImage.SymbolConfiguration(font: RiffetText.caption.uiFont(compatibleWith: traitCollection)), forImageIn: .normal)
        copy.accessibilityLabel = done ? String(localized: "已复制", bundle: .riffet) : String(localized: "复制代码", bundle: .riffet)
    }

    @objc private func copied() {
        guard let code else { return }
        UIPasteboard.general.string = code.source
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        let until = Date().addingTimeInterval(2)
        copiedUntil = until
        refreshCopy()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.copiedUntil == until else { return }
            self.copiedUntil = nil
            self.refreshCopy()
        }
    }

    @objc private func toggled() {
        guard let code else { return }
        owner?.toggle(code)
    }

    @objc private func pressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, let code else { return }
        let padding = TranscriptProse.codePadding
        // A little wider than the text, so the text view never wraps a line TextKit 1 just fitted.
        let frame = CGRect(x: padding, y: padding, width: code.textSize.width + 4, height: code.textSize.height)
        owner?.beginSelection(code.selectable, drawn: canvas, frame: frame, at: gesture.location(in: canvas))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let code else { return }
        let width = bounds.width
        let header = TranscriptProse.codeHeader
        bar.frame = CGRect(x: 0, y: 0, width: width, height: header)
        let side = RiffetMetrics.hitTarget
        copy.frame = CGRect(x: width - side, y: 0, width: side, height: header)
        title.frame = CGRect(x: TranscriptProse.codePadding, y: 0, width: max(0, width - side - 8 - TranscriptProse.codePadding), height: header)
        scroll.frame = CGRect(x: 0, y: header, width: width, height: code.viewport)
        let padding = TranscriptProse.codePadding
        let size = CGSize(width: code.textSize.width + padding * 2, height: code.textSize.height + padding * 2)
        if scroll.contentSize != size { scroll.contentSize = size }
        let hairline = 1 / max(1, traitCollection.displayScale)
        divider.frame = CGRect(x: 0, y: scroll.frame.maxY, width: width, height: hairline)
        disclosure.frame = CGRect(x: 0, y: divider.frame.maxY, width: width, height: TranscriptProse.codeDisclosure)
        placeCanvas()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { placeCanvas() }

    /// The canvas covers only the code in view and draws what lies under it: a long or wide block never
    /// backs a layer larger than its viewport.
    private func placeCanvas() {
        guard let code else { return }
        let padding = TranscriptProse.codePadding
        let text = CGRect(origin: CGPoint(x: padding, y: padding), size: code.textSize)
        let shown = scroll.bounds.intersection(text)
        guard !shown.isNull, !shown.isEmpty else { canvas.frame = .zero; return }
        let scale = max(1, traitCollection.displayScale)
        let frame = CGRect(x: (shown.minX * scale).rounded(.down) / scale, y: (shown.minY * scale).rounded(.down) / scale,
                           width: (shown.width * scale).rounded(.up) / scale, height: (shown.height * scale).rounded(.up) / scale)
        guard canvas.frame != frame else { return }
        canvas.frame = frame
        canvas.origin = CGPoint(x: frame.minX - padding, y: frame.minY - padding)
        canvas.setNeedsDisplay()
    }
}

/// Draws the part of a code block's text under it; `origin` is where its top left falls in the text.
@MainActor
final class TranscriptCodeCanvas: UIView {
    var layout: TextLayout? { didSet { if oldValue !== layout { setNeedsDisplay() } } }
    var origin: CGPoint = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func draw(_ rect: CGRect) {
        guard let layout else { return }
        let glyphs = layout.manager.glyphRange(forBoundingRect: rect.offsetBy(dx: origin.x, dy: origin.y), in: layout.container)
        guard glyphs.length > 0 else { return }
        let at = CGPoint(x: -origin.x, y: -origin.y)
        layout.manager.drawBackground(forGlyphRange: glyphs, at: at)
        layout.manager.drawGlyphs(forGlyphRange: glyphs, at: at)
    }
}

/// The line under a reply: its menu (built when opened, ios-performance.md §2.18) and the turn's time.
@MainActor
final class TranscriptProseFooterView: UIView {
    private let button = RiffetDeferredMenuButton()
    private let label = UILabel()
    private var value: TranscriptProseFooter?
    private var copiedUntil: Date?

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(button); addSubview(label)
        label.adjustsFontForContentSizeCategory = true
        button.accessibilityIdentifier = "messageCopy"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    func show(_ value: TranscriptProseFooter, actions: TranscriptProseActions?, palette: Palette?) {
        self.value = value
        let color = palette.map { UIColor($0.fg4) } ?? .tertiaryLabel
        button.isHidden = value.text.isEmpty
        button.items = { [weak self, weak actions] in
            ConversationCopyActions.menu(text: value.text, copied: { self?.copied() }, selectText: actions?.selectText, quote: actions?.quote)
        }
        label.text = value.time
        label.font = RiffetText.caption.uiFont(compatibleWith: traitCollection)
        label.textColor = color
        label.isHidden = value.time == nil
        refreshButton(color: color)
        setNeedsLayout()
    }

    private func copied() {
        let until = Date().addingTimeInterval(2)
        copiedUntil = until
        refreshButton(color: button.configuration?.baseForegroundColor ?? .tertiaryLabel)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.copiedUntil == until else { return }
            self.copiedUntil = nil
            self.refreshButton(color: self.button.configuration?.baseForegroundColor ?? .tertiaryLabel)
        }
    }

    private func refreshButton(color: UIColor) {
        let copied = copiedUntil != nil
        button.show(symbol: copied ? "checkmark" : "ellipsis", font: RiffetText.label.uiFont(weight: .medium, compatibleWith: traitCollection), color: color)
        button.accessibilityLabel = copied ? String(localized: "已复制消息", bundle: .riffet) : String(localized: "更多", bundle: .riffet)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = TranscriptProse.footerHeight
        button.frame = CGRect(x: 0, y: 0, width: side, height: side)
        let x = button.isHidden ? 0 : side + 4
        label.frame = CGRect(x: x, y: 0, width: max(0, bounds.width - x), height: bounds.height)
    }
}

/// A block that keeps its SwiftUI view inside drawn prose, with the transcript's environment.
struct TranscriptProseHostedBlock: View {
    let block: TranscriptProseBlock
    let environment: TranscriptHostingEnvironment?
    let actions: TranscriptProseActions?
    let onRead: () -> Void
    let onHeight: (CGFloat) -> Void

    var body: some View {
        let values = environment?.values ?? EnvironmentValues()
        (actions?.block(block) ?? AnyView(EmptyView()))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .riffetFont(.body)
            .foregroundStyle(values.palette.fg)
            .textSelection(.enabled)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight($0) }
            .environment(\.conversationReadAction, {
                onRead()
                values.conversationReadAction()
            })
            .environment(\.openURL, OpenURLAction { url in actions?.open(url); return .handled })
            .environment(\.conversationViewportHeight, environment?.viewportHeight)
            .environment(\.self, values)
    }
}
