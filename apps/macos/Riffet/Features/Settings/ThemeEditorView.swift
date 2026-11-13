import AppKit
import SwiftUI
import RiffetKit

/// What the editor opens on: a new theme drawn from a palette, or an existing custom theme.
enum ThemeEditorTarget: Identifiable {
    case new(ThemeEntry)
    case edit(String)

    var id: String {
        switch self {
        case .new(let entry): "new:" + entry.id
        case .edit(let id): id
        }
    }
}

/// The custom-theme editor, opened from the theme gallery (设置 → 主题).
///
/// The library is shared through the server, so this sheet edits the whole document and sends it
/// back with the revision it read. The preview is scoped: it paints a small window from the draft's
/// values instead of changing the running theme, so an unfinished palette cannot leak into the
/// window behind the sheet.
///
/// A new theme starts from whatever the reader is looking at: the canvas redraws the roles that make
/// a theme feel different, and the rest (status, diff, terminal) is best inherited. Structural
/// problems block saving; contrast is advice and never blocks. The fixed role labels mirror
/// `apps/web/src/lib/theme-role-labels.ts`.
struct ThemeEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme

    @State private var draft: ThemeDraft?
    @State private var mode: ThemeDraftMode = .light
    @State private var showManual = false
    @State private var busy = false
    @State private var error: String?
    /// The library as it was before a rejected save. Overwriting re-applies the draft on top of
    /// this base, so edits made while the conflict banner was up are not dropped.
    @State private var conflictBase: [CachedCustomTheme]?
    @State private var confirmDelete = false

    init(target: ThemeEditorTarget) {
        let store = ThemeStore.shared
        switch target {
        case .new(let entry):
            _draft = State(initialValue: ThemeDraft.new(from: entry, library: store.library.themes))
        case .edit(let id):
            let theme = store.library.themes.first { $0.id == id }
            _draft = State(initialValue: theme.map(ThemeDraft.init(editing:)))
            if theme == nil {
                _error = State(initialValue: String(localized: "这套主题已经被其他设备删除，请重新加载主题库。"))
            }
        }
    }

    private var store: ThemeStore { model.theme }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                Group {
                    if draft?.isNew == false { Text("编辑主题") } else { Text("新建主题") }
                }
                .font(.riffet(size: S(16), weight: .semibold))
                .foregroundStyle(palette.fg)
                Spacer(minLength: Space.sm)
                if draft?.isNew == false {
                    Button("删除", role: .destructive) { confirmDelete = true }
                        .buttonStyle(.plain)
                        .font(.riffet(size: S(12.5), weight: .medium))
                        .foregroundStyle(palette.danger)
                        .padding(.horizontal, Space.sm)
                        .disabled(busy)
                }
                Button("取消") { dismiss() }
                    .buttonStyle(SolidButtonStyle(kind: .secondary))
                    .keyboardShortcut(.cancelAction)
                Button("保存") { Task { await save() } }
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(busy || draft == nil)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            Divider()
            editor
        }
        .frame(minWidth: 820, idealWidth: 860, minHeight: 680)
        .onAppear { mode = colorScheme == .dark ? .dark : .light }
        .confirmationDialog("删除主题？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) { Task { await delete() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("“\(draft?.trimmedName ?? "")”会从所有设备上移除，正在使用它的设备会回到 Riffet。")
        }
    }

    // MARK: - Editor

    @ViewBuilder
    private var editor: some View {
        if let draft, let preview = previewValues {
            Form {
                if conflictBase != nil {
                    conflictBanner
                }
                if let error {
                    Section {
                        Text(error)
                            .font(.riffet(size: S(12)))
                            .foregroundStyle(palette.danger)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Section {
                    TextField("名称", text: nameBinding)
                        .formField(label: "名称")
                    TextField("说明（可选）", text: summaryBinding)
                        .formField(label: "说明（可选）")
                }
                // The light/dark switch picks the half being previewed and edited below.
                Section {
                    HStack(alignment: .top, spacing: Space.lg) {
                        ThemeCanvasView(seed: draft.seed ?? ThemeSeedMath.infer(light: draft.light)) { next in
                            self.draft?.redraw(with: next)
                        }
                        .frame(width: 236)
                        ThemeWindowPreview(colors: DraftColors(values: preview))
                    }
                    .padding(.vertical, Space.xs)
                } header: {
                    FormSegmented("配色", selection: $mode) {
                        ForEach(ThemeDraftMode.allCases) { value in
                            Text(value.title).tag(value)
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                Section {
                    Button {
                        withAnimation(Motion.standard) { showManual.toggle() }
                    } label: {
                        HStack(spacing: Space.xs) {
                            Image(icon: "chevron.right")
                                .font(.riffet(size: S(10), weight: .semibold))
                                .rotationEffect(.degrees(showManual ? 90 : 0))
                            Text("逐项调整")
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(palette.fg2)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if showManual {
                    manualSections
                }
            }
            .riffetForm()
            .disabled(busy)
        } else {
            ContentUnavailableView(error ?? "", icon: "paintpalette")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var manualSections: some View {
        ForEach(ThemeEditorRoles.groups, id: \.title) { group in
            Section(group.title) {
                // Rows compare by label and value, so a drag in one picker redraws one row.
                ForEach(group.roles, id: \.self) { role in
                    ThemeColorRow(label: ThemeEditorRoles.label(role), value: color(role)) { value in
                        draft?.setColor(value, role: role, mode: mode)
                    }
                    .equatable()
                }
            }
        }
        Section {
            DisclosureGroup("终端颜色（16 色）") {
                ForEach(0..<16, id: \.self) { index in
                    ThemeColorRow(label: ThemeEditorRoles.ansiLabel(index), value: ansi(index)) { value in
                        draft?.setAnsi(value, index: index, mode: mode)
                    }
                    .equatable()
                }
                Text("终端只接受 #rrggbb，透明度会被忽略。")
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
            }
        }
        Section("对比度提示（\(mode.title)）") {
            ForEach(ThemeEditorRoles.contrastChecks, id: \.label) { check in
                HStack {
                    Text(check.label).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    Spacer()
                    contrastResult(check)
                }
            }
        }
    }

    private var conflictBanner: some View {
        Section {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("主题库已在其他设备上更新。")
                    .font(.riffet(size: S(12)))
                HStack(spacing: Space.sm) {
                    Button("重新加载最新版") {
                        Task { await reloadLibrary() }
                    }
                    .buttonStyle(SolidButtonStyle(kind: .secondary))
                    Button("以本地版本覆盖") {
                        Task { await overwrite() }
                    }
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                }
                .disabled(busy)
            }
        }
    }

    // MARK: - Draft bindings

    private var nameBinding: Binding<String> {
        Binding(get: { draft?.name ?? "" }, set: { draft?.name = $0 })
    }

    private var summaryBinding: Binding<String> {
        Binding(get: { draft?.summary ?? "" }, set: { draft?.summary = $0 })
    }

    private func color(_ role: String) -> String {
        draft?.colors(mode)[role] ?? "#000000"
    }

    private func ansi(_ index: Int) -> String {
        guard let draft else { return "#000000" }
        let colors = draft.ansi(mode)
        return index < colors.count ? colors[index] : "#000000"
    }

    /// The preview always shows the tab being edited. Its colours are made directly from these values
    /// rather than through `Palette`, whose cache would keep one entry per drag step for the life of
    /// the app.
    private var previewValues: RiffetPaletteValues? {
        guard let draft else { return nil }
        let base = store.entry.values
        return previewValues(draft.colors(mode), fallback: mode == .light ? base.light : base.dark)
    }

    private func previewValues(_ colors: [String: String], fallback: RiffetPaletteValues) -> RiffetPaletteValues {
        var sanitized = fallback.roleValues()
        for (role, value) in colors where RiffetRGBA(hex: value) != nil {
            sanitized[role] = value
        }
        return RiffetPaletteValues(roleValues: sanitized) ?? fallback
    }

    @ViewBuilder
    private func contrastResult(_ check: ThemeEditorRoles.ContrastCheck) -> some View {
        if let draft,
           let front = RiffetRGBA(hex: draft.colors(mode)[check.foreground]),
           let back = RiffetRGBA(hex: draft.colors(mode)[check.background]) {
            let ratio = ThemeEditorRoles.contrastRatio(front, back)
            Text(ratio >= check.minimum
                ? String(format: "%.2f:1", ratio)
                : String(format: String(localized: "%.2f:1 · 建议 ≥ %g:1"), ratio, check.minimum))
                .font(.riffet(size: S(12)))
                .monospacedDigit()
                .foregroundStyle(ratio >= check.minimum ? palette.success : palette.warning)
        } else {
            Text("无法计算").font(.riffet(size: S(12))).foregroundStyle(palette.warning)
        }
    }

    // MARK: - Actions

    private func save() async {
        guard let draft else { return }
        let issues = draft.issues()
        if !issues.isEmpty {
            error = issues.prefix(8).joined(separator: "\n")
            return
        }
        let current = store.library.themes
        let exists = current.contains { $0.id == draft.id }
        if !exists && !draft.isNew {
            error = String(localized: "这套主题已经被其他设备删除，请重新加载主题库。")
            return
        }
        await submit(withDraft(draft, in: current), base: current)
    }

    private func submit(_ themes: [CachedCustomTheme], base: [CachedCustomTheme], expectedRevision: String? = nil) async {
        guard let draft else { return }
        busy = true
        error = nil
        do {
            try await store.replaceLibrary(themes, expectedRevision: expectedRevision)
            // A theme made here is made to be used; an edited one keeps whatever this Mac had chosen.
            if draft.isNew { store.themeId = draft.id }
            busy = false
            dismiss()
            return
        } catch {
            if let http = riffetHTTP(error), Int(http.status) == 409 {
                if expectedRevision == nil {
                    conflictBase = base
                } else {
                    self.error = String(localized: "主题库仍在变化，请重新加载后再试。")
                }
            } else {
                self.error = error.riffetMessage
            }
        }
        busy = false
    }

    private func overwrite() async {
        guard let base = conflictBase, let draft else { return }
        let issues = draft.issues()
        if !issues.isEmpty {
            error = issues.prefix(8).joined(separator: "\n")
            return
        }
        // Re-apply the current draft: the reader may have kept editing while the banner was up.
        busy = true
        await store.reload()
        await submit(withDraft(draft, in: base), base: base, expectedRevision: store.library.revision)
    }

    private func withDraft(_ draft: ThemeDraft, in base: [CachedCustomTheme]) -> [CachedCustomTheme] {
        let theme = draft.cachedTheme()
        return base.contains { $0.id == theme.id }
            ? base.map { $0.id == theme.id ? theme : $0 }
            : base + [theme]
    }

    /// Takes the other device's version: this draft is dropped with the sheet.
    private func reloadLibrary() async {
        busy = true
        await store.reload()
        busy = false
        dismiss()
    }

    private func delete() async {
        guard let draft else { return }
        busy = true
        error = nil
        let next = store.library.themes.filter { $0.id != draft.id }
        do {
            try await store.replaceLibrary(next)
            busy = false
            dismiss()
            return
        } catch {
            if let http = riffetHTTP(error), Int(http.status) == 409 {
                await store.reload()
                self.error = String(localized: "主题库已更新，请确认后再删除。")
            } else {
                self.error = error.riffetMessage
            }
        }
        busy = false
    }
}

// MARK: - Draft model

private enum ThemeDraftMode: String, CaseIterable, Identifiable {
    case light, dark
    var id: String { rawValue }
    var title: String { self == .light ? String(localized: "浅色") : String(localized: "深色") }
}

private struct ThemeDraft {
    var id: String
    var name: String
    var summary: String
    var light: [String: String]
    var dark: [String: String]
    var ansiLight: [String]
    var ansiDark: [String]
    var isNew: Bool
    /// Carried through untouched: this editor does not change design overrides.
    var design: CachedThemeDesign?
    /// Set once the canvas has drawn this palette; absent for a copy nobody has drawn yet.
    var seed: CachedThemeSeed?

    init(id: String, name: String, summary: String, light: [String: String], dark: [String: String], ansiLight: [String], ansiDark: [String], isNew: Bool, design: CachedThemeDesign? = nil, seed: CachedThemeSeed? = nil) {
        self.id = id
        self.name = name
        self.summary = summary
        self.light = light
        self.dark = dark
        self.ansiLight = ansiLight
        self.ansiDark = ansiDark
        self.isNew = isNew
        self.design = design
        self.seed = seed
    }

    init(editing theme: CachedCustomTheme) {
        self.init(
            id: theme.id,
            name: theme.name,
            summary: theme.summary ?? "",
            light: theme.palette.light,
            dark: theme.palette.dark,
            ansiLight: theme.ansi.light,
            ansiDark: theme.ansi.dark,
            isNew: false,
            design: theme.design,
            seed: theme.seed
        )
    }

    /// A new theme on [entry]'s colours, named 我的主题 — numbered when the library already has one.
    static func new(from entry: ThemeEntry, library: [CachedCustomTheme]) -> ThemeDraft {
        let custom = library.first { $0.id == entry.id }
        let base = String(localized: "我的主题")
        let taken = Set(library.map(\.name))
        var name = base
        var index = 2
        while taken.contains(name) {
            name = "\(base) \(index)"
            index += 1
        }
        return ThemeDraft(
            id: newID(),
            name: name,
            summary: "",
            light: custom?.palette.light ?? entry.values.light.roleValues(),
            dark: custom?.palette.dark ?? entry.values.dark.roleValues(),
            ansiLight: custom?.ansi.light ?? entry.values.ansi.light.map(\.hex),
            ansiDark: custom?.ansi.dark ?? entry.values.ansi.dark.map(\.hex),
            isNew: true,
            design: custom?.design,
            seed: custom?.seed
        )
    }

    /// Both halves redrawn from [next], keeping the roles typed over since the last seed.
    mutating func redraw(with next: CachedThemeSeed) {
        let seed = ThemeSeedMath.normalized(next)
        light = ThemeSeedMath.apply(light, previous: self.seed, next: seed, dark: false)
        dark = ThemeSeedMath.apply(dark, previous: self.seed, next: seed, dark: true)
        self.seed = seed
    }

    func colors(_ mode: ThemeDraftMode) -> [String: String] {
        mode == .light ? light : dark
    }

    func ansi(_ mode: ThemeDraftMode) -> [String] {
        mode == .light ? ansiLight : ansiDark
    }

    mutating func setColor(_ value: String, role: String, mode: ThemeDraftMode) {
        if mode == .light { light[role] = value } else { dark[role] = value }
    }

    mutating func setAnsi(_ value: String, index: Int, mode: ThemeDraftMode) {
        var colors = ansi(mode)
        guard index < colors.count else { return }
        colors[index] = value
        if mode == .light { ansiLight = colors } else { ansiDark = colors }
    }

    static func newID() -> String {
        "custom-" + UUID().uuidString.lowercased()
    }

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedSummary: String { summary.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The same structural rules the server enforces, checked early enough to explain them in place.
    /// Contrast is deliberately absent: it is advice, not a gate.
    func issues() -> [String] {
        var issues: [String] = []
        if !ThemeLibraryRules.isValidID(id) {
            issues.append(String(localized: "主题 id 不合法。"))
        }
        // The server counts UTF-16 units (JavaScript `String.length`), so an emoji is two here too;
        // counting Characters would let the editor accept a name the server then rejects.
        if trimmedName.isEmpty {
            issues.append(String(localized: "名称不能为空。"))
        } else if trimmedName.utf16.count > 60 {
            issues.append(String(localized: "名称最多 60 个字符。"))
        }
        if trimmedSummary.utf16.count > 200 {
            issues.append(String(localized: "说明最多 200 个字符。"))
        }
        let control = name.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
            || summary.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
        if control {
            issues.append(String(localized: "名称和说明不能包含控制字符。"))
        }
        for mode in ThemeDraftMode.allCases {
            let values = colors(mode)
            for role in ThemeEditorRoles.all where RiffetRGBA(hex: values[role]) == nil {
                issues.append(String(localized: "\(mode.title) · \(ThemeEditorRoles.label(role))：必须是 #rrggbb 或 #rrggbbaa。"))
            }
            let slots = ansi(mode)
            if slots.count != 16 {
                issues.append(String(localized: "终端颜色（\(mode.title)）必须是 16 个颜色。"))
            } else {
                for (index, color) in slots.enumerated() where !ThemeEditorRoles.isAnsiColor(color) {
                    issues.append(String(localized: "终端 · \(mode.title) · \(ThemeEditorRoles.ansiLabel(index))：必须是 #rrggbb。"))
                }
            }
        }
        return issues
    }

    func cachedTheme() -> CachedCustomTheme {
        CachedCustomTheme(
            id: id,
            name: trimmedName,
            summary: trimmedSummary.isEmpty ? nil : trimmedSummary,
            palette: CachedThemePalette(light: light, dark: dark),
            ansi: CachedThemeAnsi(light: ansiLight, dark: ansiDark),
            design: design,
            seed: seed
        )
    }
}

// MARK: - Role catalogue

private enum ThemeEditorRoles {
    struct Group {
        let title: String
        let roles: [String]
    }

    struct ContrastCheck {
        let label: String
        let foreground: String
        let background: String
        let minimum: Double
    }

    static let groups: [Group] = [
        Group(title: String(localized: "背景"), roles: ["bg", "bg-sidebar", "bg-subtle", "bg-muted", "bg-elevated", "bg-popover", "bg-hover", "bg-active", "bg-bubble"]),
        Group(title: String(localized: "文本"), roles: ["fg", "fg-2", "fg-3", "fg-4"]),
        Group(title: String(localized: "分隔线"), roles: ["line", "line-soft", "line-strong"]),
        Group(title: String(localized: "主要操作"), roles: ["primary", "primary-hover", "primary-fg"]),
        Group(title: String(localized: "强调色"), roles: ["accent", "accent-hover", "accent-soft", "accent-fg"]),
        Group(title: String(localized: "状态"), roles: ["success", "success-soft", "warning", "warning-soft", "danger", "danger-soft", "danger-fg"]),
        Group(title: "Diff", roles: ["diff-add", "diff-add-gutter", "diff-add-marker", "diff-add-strong", "diff-del", "diff-del-gutter", "diff-del-marker", "diff-del-strong"]),
        Group(title: "Agent", roles: ["agent-cursor", "agent-codex", "agent-claude", "agent-dsh"]),
        Group(title: String(localized: "图表"), roles: ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6", "chart-7", "chart-8"]),
    ]

    static let all: [String] = groups.flatMap(\.roles)

    static let labels: [String: String] = [
        "bg": String(localized: "页面背景"),
        "bg-sidebar": String(localized: "侧边栏"),
        "bg-subtle": String(localized: "次级背景"),
        "bg-muted": String(localized: "弱化背景"),
        "bg-elevated": String(localized: "浮层背景"),
        "bg-popover": String(localized: "弹出层"),
        "bg-hover": String(localized: "悬停背景"),
        "bg-active": String(localized: "激活背景"),
        "bg-bubble": String(localized: "气泡背景"),
        "fg": String(localized: "正文"),
        "fg-2": String(localized: "次要文本"),
        "fg-3": String(localized: "辅助文本"),
        "fg-4": String(localized: "占位文本"),
        "line": String(localized: "分隔线"),
        "line-soft": String(localized: "淡分隔线"),
        "line-strong": String(localized: "强调分隔线"),
        "primary": String(localized: "主按钮"),
        "primary-hover": String(localized: "主按钮悬停"),
        "primary-fg": String(localized: "主按钮文字"),
        "accent": String(localized: "强调色"),
        "accent-hover": String(localized: "强调色悬停"),
        "accent-soft": String(localized: "强调浅底"),
        "accent-fg": String(localized: "强调色文字"),
        "success": String(localized: "成功"),
        "success-soft": String(localized: "成功浅底"),
        "warning": String(localized: "警告"),
        "warning-soft": String(localized: "警告浅底"),
        "danger": String(localized: "危险"),
        "danger-soft": String(localized: "危险浅底"),
        "danger-fg": String(localized: "危险文字"),
        "diff-add": String(localized: "新增行"),
        "diff-add-gutter": String(localized: "新增行号"),
        "diff-add-marker": String(localized: "新增标记"),
        "diff-add-strong": String(localized: "新增强调"),
        "diff-del": String(localized: "删除行"),
        "diff-del-gutter": String(localized: "删除行号"),
        "diff-del-marker": String(localized: "删除标记"),
        "diff-del-strong": String(localized: "删除强调"),
        "agent-cursor": "Cursor",
        "agent-codex": "Codex",
        "agent-claude": "Claude",
        "agent-dsh": "DSH",
        "chart-1": String(localized: "图表 1"),
        "chart-2": String(localized: "图表 2"),
        "chart-3": String(localized: "图表 3"),
        "chart-4": String(localized: "图表 4"),
        "chart-5": String(localized: "图表 5"),
        "chart-6": String(localized: "图表 6"),
        "chart-7": String(localized: "图表 7"),
        "chart-8": String(localized: "图表 8"),
    ]

    static let ansiLabels = [String(localized: "黑"), String(localized: "红"), String(localized: "绿"), String(localized: "黄"), String(localized: "蓝"), String(localized: "品红"), String(localized: "青"), String(localized: "白"), String(localized: "亮黑"), String(localized: "亮红"), String(localized: "亮绿"), String(localized: "亮黄"), String(localized: "亮蓝"), String(localized: "亮品红"), String(localized: "亮青"), String(localized: "亮白")]

    static func label(_ role: String) -> String { labels[role] ?? role }

    static func ansiLabel(_ index: Int) -> String {
        index < ansiLabels.count ? ansiLabels[index] : String(localized: "颜色 \(index + 1)")
    }

    static func isAnsiColor(_ value: String) -> Bool {
        value.range(of: #"^#[0-9a-fA-F]{6}$"#, options: .regularExpression) != nil
    }

    static let contrastChecks: [ContrastCheck] = [
        ContrastCheck(label: String(localized: "正文 / 页面"), foreground: "fg", background: "bg", minimum: 4.5),
        ContrastCheck(label: String(localized: "次要文本 / 页面"), foreground: "fg-2", background: "bg", minimum: 4.5),
        ContrastCheck(label: String(localized: "辅助文本 / 页面"), foreground: "fg-3", background: "bg", minimum: 3),
        ContrastCheck(label: String(localized: "强调色 / 页面"), foreground: "accent", background: "bg", minimum: 3),
        ContrastCheck(label: String(localized: "强调文字 / 强调色"), foreground: "accent-fg", background: "accent", minimum: 4.5),
        ContrastCheck(label: String(localized: "主按钮文字 / 主按钮"), foreground: "primary-fg", background: "primary", minimum: 4.5),
        ContrastCheck(label: String(localized: "成功 / 页面"), foreground: "success", background: "bg", minimum: 3),
        ContrastCheck(label: String(localized: "警告 / 页面"), foreground: "warning", background: "bg", minimum: 3),
        ContrastCheck(label: String(localized: "危险 / 页面"), foreground: "danger", background: "bg", minimum: 3),
    ]

    /// WCAG 2.x, compositing translucent colours as they are actually painted.
    static func contrastRatio(_ foreground: RiffetRGBA, _ background: RiffetRGBA) -> Double {
        let opaque = RiffetRGBA(1, 1, 1, 1)
        let back = composite(background, over: opaque)
        let front = composite(foreground, over: background)
        let a = luminance(front)
        let b = luminance(back)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    private static func composite(_ color: RiffetRGBA, over base: RiffetRGBA) -> RiffetRGBA {
        RiffetRGBA(
            color.red * color.alpha + base.red * (1 - color.alpha),
            color.green * color.alpha + base.green * (1 - color.alpha),
            color.blue * color.alpha + base.blue * (1 - color.alpha),
            1
        )
    }

    private static func luminance(_ color: RiffetRGBA) -> Double {
        func linear(_ value: Double) -> Double {
            value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
    }
}

// MARK: - Pieces

private struct ThemeColorRow: View, Equatable {
    let label: String
    let value: String
    /// Reads the draft and mode when it runs, so a row kept from an earlier redraw writes to the right one.
    let set: (String) -> Void

    static func == (a: Self, b: Self) -> Bool { a.label == b.label && a.value == b.value }

    var body: some View {
        LabeledContent(label) {
            HStack(spacing: 8) {
                ColorPicker("", selection: colorBinding, supportsOpacity: true)
                    .labelsHidden()
                    .frame(width: 40)
                TextField("#rrggbb", text: Binding(get: { value }, set: set))
                    .formField(bezeled: true)
                    .font(.riffet(size: S(12), design: .monospaced))
                    .frame(width: 104)
            }
        }
    }

    private var colorBinding: Binding<Color> {
        Binding(
            get: {
                guard let rgba = RiffetRGBA(hex: value) else { return .black }
                return Color(.sRGB, red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha)
            },
            set: { color in
                guard let ns = NSColor(color).usingColorSpace(.sRGB) else { return }
                set(RiffetRGBA(
                    Double(ns.redComponent),
                    Double(ns.greenComponent),
                    Double(ns.blueComponent),
                    Double(ns.alphaComponent)
                ).hex)
            }
        )
    }
}

/// The draft's colours by role name, as `Palette` reads them, made on the spot.
@dynamicMemberLookup
struct DraftColors {
    let values: RiffetPaletteValues

    subscript(dynamicMember role: KeyPath<RiffetPaletteValues, RiffetRGBA>) -> Color {
        let rgba = values[keyPath: role]
        return Color(.sRGB, red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha)
    }
}
