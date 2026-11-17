import AppKit

/// Attributed text for the transcript, set on the `MarkdownStyle` scale (which the web's `.md`
/// surface mirrors): medium for emphasis, quiet list markers, inline code as a padded chip.
/// Runs on the layout queue; formulas it has no snapshot for yet are listed in `pending`.
struct TranscriptText {
    let style: TranscriptStyle
    /// Resource tokens the text was built without (formulas still rendering).
    private(set) var pending: Set<String> = []

    init(style: TranscriptStyle) {
        self.style = style
    }

    // MARK: Plain runs

    func plain(_ string: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor, mono: Bool = false, lineHeight: CGFloat? = nil) -> NSAttributedString {
        let font = mono ? style.mono(size, weight) : style.font(size, weight)
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        if let lineHeight {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = style.lineGap(size: size, lineHeight: lineHeight)
            attributes[.paragraphStyle] = paragraph
        }
        return NSAttributedString(string: string, attributes: attributes)
    }

    /// An SF Symbol as a text attachment, centred on the cap height of a [size]pt line.
    func symbol(_ name: String, size: CGFloat, color: NSColor, weight: NSFont.Weight = .regular, plain: String = "") -> NSAttributedString {
        let font = style.font(size)
        guard let image = SymbolCache.image(name, size: style.s(size), weight: weight, color: color) else {
            return NSAttributedString(string: plain)
        }
        let attachment = NSTextAttachment()
        attachment.image = image
        attachment.bounds = CGRect(x: 0, y: (font.capHeight - image.size.height) / 2, width: image.size.width, height: image.size.height)
        let result = NSMutableAttributedString(attachment: attachment)
        result.addAttribute(.riffetPlain, value: plain, range: NSRange(location: 0, length: result.length))
        return result
    }

    // MARK: Markdown prose

    private struct Paragraph {
        let text: NSMutableAttributedString
        let lineGap: CGFloat
        /// Space above it, from the block before.
        let gapBefore: CGFloat
        var firstIndent: CGFloat = 0
        var indent: CGFloat = 0
        var tabs: [NSTextTab] = []
    }

    /// A run of prose blocks as paragraphs of one attributed string. [size] and [lineHeight] let a
    /// surface read at its own scale (a folded reasoning row keeps its 13/20 type when opened);
    /// [color] overrides the muted/answer body colours.
    mutating func prose(_ blocks: [MarkdownBlock], muted: Bool, quoted: Bool, gap: CGFloat, size: CGFloat = MarkdownStyle.bodySize, lineHeight: CGFloat? = nil, color: NSColor? = nil, headings: Bool = false) -> NSAttributedString {
        let lineHeight = lineHeight ?? style.bodyLineHeight
        var paragraphs: [Paragraph] = []
        let body = color ?? (muted || quoted ? style.color(\.fg2) : style.color(\.fg))
        for block in blocks {
            let start = paragraphs.count
            emit(block, into: &paragraphs, indent: 0, gap: gap, body: body, size: size, lineHeight: lineHeight)
            if headings, case let .heading(level, _) = block, start < paragraphs.count {
                let value = paragraphs[start].text
                value.addAttribute(.riffetHeading, value: level, range: NSRange(location: 0, length: value.length))
            }
        }
        let result = NSMutableAttributedString()
        for index in paragraphs.indices {
            let paragraph = paragraphs[index]
            let spec = NSMutableParagraphStyle()
            spec.lineSpacing = paragraph.lineGap
            spec.paragraphSpacing = index + 1 < paragraphs.count ? paragraphs[index + 1].gapBefore : 0
            spec.firstLineHeadIndent = paragraph.firstIndent
            spec.headIndent = paragraph.indent
            spec.tabStops = paragraph.tabs
            let start = result.length
            result.append(paragraph.text)
            if index + 1 < paragraphs.count {
                result.append(NSAttributedString(string: "\n", attributes: [.font: style.font(size)]))
            }
            result.addAttribute(.paragraphStyle, value: spec, range: NSRange(location: start, length: result.length - start))
        }
        return result
    }

    private mutating func emit(_ block: MarkdownBlock, into paragraphs: inout [Paragraph], indent: CGFloat, gap: CGFloat, body: NSColor, size: CGFloat = MarkdownStyle.bodySize, lineHeight: CGFloat? = nil) {
        let lineHeight = lineHeight ?? style.bodyLineHeight
        switch block {
        case let .paragraph(text):
            var paragraph = Paragraph(text: inline(text, size: size, weight: .regular, color: body), lineGap: style.lineGap(size: size, lineHeight: lineHeight), gapBefore: gap)
            paragraph.firstIndent = indent
            paragraph.indent = indent
            paragraphs.append(paragraph)
        case let .heading(level, text):
            let metrics = MarkdownStyle.heading(level)
            // Medium: PingFang's semibold is near black, and size plus the space above already rank a heading.
            let content = inline(text, size: metrics.0, weight: .medium, color: style.color(\.fg))
            content.addAttribute(.kern, value: -0.07, range: NSRange(location: 0, length: content.length))
            var paragraph = Paragraph(text: content, lineGap: style.lineGap(size: metrics.0, lineHeight: metrics.1), gapBefore: gap + MarkdownStyle.headingGapExtra)
            paragraph.firstIndent = indent
            paragraph.indent = indent
            paragraphs.append(paragraph)
        case let .list(ordered, start, items):
            for (index, item) in items.enumerated() {
                list(item, marker: marker(ordered: ordered, number: start + index, checkbox: item.checkbox, size: size), ordered: ordered, into: &paragraphs, indent: indent, gap: index == 0 ? gap : MarkdownStyle.listItemGap, body: body, size: size, lineHeight: lineHeight)
            }
        default:
            break
        }
    }

    /// One list item: the marker in its own column (16pt, or 20pt right-aligned for a number), the
    /// text 6pt after it, and every further line and block hanging at the text.
    private mutating func list(_ item: MarkdownListItem, marker: NSAttributedString, ordered: Bool, into paragraphs: inout [Paragraph], indent: CGFloat, gap: CGFloat, body: NSColor, size: CGFloat = MarkdownStyle.bodySize, lineHeight: CGFloat? = nil) {
        let lineHeight = lineHeight ?? style.bodyLineHeight
        let content = indent + (ordered ? MarkdownStyle.orderedContent : MarkdownStyle.unorderedContent)
        let tabs = [
            NSTextTab(textAlignment: ordered ? .right : .center, location: indent + (ordered ? MarkdownStyle.orderedMarkerRight : MarkdownStyle.unorderedMarkerCentre)),
            NSTextTab(textAlignment: .left, location: content),
        ]
        let lead = NSMutableAttributedString(string: "\t", attributes: [.font: style.font(size)])
        lead.append(marker)
        lead.append(NSAttributedString(string: "\t", attributes: [.font: style.font(size)]))
        let first = paragraphs.count
        for (index, block) in item.blocks.enumerated() {
            emit(block, into: &paragraphs, indent: content, gap: index == 0 ? gap : MarkdownStyle.listBlockGap, body: body, size: size, lineHeight: lineHeight)
        }
        let opensWithText: Bool
        if first < paragraphs.count, case .list = item.blocks.first { opensWithText = false } else { opensWithText = first < paragraphs.count }
        if opensWithText {
            paragraphs[first].text.insert(lead, at: 0)
            paragraphs[first].firstIndent = indent
            paragraphs[first].tabs = tabs
        } else {
            var paragraph = Paragraph(text: lead, lineGap: style.lineGap(size: size, lineHeight: lineHeight), gapBefore: gap)
            paragraph.firstIndent = indent
            paragraph.indent = content
            paragraph.tabs = tabs
            paragraphs.insert(paragraph, at: first)
        }
    }

    func marker(ordered: Bool, number: Int, checkbox: Bool?, size: CGFloat = MarkdownStyle.bodySize) -> NSAttributedString {
        if let checked = checkbox {
            return symbol(checked ? "checkmark.square.fill" : "square", size: 13, color: checked ? style.color(style.mark) : style.color(\.fg4), plain: checked ? "[x] " : "[ ] ")
        }
        let font = ordered ? NSFont.riffetDigits(size: style.s(size)) : style.font(size)
        return NSAttributedString(string: ordered ? "\(number)." : "•", attributes: [.font: font, .foregroundColor: style.color(\.fg3)])
    }

    /// Emphasis at the web's weights, inline code as a padded chip, links and file mentions, and
    /// formulas as their rendered images.
    mutating func inline(_ text: AttributedString, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSMutableAttributedString {
        let result = NSMutableAttributedString()
        // A quieter chip than `bgMuted`: inline code names things mid-sentence, and at the old
        // contrast a path-dense paragraph read as a row of buttons louder than its own headings.
        // Outlined, the chip is the hairline alone: its "background" is the stroke colour, flagged
        // so the layout manager strokes it, and TextKit still has a run to ask it about.
        // Plain, the code face alone marks it, a step smaller, with a narrow space each side.
        let plain = style.inlineCode == .plain
        let outlined = style.block == .outlined
        let codeBackground = outlined ? style.color(\.lineSoft) : style.color(\.bgSubtle)
        var chip: [NSAttributedString.Key: Any] = plain ? [:] : [.backgroundColor: codeBackground, .riffetChipRadius: min(4, style.radii.control)]
        if outlined && !plain { chip[.riffetChipOutline] = true }
        for run in text.runs {
            let piece = String(text[run.range].characters)
            if let link = run.link, let tex = MathText.tex(link) {
                result.append(formula(tex, size: size))
                continue
            }
            let intent = run.inlinePresentationIntent ?? []
            let inlineTag = run[MarkdownInlineTagKey.self]
            let strong = intent.contains(.stronglyEmphasized)
            let code = intent.contains(.code)
            var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: color]
            if inlineTag == .sup || inlineTag == .sub {
                let scriptSize = max(9, size * 0.75)
                let font = style.font(scriptSize, strong ? .medium : weight)
                attributes[.font] = intent.contains(.emphasized) ? style.italic(font) : font
                attributes[.baselineOffset] = inlineTag == .sup ? size * 0.35 : -size * 0.18
            } else if code {
                attributes[.font] = style.mono((plain ? MarkdownStyle.plainInlineCodeSize : MarkdownStyle.inlineCodeSize) * size / MarkdownStyle.bodySize, strong ? .semibold : .regular)
                attributes.merge(chip) { $1 }
            } else {
                // Medium, not semibold: PingFang's semibold turns a bolded sentence into a black bar.
                // Text that is already heavier (headings) keeps its weight.
                let font = style.font(size, strong && weight.rawValue < NSFont.Weight.medium.rawValue ? .medium : weight)
                attributes[.font] = intent.contains(.emphasized) ? style.italic(font) : font
            }
            if intent.contains(.strikethrough) || run.strikethroughStyle != nil {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link {
                attributes[.link] = link
                if link.scheme == FileLink.scheme && code {
                    // A file mention, as the web's `.md-file-mention`: the foreground stays the
                    // caller's (body) colour and a dashed underline is the only affordance, so a
                    // paragraph full of paths reads as prose with references, not as link soup.
                    attributes[.underlineStyle] = NSUnderlineStyle.patternDash.union(.single).rawValue
                    attributes[.underlineColor] = style.color(\.lineStrong)
                } else {
                    attributes[.foregroundColor] = style.color(style.link)
                    attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                    attributes[.underlineColor] = style.link == \.accent ? style.color(\.accent, 0.6) : style.color(\.fg3)
                }
            }
            // The web pads inline code by 5px; a no-break space each side cannot wrap away from it.
            let pad = code ? NSAttributedString(string: plain ? "\u{202F}" : "\u{00A0}", attributes: chip.merging([.font: style.font(MarkdownStyle.bodySize)]) { $1 }) : nil
            if let pad { result.append(pad) }
            result.append(NSAttributedString(string: piece, attributes: attributes))
            if let pad { result.append(pad) }
        }
        return result
    }

    private mutating func formula(_ tex: String, size: CGFloat) -> NSAttributedString {
        let request = MathRequest(tex: tex, theme: style.palette.values.id, dark: style.dark, display: false, scale: style.scale, color: style.hex(\.fg))
        if let rendered = MathImages.image(request) {
            let attachment = NSTextAttachment()
            attachment.image = rendered.image
            attachment.bounds = CGRect(x: 0, y: -rendered.descent, width: rendered.image.size.width, height: rendered.image.size.height)
            let result = NSMutableAttributedString(attachment: attachment)
            result.addAttribute(.riffetPlain, value: "$\(tex)$", range: NSRange(location: 0, length: result.length))
            return result
        }
        pending.insert(MathImages.token(request))
        // Rendered before (another colour, size or launch): hold its room, so the line does not reflow
        // when the snapshot lands.
        if let known = MathImages.size(request), !MathImages.isFailed(request) {
            let attachment = NSTextAttachment()
            attachment.image = NSImage(size: known.size, flipped: false) { _ in true }
            attachment.bounds = CGRect(x: 0, y: -known.descent, width: known.size.width, height: known.size.height)
            let result = NSMutableAttributedString(attachment: attachment)
            result.addAttribute(.riffetPlain, value: "$\(tex)$", range: NSRange(location: 0, length: result.length))
            return result
        }
        return NSAttributedString(string: tex, attributes: [.font: style.mono(size - 1.5), .foregroundColor: style.color(\.fg3)])
    }

    /// A table cell or a heading outside a prose run: one paragraph of inline Markdown.
    mutating func cell(_ text: AttributedString, size: CGFloat, lineHeight: CGFloat, weight: NSFont.Weight, color: NSColor, alignment: NSTextAlignment = .left) -> NSAttributedString {
        let result = inline(text, size: size, weight: weight, color: color)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = style.lineGap(size: size, lineHeight: lineHeight)
        paragraph.alignment = alignment
        result.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: result.length))
        return result
    }

    // MARK: Code

    /// Source text in the code face, coloured by [runs] when the highlighter has them.
    func code(_ text: String, runs: [CodeHighlighter.Run]?, size: CGFloat = MarkdownStyle.codeSize, prefix: String? = nil) -> NSAttributedString {
        let font = style.mono(size)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: style.color(\.fg), .paragraphStyle: paragraph]
        let result = NSMutableAttributedString()
        if let prefix { result.append(NSAttributedString(string: prefix, attributes: base.merging([.foregroundColor: style.color(\.fg3)]) { $1 })) }
        guard let runs else {
            result.append(NSAttributedString(string: text, attributes: base))
            return result
        }
        let italic = style.italic(font)
        let commentItalic = (style.dark ? style.codeTheme.dark : style.codeTheme.light).commentItalic
        for run in runs {
            var attributes = base
            if let token = run.token {
                attributes[.foregroundColor] = color(token)
                if token == .comment && commentItalic { attributes[.font] = italic }
            }
            result.append(NSAttributedString(string: run.text, attributes: attributes))
        }
        return result
    }

    private func color(_ token: CodeHighlighter.Token) -> NSColor {
        switch token {
        case .comment: style.codeColor(\.comment)
        case .punctuation: style.color(\.fg3)
        case .keyword: style.codeColor(\.keyword)
        case .string: style.codeColor(\.string)
        case .number: style.codeColor(\.number)
        case .constant: style.codeColor(\.constant)
        case .declaration: style.codeColor(\.declaration)
        case .type: style.codeColor(\.type)
        case .property: style.codeColor(\.property)
        case .namespace: style.codeColor(\.namespace)
        case .tag: style.codeColor(\.tag)
        case .attribute: style.codeColor(\.attribute)
        case .annotation: style.codeColor(\.annotation)
        case .escape: style.codeColor(\.escape)
        case .heading: style.codeColor(\.heading)
        }
    }
}
