import SwiftUI

/// What plugins contribute beyond palettes: a preset, the interface and monospaced fonts, and a
/// background. A row appears only when the catalog has something of its kind, so with no appearance
/// plugin on this page is as it was. The choice is this Mac's; the plugin palettes sit in the theme
/// gallery above.
struct AppearancePackRows: View {
    private var appearance: AppearanceStore { .shared }

    var body: some View {
        let catalog = appearance.catalog
        let uiFonts = catalog.fonts.filter { $0.role == "ui" }
        let monoFonts = catalog.fonts.filter { $0.role == "mono" }
        let backgrounds = catalog.backgrounds.filter { $0.areas.contains("workbench") }
        if !catalog.presets.isEmpty || !uiFonts.isEmpty || !monoFonts.isEmpty || !backgrounds.isEmpty {
            Section {
                if !catalog.presets.isEmpty {
                    row(
                        String(localized: "外观预设"),
                        current: appearance.selection.preset,
                        options: catalog.presets.map { ($0.id, $0.title.localizedTitle) }
                    ) { appearance.selectPreset($0 == AppearanceSelection.hostDefault ? nil : $0) }
                }
                if !uiFonts.isEmpty {
                    row(
                        String(localized: "界面字体"),
                        current: appearance.effective.uiFont?.id,
                        options: uiFonts.map { ($0.id, $0.title.localizedTitle) }
                    ) { appearance.selectFont(role: "ui", id: $0) }
                }
                if !monoFonts.isEmpty {
                    row(
                        String(localized: "等宽字体"),
                        current: appearance.effective.monoFont?.id,
                        options: monoFonts.map { ($0.id, $0.title.localizedTitle) }
                    ) { appearance.selectFont(role: "mono", id: $0) }
                }
                if !backgrounds.isEmpty {
                    row(
                        String(localized: "背景"),
                        current: appearance.effective.background?.id,
                        options: backgrounds.map { ($0.id, $0.title.localizedTitle) }
                    ) { appearance.selectBackground($0) }
                }
            }
        }
    }

    /// A choice from [options] or the host default. [current] that the catalog does not list shows as the default.
    private func row(_ title: String, current: String?, options: [(id: String, title: String)], select: @escaping (String) -> Void) -> some View {
        let shown = current.flatMap { id in options.contains { $0.id == id } ? id : nil } ?? AppearanceSelection.hostDefault
        return SettingsRow(title) {
            Picker(title, selection: Binding(get: { shown }, set: select)) {
                Text("默认").tag(AppearanceSelection.hostDefault)
                ForEach(options, id: \.id) { Text($0.title).tag($0.id) }
            }
            .labelsHidden()
        }
    }
}
