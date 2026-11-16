import SwiftUI

// The page shells of docs/design/system/mobile.md §2 on the iPhone (ios.md §3.2): the edit page, the
// picker sheet, and the parts a panel is built from (§2.7). Pages use these rather than assembling a
// sheet, a bar and a guard of their own.

// MARK: - Edit page

/// An edit or create page (mobile.md §2.3), presented as a sheet: Cancel on the leading edge, the save
/// verb on the trailing edge (off while nothing changed), a spinner in its place while saving, and the
/// unsaved-changes guard. `save` returns whether the page should close; on false the page stays with
/// the reader's input, and the page shows the reason itself (a `RiffetNotice` in its content).
struct RiffetEditPage<Content: View>: View {
    let title: String
    var saveTitle = String(localized: "保存", bundle: .riffet)
    let dirty: Bool
    /// Whether the input can be saved at all (a required field filled); saving also needs `dirty`
    /// unless `alwaysSavable` (a create page whose defaults are already valid).
    var canSave = true
    var alwaysSavable = false
    let save: () async -> Bool
    @ViewBuilder var content: () -> Content
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var confirming = false

    var body: some View {
        NavigationStack {
            RiffetForm { content() }
                .disabled(saving)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(String(localized: "取消", bundle: .riffet)) { if dirty { confirming = true } else { dismiss() } }
                            .disabled(saving)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if saving { ProgressView() }
                        else {
                            Button(saveTitle) { run() }
                                .disabled(!canSave || !(dirty || alwaysSavable))
                                .keyboardShortcut(.defaultAction)
                        }
                    }
                }
                .riffetUnsavedGuard(dirty: dirty, locked: saving, confirming: $confirming) { dismiss() }
        }
    }

    private func run() {
        saving = true
        Task {
            let close = await save()
            saving = false
            if close { dismiss() }
        }
    }
}

// MARK: - Picker sheet

/// One value of a picker sheet: a title and an optional second line that tells it apart.
struct RiffetPickerOption<ID: Hashable>: Identifiable {
    let id: ID
    let title: String
    var subtitle: String? = nil
}

/// Choosing one value from five or more (mobile.md §2.5): a sheet with a title, a search field when
/// there are more than eight, one column of options, the current one checked at the end. Choosing
/// closes it. Two to four nearby values are a `Picker(.menu)` instead.
struct RiffetPickerSheet<ID: Hashable>: View {
    let title: String
    let options: [RiffetPickerOption<ID>]
    @Binding var selection: ID
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var query = ""

    private var shown: [RiffetPickerOption<ID>] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return options }
        return options.filter { $0.title.localizedCaseInsensitiveContains(needle) || ($0.subtitle?.localizedCaseInsensitiveContains(needle) ?? false) }
    }

    var body: some View {
        NavigationStack {
            RiffetList {
                ForEach(shown) { option in
                    SettingsCheckRow(title: option.title, subtitle: option.subtitle, selected: option.id == selection) {
                        selection = option.id
                        dismiss()
                    }
                }
            }
            .overlay { if shown.isEmpty && !query.isEmpty { ContentUnavailableView.search(text: query) } }
            .modifier(PickerSearch(enabled: options.count > 8, query: $query))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private struct PickerSearch: ViewModifier {
        let enabled: Bool
        @Binding var query: String
        func body(content: Content) -> some View {
            if enabled { content.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always)) } else { content }
        }
    }
}

/// A settings row for a value chosen in a picker sheet: the title, the current value at the end, and
/// the sheet on tap (mobile.md §2.4, 选择行).
struct RiffetPickerRow<ID: Hashable>: View {
    let title: String
    var symbol: String? = nil
    let options: [RiffetPickerOption<ID>]
    @Binding var selection: ID
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            SettingsRowLabel(title: title, symbol: symbol, value: options.first { $0.id == selection }?.title)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $open) { RiffetPickerSheet(title: title, options: options, selection: $selection) }
        .accessibilityValue(options.first { $0.id == selection }?.title ?? "")
    }
}

// MARK: - Panel parts

/// The title of a panel or a page that carries a state line under it (a conversation's details: its
/// name, then "运行中 · 3 分钟前"). Goes in the bar's principal slot.
struct RiffetBarTitle: View {
    let title: String
    var status: String? = nil
    @Environment(\.palette) private var palette
    var body: some View {
        VStack(spacing: 0) {
            Text(title).riffetFont(.barTitle).foregroundStyle(palette.fg).lineLimit(1)
            if let status, !status.isEmpty {
                Text(status).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One cell of a `RiffetPaneActionBar`.
struct RiffetPaneAction: Identifiable {
    let id = UUID()
    let symbol: String
    let title: String
    var enabled = true
    var destructive = false
    let action: () -> Void
}

/// A row of two to four equal cells on a group card, a symbol over a one-word label: a panel's
/// destinations (变更, 文件, 终端, 查找) and, in a second bar, its small actions (置顶, 重命名…). Put it
/// in its own `Section` with zero row insets.
struct RiffetPaneActionBar: View {
    let actions: [RiffetPaneAction]
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            ForEach(actions.prefix(4)) { item in
                Button(action: item.action) {
                    VStack(spacing: 6) {
                        Image(systemName: item.symbol).riffetFont(.barTitle, weight: .regular)
                        Text(item.title).riffetFont(.caption).lineLimit(1)
                    }
                    .foregroundStyle(item.destructive ? palette.danger : palette.fg)
                    .frame(maxWidth: .infinity, minHeight: RiffetMetrics.settingsRowHeight * 3 / 2)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RiffetRowPressStyle())
                .disabled(!item.enabled)
                .opacity(item.enabled ? 1 : 0.4)
            }
        }
        .listRowInsets(EdgeInsets())
    }
}

/// A fact in a panel or detail page (mobile.md §2.7): the label, then the value at the end in the third
/// text colour on one line. `mono` for what is code (a path, a branch), which keeps its end; a long
/// press copies the value.
struct RiffetValueRow: View {
    let label: String
    let value: String
    var mono = false
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            Text(label).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1).layoutPriority(1)
            Spacer(minLength: 8)
            Text(value).riffetFont(mono ? .monoSmall : .body).foregroundStyle(palette.fg3)
                .lineLimit(1).truncationMode(mono ? .head : .tail)
        }
        .accessibilityElement(children: .combine)
        .contextMenu {
            Button(String(localized: "复制", bundle: .riffet), systemImage: "doc.on.doc") { UIPasteboard.general.string = value }
        }
    }
}
