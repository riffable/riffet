import SwiftUI

// The grouped-list parts every settings, detail and edit page is built from (ios.md §3.2–3.3): the two
// containers, the row label with its symbol tile, the check row of a choice, the chip row above a list,
// the section title and the field inside a group card.

/// The container of every settings page: the white page, grey group cards, rows at least 52 high.
/// The content sits behind a type boundary (`riffetTypeBoundary`): a page built on it stays shallow.
struct RiffetForm: View {
    private let content: AnyView
    @Environment(\.palette) private var palette
    init<Content: View>(@ViewBuilder content: () -> Content) { self.content = AnyView(content()) }
    var body: some View {
        Form { Group { content }.listRowBackground(palette.bgSubtle) }
            .scrollContentBackground(.hidden).background(palette.bg)
            .environment(\.defaultMinListRowHeight, RiffetMetrics.settingsRowHeight)
    }
}

/// One group card outside a list (a fitted sheet's content): the list's card colour, corner and insets,
/// rows separated by the list's spacing. Inside `RiffetForm` and `RiffetList` use a `Section`.
struct RiffetGroupCard<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.palette) private var palette
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content() }
            .padding(RiffetMetrics.groupInset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous))
            .padding(.horizontal, RiffetMetrics.pageInset)
    }
}

/// `RiffetForm`'s counterpart for pages built as a list.
struct RiffetList: View {
    private let content: AnyView
    /// A settings row by default; a picker of one-line values (the model panel) uses the hit target.
    private let rowHeight: CGFloat
    /// In a panel sheet: no page colour, the sheet's glass shows between the groups (iOS 26).
    private let inSheet: Bool
    @Environment(\.palette) private var palette
    @Environment(\.riffetPanelSheet) private var panelSheet
    init<Content: View>(rowHeight: CGFloat = RiffetMetrics.settingsRowHeight, inSheet: Bool = false, @ViewBuilder content: () -> Content) {
        self.rowHeight = rowHeight; self.inSheet = inSheet; self.content = AnyView(content())
    }
    var body: some View {
        List { Group { content }.listRowBackground(palette.bgSubtle) }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .contentMargins(.top, 4, for: .scrollContent)
            .scrollContentBackground(.hidden)
            .background { if !(inSheet || panelSheet) || !glassSheets { palette.bg } }
            .environment(\.defaultMinListRowHeight, rowHeight)
    }
    private var glassSheets: Bool { if #available(iOS 26.0, *) { true } else { false } }
}

private struct RiffetPanelSheetKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// Set on a panel sheet's stack: every `RiffetList` in it, the pages pushed inside included, leaves the page
    /// colour off so the sheet's glass runs from the title bar down, with no band where the bar ends.
    var riffetPanelSheet: Bool {
        get { self[RiffetPanelSheetKey.self] }
        set { self[RiffetPanelSheetKey.self] = newValue }
    }
}

// MARK: - Settings parts
//
// Every settings page is built from these: a grouped list, rows with a symbol tile, a trailing
// value in the third text colour, a check mark for a choice, and a notice (`RiffetNotice`) for errors.
// Sections carry no headers unless the page has several groups of the same kind; footers only say
// what a reader could not infer (where it is stored, when it takes effect).

/// A row's symbol on a small tile: the page colour on the row's grey, so glyphs of different
/// optical sizes sit on the same square.
struct SettingsIcon: View {
    let symbol: String
    @Environment(\.palette) private var palette
    /// The tile grows with Dynamic Type along with its symbol.
    @ScaledMetric(relativeTo: .body) private var tile = RiffetMetrics.iconSlot
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: RiffetMetrics.iconTileRadius, style: .continuous)
        Image(systemName: symbol)
            .riffetFont(.label)
            .foregroundStyle(palette.fg2)
            .frame(width: tile, height: tile)
            .background(palette.bg, in: shape)
            .overlay(shape.strokeBorder(palette.lineSoft, lineWidth: 0.5))
            .accessibilityHidden(true)
    }
}

/// A settings row: tile, title, and an optional value on the trailing edge.
struct SettingsRowLabel: View {
    let title: String
    var symbol: String?
    var value: String?
    /// The title's colour where it is not the text colour: `palette.danger` for a destructive row.
    var tint: Color?
    @Environment(\.palette) private var palette
    var body: some View {
        HStack(spacing: 12) {
            if let symbol { SettingsIcon(symbol: symbol) }
            Text(title).riffetFont(.body).foregroundStyle(tint ?? palette.fg).lineLimit(1)
            Spacer(minLength: 8)
            if let value { Text(value).riffetFont(.body).foregroundStyle(palette.fg3).lineLimit(1) }
        }
    }
}

/// One choice of several: the title, an optional second line, and the accent check when picked.
struct SettingsCheckRow: View {
    let title: String
    var subtitle: String?
    let selected: Bool
    let action: () -> Void
    @Environment(\.palette) private var palette
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).riffetFont(.body).foregroundStyle(palette.fg)
                    if let subtitle { Text(subtitle).riffetFont(.caption).foregroundStyle(palette.fg3) }
                }
                Spacer(minLength: 8)
                Image(systemName: "checkmark").riffetFont(.label, weight: .semibold).foregroundStyle(palette.accent)
                    .opacity(selected ? 1 : 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A row of scope chips above a settings list, outside any card.
struct SettingsChipRow<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) { content() }.padding(.horizontal, RiffetMetrics.pageInset)
        }
        .scrollClipDisabled()
        .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}

/// A section's title in a grouped list: label weight, the third text colour, as written (no capitals).
/// `figure` is a count at its end ("2 个运行中 · 共 26"), as a panel's sections carry.
struct RiffetSectionTitle: View {
    let title: String
    var figure: String?
    init(_ title: String, figure: String? = nil) { self.title = title; self.figure = figure }
    @Environment(\.palette) private var palette
    var body: some View {
        HStack {
            Text(title)
            if let figure {
                Spacer(minLength: 8)
                Text(figure).monospacedDigit()
            }
        }
        .riffetFont(.label).foregroundStyle(palette.fg3).textCase(nil)
    }
}

/// A field inside a group card (mobile.md §2.3): the card is its container, so it draws no border or
/// fill. With several fields in a group each carries its label above the text; a page's only field
/// leaves `label` out, the page title names it. The prompt is in the third text colour.
struct RiffetField: View {
    var label: String? = nil
    let prompt: String
    @Binding var text: String
    var secure = false
    var axis: Axis = .horizontal
    /// Paths, commands and identifiers: monospaced, like the code they are.
    var mono = false
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let label { Text(label).riffetFont(.caption).foregroundStyle(palette.fg3) }
            field.riffetFont(mono ? .mono : .body).foregroundStyle(palette.fg)
        }
        .padding(.vertical, label == nil ? 0 : 4)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var field: some View {
        let placeholder = Text(prompt).foregroundStyle(palette.fg3)
        if secure {
            SecureField("", text: $text, prompt: placeholder).accessibilityLabel(label ?? prompt)
        } else {
            TextField("", text: $text, prompt: placeholder, axis: axis).accessibilityLabel(label ?? prompt)
        }
    }
}

/// An action row (mobile.md §2.4, 操作行): the title is a verb in the accent colour, `danger` for what
/// destroys; an optional symbol in the row's icon slot; while the action runs a spinner takes the row's
/// end. The row is the button: nothing else sits inside it.
struct RiffetActionRow: View {
    private let label: Text
    var symbol: String? = nil
    var destructive = false
    var busy = false
    var enabled = true
    let action: () -> Void
    @Environment(\.palette) private var palette

    init(_ title: LocalizedStringKey, symbol: String? = nil, destructive: Bool = false, busy: Bool = false, enabled: Bool = true, action: @escaping () -> Void) {
        self.init(label: Text(title), symbol: symbol, destructive: destructive, busy: busy, enabled: enabled, action: action)
    }
    init(verbatim title: String, symbol: String? = nil, destructive: Bool = false, busy: Bool = false, enabled: Bool = true, action: @escaping () -> Void) {
        self.init(label: Text(verbatim: title), symbol: symbol, destructive: destructive, busy: busy, enabled: enabled, action: action)
    }
    private init(label: Text, symbol: String?, destructive: Bool, busy: Bool, enabled: Bool, action: @escaping () -> Void) {
        self.label = label; self.symbol = symbol; self.destructive = destructive; self.busy = busy; self.enabled = enabled; self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let symbol { SettingsIcon(symbol: symbol) }
                label.riffetFont(.body).foregroundStyle(destructive ? palette.danger : palette.accent).lineLimit(1)
                Spacer(minLength: 8)
                if busy { ProgressView() }
            }
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled || busy)
        .opacity(enabled ? 1 : 0.4)
    }
}
