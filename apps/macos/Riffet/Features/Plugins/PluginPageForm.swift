import SwiftUI
import RiffetKit

/// A plugin's own page (docs/PLUGIN_ARCHITECTURE.md「插件页」): what the plugin builds, drawn with the settings'
/// native rows. Each change is saved at once and answered with the page read again; one change at a time.
@MainActor @Observable
final class PluginPageModel {
    private(set) var page: PluginPage?
    private(set) var error: String?
    private(set) var message: String?
    private(set) var busy = false
    /// Bumped with each page read, so a refresh is scheduled once per answer.
    private(set) var revision = 0
    @ObservationIgnored private var serial = 0

    static var locale: String { AppLocale.current.identifier(.bcp47) }

    func load(_ api: RiffetApi, plugin: String, quiet: Bool = false) async {
        serial += 1
        let reading = serial
        if !quiet { page = nil; error = nil; message = nil }
        do {
            let answer = try await api.pluginPage(id: plugin, locale: Self.locale)
            if reading == serial, !busy { page = answer.page; revision += 1 }
        } catch { if reading == serial, !quiet { self.error = error.riffetMessage } }
    }

    func change(_ run: () async throws -> PluginPageResponse) async -> Bool {
        guard !busy else { return false }
        serial += 1
        busy = true; error = nil; message = nil
        defer { busy = false }
        do {
            let answer = try await run()
            page = answer.page; message = answer.message; revision += 1
            return true
        } catch { self.error = error.riffetMessage; return false }
    }
}

struct PluginPageForm: View {
    let api: RiffetApi
    let plugin: PluginDescriptor
    var disabled = false
    /// After a saved change: the plugin's status may have changed with it.
    var onChanged: () -> Void = {}
    @State private var model = PluginPageModel()
    @State private var confirming: PluginPageButton?
    @Environment(\.palette) private var palette

    var body: some View {
        Form {
            if let text = model.error ?? model.message {
                Section { Text(text).font(.callout).foregroundStyle(model.error == nil ? palette.fg3 : palette.danger).textSelection(.enabled) }
            }
            if let page = model.page {
                ForEach(page.sections, id: \.id) { section in
                    Section {
                        ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                            PluginPageRow(item: item, heading: section.title, locked: disabled || model.busy, set: set, press: press)
                        }
                    } header: {
                        if let title = section.title { SettingsSectionHeader(title: title) }
                    } footer: {
                        if let footer = section.footer { Text(footer).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3) }
                    }
                }
            } else if model.error == nil {
                Section { Spinner(size: .small).frame(maxWidth: .infinity) }
            }
        }
        .riffetForm()
        .scrollContentBackground(.hidden)
        .task(id: plugin.id) { await model.load(api, plugin: plugin.id) }
        // State that changes on its own (a download): read again while the page asks for it.
        .task(id: model.revision) {
            guard let delay = model.page?.refreshMs?.intValue else { return }
            do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
            await model.load(api, plugin: plugin.id, quiet: true)
        }
        .confirmationDialog(confirming?.confirm ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let button = confirming {
                Button(button.label, role: button.destructive ? .destructive : nil) { confirming = nil; run(button) }
            }
            Button("取消", role: .cancel) { confirming = nil }
        } message: {
            if let detail = confirming?.confirmDetail { Text(detail) }
        }
    }

    private func set(_ change: PluginPageValue) {
        let id = plugin.id, locale = PluginPageModel.locale
        Task {
            let saved = await model.change {
                switch change {
                case let .text(key, value): try await api.setPluginPageText(id: id, key: key, value: value, locale: locale)
                case let .toggle(key, on): try await api.setPluginPageToggle(id: id, key: key, on: on, locale: locale)
                case let .list(key, values): try await api.setPluginPageList(id: id, key: key, values: values, locale: locale)
                }
            }
            if saved { onChanged() }
        }
    }

    private func press(_ button: PluginPageButton) {
        if button.confirm != nil { confirming = button } else { run(button) }
    }

    private func run(_ button: PluginPageButton) {
        let id = plugin.id, locale = PluginPageModel.locale
        Task {
            if await model.change({ try await api.runPluginPageAction(id: id, action: button.action, item: button.item, locale: locale) }) { onChanged() }
        }
    }
}

enum PluginPageValue {
    case text(String, String?)
    case toggle(String, Bool)
    case list(String, [String])
}

private struct PluginPageRow: View {
    let item: PluginPageItem
    /// The section's title: a choice named the same does not say it again.
    let heading: String?
    let locked: Bool
    let set: (PluginPageValue) -> Void
    let press: (PluginPageButton) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        switch item.kind {
        case "choice": choice
        case "toggle":
            SettingsRow(item.label, detail: item.detail) {
                Toggle(item.label, isOn: Binding(get: { item.on }, set: { on in set(.toggle(item.key ?? "", on)) }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.small).disabled(locked)
            }
        case "text": PluginPageTextRow(item: item, locked: locked, set: set)
        case "list": PluginPageListRow(item: item, locked: locked, set: set)
        case "row":
            SettingsRow(item.label, detail: item.detail) {
                HStack(spacing: Space.md) {
                    if let value = item.value { Text(value).font(.riffet(size: S(13))).monospacedDigit().foregroundStyle(palette.fg2) }
                    ForEach(Array(item.buttons.enumerated()), id: \.offset) { _, button in pageButton(button) }
                }
            }
        case "buttons":
            HStack(spacing: Space.sm) { ForEach(Array(item.buttons.enumerated()), id: \.offset) { _, button in pageButton(button) } }
        default: EmptyView()
        }
    }

    @ViewBuilder private var choice: some View {
        if item.label != heading {
            Text(item.label).font(.riffet(size: S(13))).foregroundStyle(palette.fg)
        }
        ForEach(item.options, id: \.value) { option in
            let selected = option.value == item.value
            HStack(spacing: Space.md) {
                Button {
                    if !selected { set(.text(item.key ?? "", option.value)) }
                } label: {
                    HStack(spacing: Space.sm) {
                        Image(icon: selected ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(selected ? palette.accent : palette.fg3)
                        Text(option.label).foregroundStyle(palette.fg)
                        Spacer(minLength: Space.md)
                        if let detail = option.detail { Text(detail).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(locked || option.disabled)
                .opacity(option.disabled ? 0.5 : 1)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
                if let button = option.button { pageButton(button) }
            }
        }
    }

    private func pageButton(_ button: PluginPageButton) -> some View {
        Button(button.label) { press(button) }.controlSize(.small).disabled(locked || button.disabled)
    }
}

/// Saved on Return or when focus leaves, if it changed.
private struct PluginPageTextRow: View {
    let item: PluginPageItem
    let locked: Bool
    let set: (PluginPageValue) -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        SettingsRow(item.label) {
            HStack(spacing: Space.sm) {
                Group {
                    if item.secret {
                        SecureField(item.set ? String(localized: "已设置") : (item.placeholder ?? ""), text: $draft)
                    } else {
                        TextField(item.placeholder ?? "", text: $draft)
                    }
                }
                .textFieldStyle(.roundedBorder).labelsHidden().frame(maxWidth: 320)
                .focused($focused).onSubmit(commit).disabled(locked)
                if item.secret && item.set { Button("清除") { set(.text(item.key ?? "", nil)) }.controlSize(.small).disabled(locked) }
            }
        }
        .onAppear { if !item.secret { draft = item.value ?? "" } }
        .onChange(of: item.value) { _, value in if !item.secret, !focused { draft = value ?? "" } }
        .onChange(of: focused) { _, now in if !now { commit() } }
    }

    private func commit() {
        let value = draft.trimmingCharacters(in: .whitespaces)
        if item.secret ? value.isEmpty : value == (item.value ?? "").trimmingCharacters(in: .whitespaces) { return }
        set(.text(item.key ?? "", value.isEmpty ? nil : value))
        if item.secret { draft = "" }
    }
}

/// The list is sent whole after each addition or removal.
private struct PluginPageListRow: View {
    let item: PluginPageItem
    let locked: Bool
    let set: (PluginPageValue) -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        SettingsFieldRow(item.label) {
            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(item.values, id: \.self) { value in
                    HStack {
                        Text(value).font(.riffet(size: S(13))).foregroundStyle(palette.fg).textSelection(.enabled)
                        Spacer()
                        Button { set(.list(item.key ?? "", item.values.filter { $0 != value })) } label: {
                            Image(icon: "xmark").font(.riffet(size: S(10), weight: .semibold))
                        }
                        .buttonStyle(IconButtonStyle(size: 20)).disabled(locked)
                        .help(String(localized: "移除 \(value)")).accessibilityLabel(String(localized: "移除 \(value)"))
                    }
                }
                TextField(item.placeholder ?? "", text: $draft)
                    .textFieldStyle(.roundedBorder).frame(maxWidth: 320)
                    .focused($focused).onSubmit(add).disabled(locked)
            }
        }
        .onChange(of: focused) { _, now in if !now { add() } }
    }

    private func add() {
        let values = draft.split(whereSeparator: { $0 == "," || $0.isWhitespace }).map(String.init).filter { !$0.isEmpty && !item.values.contains($0) }
        draft = ""
        if !values.isEmpty { set(.list(item.key ?? "", item.values + values)) }
    }
}
