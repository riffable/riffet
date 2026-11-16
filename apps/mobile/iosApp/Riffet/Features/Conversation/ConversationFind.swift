import SwiftUI
import UIKit
import RiffetKit

/// What find marks inside the row it landed on: `needle` is lower-cased; `nth` is the selected occurrence in the row's text.
struct ConversationFindHighlight: Hashable {
    let needle: String
    let nth: Int
    /// The selection that produced it: the row flashes once per request.
    var request: Int64 = 0

    func ranges(in text: String) -> [Range<String.Index>] {
        guard !needle.isEmpty else { return [] }
        var result: [Range<String.Index>] = []
        var from = text.startIndex
        while from < text.endIndex, let found = text.range(of: needle, options: .caseInsensitive, range: from..<text.endIndex) {
            result.append(found)
            from = found.upperBound
        }
        return result
    }
}

private struct ConversationFindHighlightKey: EnvironmentKey { static let defaultValue: ConversationFindHighlight? = nil }

private struct ConversationFindProbeKey: EnvironmentKey { static let defaultValue: ConversationTranscriptProbe? = nil }

extension EnvironmentValues {
    /// Set only on the cells of the row find landed on.
    var conversationFindHighlight: ConversationFindHighlight? {
        get { self[ConversationFindHighlightKey.self] }
        set { self[ConversationFindHighlightKey.self] = newValue }
    }
    /// The transcript's probe, where a paragraph drawing find's mark reports itself.
    var conversationFindProbe: ConversationTranscriptProbe? {
        get { self[ConversationFindProbeKey.self] }
        set { self[ConversationFindProbeKey.self] = newValue }
    }
}

extension NSAttributedString.Key {
    /// The run find marked, beside its background; see `ConversationFormulaText.attributed`.
    static let conversationFindMark = NSAttributedString.Key("riffet.conversationFindMark")
}

extension NSAttributedString {
    var findMarkRange: NSRange? {
        var found: NSRange?
        enumerateAttribute(.conversationFindMark, in: NSRange(location: 0, length: length)) { value, range, stop in
            if value != nil { found = range; stop.pointee = true }
        }
        return found
    }
}

extension UITextView {
    /// Where find's mark is drawn, in this view's coordinates; nil before the view is laid out.
    var findMarkRect: CGRect? {
        guard bounds.width > 0, let range = attributedText.findMarkRange else { return nil }
        layoutManager.ensureLayout(for: textContainer)
        let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer)
        return rect.offsetBy(dx: textContainerInset.left, dy: textContainerInset.top)
    }
}

extension AttributedString {
    /// The occurrences of the highlight's needle with a background; only occurrence `index` when given
    /// (none if this text does not hold it). A background never changes a line's height.
    func highlighting(_ highlight: ConversationFindHighlight?, only index: Int?, color: Color) -> AttributedString {
        guard let highlight, !highlight.needle.isEmpty else { return self }
        var ranges = highlight.ranges(in: String(characters))
        if let index { ranges = ranges.indices.contains(index) ? [ranges[index]] : [] }
        var result = self
        for range in ranges {
            guard let lower = AttributedString.Index(range.lowerBound, within: result), let upper = AttributedString.Index(range.upperBound, within: result) else { continue }
            result[lower..<upper].backgroundColor = color
        }
        return result
    }
}

/// A tint over the cell find landed on; it never changes the cell's size. Where the words are marked
/// it fades after a moment; where they cannot be (an empty needle) it stays until the next step or
/// the end of find, as marked words do.
struct ConversationFindFlash: ViewModifier {
    let highlight: ConversationFindHighlight?
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var strength = 0.0

    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(palette.warning.opacity(0.18 * strength)).padding(.horizontal, -6).padding(.vertical, -2))
            .task(id: highlight?.request) {
                guard let highlight else { strength = 0; return }
                strength = 1
                guard !highlight.needle.isEmpty else { return }
                try? await Task.sleep(for: .milliseconds(500))
                withAnimation(RiffetMotion.unlessReduced(RiffetMotion.release, reduceMotion)) { strength = 0 }
            }
    }
}

/// The bar pinned under the navigation bar while find is open; the state machine is `SessionFind`.
struct ConversationFindBar: View {
    let state: FindState
    let find: SessionFind
    /// The row key of the topmost visible transcript cell.
    let topRowKey: () -> String?
    @Environment(\.palette) private var palette
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(palette.fg3)
            TextField(String(localized: "查找", bundle: .riffet), text: $text)
                .focused($focused).submitLabel(.next).onSubmit { find.next(); focused = true }
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("conversationFindField")
            if !text.isEmpty {
                Text("\(max(0, Int(state.current) + 1))/\(state.total)").riffetFont(.caption).monospacedDigit().foregroundStyle(palette.fg3)
            }
            Button { find.previous() } label: { Image(systemName: "chevron.up").frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Rectangle()) }
                .accessibilityLabel(Text("上一个", bundle: .riffet))
            Button { find.next() } label: { Image(systemName: "chevron.down").frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Rectangle()) }
                .accessibilityLabel(Text("下一个", bundle: .riffet))
            Button { find.close() } label: { Text("完成", bundle: .riffet).frame(minWidth: RiffetMetrics.hitTarget, minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle()) }
        }
        .buttonStyle(.plain).foregroundStyle(palette.fg)
        .padding(.leading, 14).padding(.trailing, 12).frame(minHeight: 44)
        .riffetGlass(in: Capsule())
        .onChange(of: text) { _, value in find.setQueryFrom(query: value, readingKey: topRowKey()) }
        .onAppear { focused = true }
    }
}

/// The bar, ⌘F, and landing on each new target; `state` follows the shared find flow.
struct ConversationFindLayer: ViewModifier {
    let find: SessionFind
    @Binding var state: FindState?
    let land: (FindTarget) -> Void
    let topRowKey: () -> String?
    /// Changes when the rows held are replaced or grow: a target outside them waits for the page around it.
    let window: String
    let retry: () -> Void
    /// How far the bar reaches below the top bar while it is shown, gap included; 0 when closed.
    @Binding var reach: CGFloat

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let state, state.open {
                    ConversationFindBar(state: state, find: find, topRowKey: topRowKey)
                        .padding(.horizontal, 12).padding(.top, 8).frame(maxWidth: RiffetMetrics.readingWidth)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { reach = $0 + 8 }
                        .onDisappear { reach = 0 }
                        .transition(.opacity)
                }
            }
            .riffetAnimation(RiffetMotion.release, value: state?.open == true)
            .background {
                Button("") { find.open(readingPos: nil) }.keyboardShortcut("f").opacity(0).allowsHitTesting(false).accessibilityHidden(true)
            }
            .task {
                let flow = find.state
                state = flow.value
                for await _ in flow { state = flow.value }
            }
            .onChange(of: state?.target?.request) { _, request in
                if request != nil, let target = state?.target { land(target) }
            }
            .onChange(of: window) { _, _ in retry() }
    }
}
