import SwiftUI

// The 外观 group's pages. Everything here is this Mac's, except the custom theme library.

/// 主题: light or dark, the colour theme, and the shared library of custom themes.
struct ThemeSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.palette) private var palette
    @State private var editorTarget: ThemeEditorTarget?
    @State private var refreshedAt = Date.distantPast
    private var appearance: AppearanceStore { .shared }

    var body: some View {
        @Bindable var prefs = DisplayPreferences.shared
        @Bindable var theme = model.theme
        Form {
            Section {
                SettingsRow("明暗") {
                    FormSegmented("明暗", selection: $prefs.appearance) {
                        Label("跟随系统", icon: "circle.lefthalf.filled").tag("system")
                        Label("浅色", icon: "sun.max").tag("light")
                        Label("深色", icon: "moon").tag("dark")
                    }
                    .labelsHidden()
                }
            }

            Section {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 190, maximum: 260), spacing: Space.md)], spacing: Space.md) {
                    ForEach(theme.catalog, id: \.id) { entry in
                        ThemePreviewCard(
                            entry: entry,
                            selected: appearance.paletteEntry == nil && entry.id == theme.themeId,
                            dark: colorScheme == .dark
                        ) {
                            theme.themeId = entry.id
                        }
                        .overlay(alignment: .topTrailing) {
                            // Beside the card's own button rather than inside it, so both stay real buttons.
                            if theme.canEditThemes, theme.customThemes.contains(where: { $0.id == entry.id }) {
                                Button { editorTarget = .edit(entry.id) } label: { Image(icon: "pencil") }
                                    .buttonStyle(IconButtonStyle(size: 22))
                                    .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                                    .padding(Space.sm + Space.xs)
                                    .help(Text("编辑主题"))
                                    .accessibilityLabel(Text("编辑“\(entry.name)”"))
                            }
                        }
                    }
                    // Plugin palettes sit beside the themes; picking one never changes the theme choice.
                    ForEach(appearance.catalog.palettes) { palette in
                        if let entry = appearance.paletteEntries[palette.id] {
                            ThemePreviewCard(
                                entry: entry,
                                selected: appearance.paletteEntry?.id == entry.id,
                                dark: colorScheme == .dark
                            ) {
                                appearance.selectPalette(palette.id)
                            }
                        }
                    }
                    // A new theme starts from the one on screen: pick the closest, then reshape it.
                    NewThemeCard { editorTarget = .new(theme.entry) }
                        .disabled(!theme.canEditThemes)
                        .help(theme.canEditThemes ? Text("保存在服务器；每台设备各自选择。") : Text("连接服务器后可管理。"))
                }
                .padding(.vertical, Space.xs)
            }

            Section("代码高亮") {
                let customSyntaxThemes = theme.customThemes.filter { $0.syntax != nil }
                let selection = (prefs.codeTheme.hasPrefix("custom-") && !customSyntaxThemes.contains { $0.id == prefs.codeTheme }) ? "auto" : prefs.codeTheme
                SettingsRow("风格") {
                    HStack(spacing: Space.sm) {
                        Picker("风格", selection: Binding(get: { selection }, set: { prefs.codeTheme = $0 })) {
                            Text("跟随界面主题").tag("auto")
                            Divider()
                            ForEach(RiffetCodeThemeCatalog.all, id: \.id) { entry in
                                if entry.id == "monochrome" {
                                    Text("极简墨色").tag(entry.id)
                                } else {
                                    Text(verbatim: entry.name).tag(entry.id)
                                }
                            }
                            if !customSyntaxThemes.isEmpty {
                                Divider()
                                ForEach(customSyntaxThemes, id: \.id) { custom in
                                    Text(verbatim: custom.name).tag(custom.id)
                                }
                            }
                        }
                        .labelsHidden()
                        .formPicker()
                        .fixedSize()
                        if theme.canEditThemes {
                            Button("自定义…") {
                                if selection.hasPrefix("custom-") {
                                    editorTarget = .edit(selection, openSyntax: true)
                                } else if theme.customThemes.contains(where: { $0.id == theme.themeId }) {
                                    editorTarget = .edit(theme.themeId, openSyntax: true)
                                } else {
                                    editorTarget = .new(theme.entry, openSyntax: true)
                                }
                            }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                        }
                    }
                }

                CodeThemePreview(codeThemeId: selection)
            }

            AppearancePackRows()

            SettingsScopeFooter()
        }
        .riffetForm()
        // Another device may have changed the shared library; opening this page is the moment to ask.
        .task { refreshThemes() }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.appearance.rawValue,
                  Date.now.timeIntervalSince(refreshedAt) > 30 else { return }
            refreshThemes()
        }
        .sheet(item: $editorTarget) { target in ThemeEditorView(target: target) }
    }

    private func refreshThemes() {
        refreshedAt = .now
        model.theme.refresh()
        appearance.refresh()
    }
}

/// Live preview of the active code syntax theme inside ThemeSettings.
private struct CodeThemePreview: View {
    let codeThemeId: String
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @State private var runs: [CodeHighlighter.Run]?

    private static let snippet = """
    // Syntax preview
    @tagged("api")
    async function loadConfig(limit = 42): Promise<Config> {
      const mode = true;
      return { name: "riffet", count: limit };
    }
    """

    var body: some View {
        let codeTheme = model.theme.resolveCodeTheme(selection: codeThemeId)
        let codeRevision = model.theme.resolveCodeThemeRevision(selection: codeThemeId)
        Text(attributed(codeTheme: codeTheme, codeRevision: codeRevision))
            .font(RiffetFont.codeSmall)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
            .background(palette.formFill(palette.bgSubtle), in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.line))
            .padding(.vertical, Space.xs)
            .task {
                if runs == nil {
                    runs = await CodeHighlighter.shared.runs(Self.snippet, language: "typescript")
                }
            }
    }

    private func attributed(codeTheme: RiffetCodeThemeValues, codeRevision: String) -> AttributedString {
        guard let runs else {
            var plain = AttributedString(Self.snippet)
            plain.foregroundColor = palette.fg
            return plain
        }
        let dark = colorScheme == .dark
        let commentItalic = (dark ? codeTheme.dark : codeTheme.light).commentItalic
        var result = AttributedString()
        for run in runs {
            var part = AttributedString(run.text)
            if let token = run.token {
                part.foregroundColor = Color(nsColor: color(token, codeTheme: codeTheme, codeRevision: codeRevision))
                if token == .comment && commentItalic { part.inlinePresentationIntent = .emphasized }
            } else {
                part.foregroundColor = palette.fg
            }
            result += part
        }
        return result
    }

    private func color(_ token: CodeHighlighter.Token, codeTheme: RiffetCodeThemeValues, codeRevision: String) -> NSColor {
        switch token {
        case .comment: palette.codeNSColor(\.comment, codeTheme: codeTheme, codeRevision: codeRevision)
        case .punctuation: palette.nsColor(\.fg3)
        case .keyword: palette.codeNSColor(\.keyword, codeTheme: codeTheme, codeRevision: codeRevision)
        case .string: palette.codeNSColor(\.string, codeTheme: codeTheme, codeRevision: codeRevision)
        case .number: palette.codeNSColor(\.number, codeTheme: codeTheme, codeRevision: codeRevision)
        case .constant: palette.codeNSColor(\.constant, codeTheme: codeTheme, codeRevision: codeRevision)
        case .declaration: palette.codeNSColor(\.declaration, codeTheme: codeTheme, codeRevision: codeRevision)
        case .type: palette.codeNSColor(\.type, codeTheme: codeTheme, codeRevision: codeRevision)
        case .property: palette.codeNSColor(\.property, codeTheme: codeTheme, codeRevision: codeRevision)
        case .namespace: palette.codeNSColor(\.namespace, codeTheme: codeTheme, codeRevision: codeRevision)
        case .tag: palette.codeNSColor(\.tag, codeTheme: codeTheme, codeRevision: codeRevision)
        case .attribute: palette.codeNSColor(\.attribute, codeTheme: codeTheme, codeRevision: codeRevision)
        case .annotation: palette.codeNSColor(\.annotation, codeTheme: codeTheme, codeRevision: codeRevision)
        case .escape: palette.codeNSColor(\.escape, codeTheme: codeTheme, codeRevision: codeRevision)
        case .heading: palette.codeNSColor(\.heading, codeTheme: codeTheme, codeRevision: codeRevision)
        }
    }
}

/// 窗口: what shows behind the window and how much of it shows through.
struct WindowSettings: View {

    var body: some View {
        @Bindable var prefs = DisplayPreferences.shared
        @Bindable var iconPack = IconPack.shared
        Form {
            Section {
                SettingsRow("界面风格") {
                    FormSegmented("界面风格", selection: $prefs.interfaceStyle) {
                        ForEach(InterfaceStyle.allCases) { style in
                            Text(style.title).tag(style)
                        }
                    }
                    .labelsHidden()
                }

                SettingsRow("图标") {
                    Picker("图标", selection: $iconPack.choice) {
                        Text("跟随界面风格").tag("")
                        Divider()
                        ForEach(IconPack.choices, id: \.id) { pack in
                            Text(verbatim: pack.title).tag(pack.id)
                        }
                    }
                    .labelsHidden()
                    .formPicker()
                    .fixedSize()
                }
            }

            if prefs.materialApplies {
                Section {
                    SettingsRow(String(localized: "材质"), detail: prefs.reduceTransparency ? String(localized: "系统已开启「降低透明度」。") : nil) {
                        FormSegmented("材质", selection: $prefs.windowMaterial) {
                            ForEach(WindowMaterial.available) { material in
                                Text(material.title).tag(material)
                            }
                        }
                        .labelsHidden()
                        .disabled(prefs.reduceTransparency)
                    }

                    if !prefs.reduceTransparency, prefs.windowMaterial != .solid {
                        SettingsRow("侧栏透明度") {
                            SettingsNumberSlider(value: $prefs.sidebarTransparency, range: 0...100, step: 5, suffix: "%", defaultValue: 60)
                        }
                        SettingsRow("主区透明度") {
                            SettingsNumberSlider(value: $prefs.contentTransparency, range: 0...100, step: 5, suffix: "%", defaultValue: 0)
                        }
                    }
                }
            }

            InspectorViewsSettings()

            SettingsScopeFooter()
        }
        .riffetForm()
    }
}

/// 排版: the transcript's text size, spacing and reading width, with a sample that follows them.
struct TypographySettings: View {
    @Environment(\.palette) private var palette

    var body: some View {
        @Bindable var prefs = DisplayPreferences.shared
        Form {
            Section {
                SettingsRow("文字大小") {
                    FormSegmented("文字大小", selection: $prefs.textScale) {
                        Text("小").tag(0.9)
                        Text("标准").tag(1.0)
                        Text("大").tag(1.1)
                        Text("特大").tag(1.2)
                    }
                    .labelsHidden()
                }

                SettingsRow("间距") {
                    FormSegmented("间距", selection: $prefs.density) {
                        Text("紧凑").tag(0.75)
                        Text("标准").tag(1.0)
                        Text("宽松").tag(1.25)
                    }
                    .labelsHidden()
                }

                SettingsRow("阅读宽度") {
                    SettingsNumberSlider(value: $prefs.contentWidth, range: 640...1600, step: 20, suffix: " pt", defaultValue: DisplayPreferences.defaultContentWidth)
                }

                SettingsRow("章节导航") {
                    Toggle("章节导航", isOn: $prefs.chapterNavigation)
                        .labelsHidden()
                        .toggleStyle(.switch)
                }

                if prefs.style.rightPanel == .outline {
                    SettingsRow("会话右侧") {
                        FormSegmented("会话右侧", selection: $prefs.sessionOverview) {
                            Text("概览").tag(true)
                            Text("仅导航条").tag(false)
                        }
                        .labelsHidden()
                    }
                }

                SettingsRow("导航条样式") {
                    FormSegmented("导航条样式", selection: $prefs.railDots) {
                        Text("线").tag(false)
                        Text("圆点").tag(true)
                    }
                    .labelsHidden()
                }
            }

            Section {
                preview(density: prefs.density, contentWidth: prefs.contentWidth)
            }

            SettingsScopeFooter()
        }
        .riffetForm()
    }

    /// The preview keeps the app's real palette and spacing; its column narrows with the reading
    /// width preference (640–1600 maps to 300–600) so moving the slider has a visible effect.
    private func preview(density: Double, contentWidth: Double) -> some View {
        let fraction = min(max((contentWidth - 640) / (1600 - 640), 0), 1)
        let width = 300 + CGFloat(fraction) * 300
        return VStack(alignment: .leading, spacing: Space.md * CGFloat(density)) {
            Text("今天的工作")
                .font(.riffet(size: S(15), weight: .semibold))
                .foregroundStyle(palette.fg)
            Text("先检查项目进度，再继续处理等待确认的会话。")
                .font(.riffet(size: S(13)))
                .foregroundStyle(palette.fg2)
        }
        .padding(Space.lg)
        .frame(maxWidth: width, alignment: .leading)
        .background(palette.formFill(palette.bgElevated), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(palette.line)
        )
        .padding(.vertical, Space.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 终端: the embedded terminal's typography, interaction, and scroll behavior.
struct TerminalSettings: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.palette) private var palette

    private static let monospaceFamilies: [String] = {
        let manager = NSFontManager.shared
        return manager.availableFontFamilies
            .filter { family in
                guard let font = manager.font(withFamily: family, traits: [], weight: 5, size: 12) else { return false }
                return manager.traits(of: font).contains(.fixedPitchFontMask)
            }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }()

    var body: some View {
        @Bindable var prefs = DisplayPreferences.shared
        let families = (!prefs.terminalFontFamily.isEmpty && !Self.monospaceFamilies.contains(prefs.terminalFontFamily))
            ? [prefs.terminalFontFamily] + Self.monospaceFamilies
            : Self.monospaceFamilies
        Form {
            Section {
                terminalPreview(prefs: prefs)
            }

            Section {
                SettingsRow("字体") {
                    Picker("", selection: $prefs.terminalFontFamily) {
                        Text("跟随应用等宽字体").tag("")
                        Divider()
                        ForEach(families, id: \.self) { family in
                            Text(family).tag(family)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 220)
                }

                SettingsRow("字号") {
                    SettingsNumberSlider(
                        value: $prefs.terminalFontSize,
                        range: DisplayPreferences.terminalFontSizeRange,
                        step: 0.5,
                        suffix: " pt",
                        defaultValue: DisplayPreferences.defaultTerminalFontSize
                    )
                }

                SettingsRow("字重") {
                    Picker("", selection: $prefs.terminalFontWeight) {
                        Text("常规").tag(TerminalFontWeight.regular)
                        Text("中等").tag(TerminalFontWeight.medium)
                        Text("半粗").tag(TerminalFontWeight.semibold)
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                }

                SettingsRow("水平边距") {
                    SettingsNumberSlider(
                        value: $prefs.terminalHorizontalPadding, range: 0...48, step: 2, suffix: " pt",
                        defaultValue: DisplayPreferences.defaultTerminalHorizontalPadding
                    )
                }

                SettingsRow("垂直边距") {
                    SettingsNumberSlider(
                        value: $prefs.terminalVerticalPadding, range: 0...32, step: 2, suffix: " pt",
                        defaultValue: DisplayPreferences.defaultTerminalVerticalPadding
                    )
                }
            }

            Section {
                SettingsRow("光标样式") {
                    Picker("", selection: $prefs.terminalCursorStyle) {
                        Text("方块").tag(TerminalCursorShape.block)
                        Text("下划线").tag(TerminalCursorShape.underline)
                        Text("竖线").tag(TerminalCursorShape.bar)
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                }

                SettingsRow("光标闪烁") {
                    Toggle("", isOn: $prefs.terminalCursorBlink).labelsHidden()
                }

                SettingsRow("选中即复制") {
                    Toggle("", isOn: $prefs.terminalCopyOnSelect).labelsHidden()
                }

                SettingsRow("右键行为") {
                    Picker("", selection: $prefs.terminalRightClick) {
                        Text("菜单").tag(TerminalRightClickBehavior.menu)
                        Text("复制或粘贴").tag(TerminalRightClickBehavior.copyPaste)
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                }

                SettingsRow("Option 作为 Meta 键") {
                    Toggle("", isOn: $prefs.terminalOptionAsMeta).labelsHidden()
                }

                SettingsRow("响铃提醒") {
                    Picker("", selection: $prefs.terminalBell) {
                        Text("关闭").tag(TerminalBellMode.none)
                        Text("闪烁").tag(TerminalBellMode.visual)
                        Text("声音").tag(TerminalBellMode.sound)
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                }
            }

            Section {
                SettingsRow("输入时滚到底部") {
                    Toggle("", isOn: $prefs.terminalScrollOnInput).labelsHidden()
                }

                SettingsRow("新输出时滚到底部") {
                    Toggle("", isOn: $prefs.terminalScrollOnOutput).labelsHidden()
                }

                SettingsRow("滚轮速度") {
                    SettingsNumberSlider(
                        value: $prefs.terminalScrollSensitivity,
                        range: DisplayPreferences.terminalScrollSensitivityRange,
                        step: 0.1,
                        suffix: "×",
                        defaultValue: DisplayPreferences.defaultTerminalScrollSensitivity
                    )
                }
            }

            SettingsScopeFooter()
        }
        .riffetForm()
    }

    @ViewBuilder
    private func terminalPreview(prefs: DisplayPreferences) -> some View {
        let dark = colorScheme == .dark
        let entry = ThemeStore.shared.entry
        let page = dark ? entry.values.dark : entry.values.light
        let ansi = TerminalANSI.colors(entry.ansi, dark: dark)
        let bg = Color(nsColor: TerminalANSI.nativeColor(page.bg))
        let fg = Color(nsColor: TerminalANSI.nativeColor(page.fg))
        let green = ansi.count > 2 ? Color(nsColor: TerminalANSI.nativeColor(ansi[2])) : palette.accent
        let cyan = ansi.count > 6 ? Color(nsColor: TerminalANSI.nativeColor(ansi[6])) : palette.accent
        let yellow = ansi.count > 3 ? Color(nsColor: TerminalANSI.nativeColor(ansi[3])) : palette.fg2
        let muted = ansi.count > 8 ? Color(nsColor: TerminalANSI.nativeColor(ansi[8])) : palette.fg3
        let resolvedFont = TerminalController.resolveTerminalFont(
            family: prefs.terminalFontFamily,
            size: CGFloat(prefs.terminalFontSize),
            weight: prefs.terminalFontWeight
        )
        let swiftFont = Font(resolvedFont)
        let hPad = CGFloat(prefs.terminalHorizontalPadding)
        let vPad = CGFloat(prefs.terminalVerticalPadding)

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.xs) {
                Image(icon: "terminal")
                    .font(RiffetFont.caption)
                    .foregroundStyle(palette.fg3)
                Text("zsh · ~/riffet")
                    .font(RiffetFont.codeSmall)
                    .foregroundStyle(palette.fg3)
                Spacer()
                Text("\(Int(prefs.terminalHorizontalPadding))×\(Int(prefs.terminalVerticalPadding))")
                    .font(RiffetFont.codeSmall)
                    .foregroundStyle(palette.fg4)
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.xs)
            .background(palette.formFill(palette.bgElevated))

            Divider()

            VStack(alignment: .leading, spacing: Space.xxs) {
                HStack(spacing: Space.xs) {
                    Text("~/riffet").foregroundStyle(green)
                    Text("main").foregroundStyle(cyan)
                    Text("pnpm test").bold()
                }
                HStack(spacing: Space.xs) {
                    Text("✓").foregroundStyle(green)
                    Text("terminal").bold()
                    Text("12 passed").foregroundStyle(muted)
                    Text("42ms").foregroundStyle(yellow)
                }
                HStack(spacing: Space.xs) {
                    Text("❯").foregroundStyle(green)
                    Text("git status")
                    terminalCursorPreview(style: prefs.terminalCursorStyle, color: fg, size: CGFloat(prefs.terminalFontSize))
                }
            }
            .font(swiftFont)
            .foregroundStyle(fg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, hPad)
            .padding(.vertical, vPad)
            .background(bg)
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(palette.line)
        )
        .padding(.vertical, Space.xs)
    }

    @ViewBuilder
    private func terminalCursorPreview(style: TerminalCursorShape, color: Color, size: CGFloat) -> some View {
        switch style {
        case .block:
            Rectangle().fill(color).frame(width: max(6, size * 0.58), height: size * 1.15)
        case .underline:
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                Rectangle().fill(color).frame(width: max(6, size * 0.58), height: 2)
            }
            .frame(height: size * 1.15)
        case .bar:
            Rectangle().fill(color).frame(width: 2, height: size * 1.15)
        }
    }
}

/// 图标: the Dock icon while Riffet runs, and the permission mode icon style.
struct AppIconSettings: View {
    @Environment(\.palette) private var palette

    var body: some View {
        @Bindable var prefs = DisplayPreferences.shared
        Form {
            SettingsBlock("应用图标") {
                let current = AppIconVariant.named(prefs.appIcon).id
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: AppIconTile.width, maximum: AppIconTile.width), spacing: Space.md)],
                    alignment: .leading,
                    spacing: Space.md
                ) {
                    ForEach(AppIconVariant.all) { variant in
                        AppIconTile(variant: variant, selected: variant.id == current) {
                            prefs.appIcon = variant.id
                        }
                    }
                }
                .padding(.vertical, Space.xs)

                SettingsHint("退出后 Dock 显示默认图标。")
            }

            SettingsBlock("权限图标") {
                SettingsRow("风格") {
                    FormSegmented("风格", selection: $prefs.permissionIconStyle) {
                        ForEach(PermissionIconStyle.allCases) { style in
                            Text(style.title).tag(style)
                        }
                    }
                    .labelsHidden()
                }

                HStack(spacing: Space.md) {
                    ForEach(PermissionTier.allCases) { tier in
                        HStack(spacing: Space.xs) {
                            PermissionIconView(
                                tier: tier,
                                style: prefs.permissionIconStyle,
                                size: 15,
                                color: tier == .full ? palette.warning : palette.fg2
                            )
                            Text(tier.title)
                                .font(RiffetFont.caption)
                                .foregroundStyle(tier == .full ? palette.warning : palette.fg2)
                        }
                    }
                }
                .padding(.vertical, Space.xs)
            }

            SettingsScopeFooter()
        }
        .riffetForm()
    }
}

/// A slider with its value and a reset to the default beside it.
private struct SettingsNumberSlider: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    var suffix = ""
    let defaultValue: Double
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            Slider(value: $value, in: range, step: step)
                .frame(minWidth: 150)
            Text(verbatim: "\(value.formatted(.number.precision(.fractionLength(0...1)).locale(Locale(identifier: "en_US"))))\(suffix)")
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg2)
                .monospacedDigit()
                .frame(width: 52, alignment: .trailing)
            Button { value = defaultValue } label: {
                Image(icon: "arrow.counterclockwise")
                    .font(.riffet(size: S(12)))
            }
            .buttonStyle(IconButtonStyle(size: 24))
            .help("恢复默认")
            .disabled(value == defaultValue)
        }
    }
}

/// One theme in the picker: a miniature of the palette it would paint and its name. The line that
/// tells the reader what it feels like is the tooltip.
private struct ThemePreviewCard: View {
    let entry: ThemeEntry
    let selected: Bool
    let dark: Bool
    let action: () -> Void
    @Environment(\.palette) private var palette

    private var values: RiffetPaletteValues { dark ? entry.values.dark : entry.values.light }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Space.sm) {
                preview
                HStack(spacing: Space.xs) {
                    Text(entry.name)
                        .font(.riffet(size: S(12.5), weight: .medium))
                        .foregroundStyle(palette.fg)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if selected {
                        Image(icon: "checkmark.circle.fill")
                            .font(.riffet(size: S(12), weight: .semibold))
                            .foregroundStyle(palette.accent)
                    }
                }
            }
            .padding(Space.sm)
            .background(palette.formFill(palette.bgElevated), in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.container, style: .continuous)
                    .strokeBorder(selected ? palette.accent : palette.lineSoft, lineWidth: selected ? 1.5 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(entry.summary)
        .accessibilityLabel("\(entry.name)，\(entry.summary)")
        .accessibilityAddTraits(selected ? .isSelected : AccessibilityTraits())
    }

    private var preview: some View {
        let gradientHalf = dark ? entry.gradient?.dark : entry.gradient?.light
        let cardOpacity = entry.gradient?.cardOpacity ?? 1
        return HStack(spacing: 0) {
            Color.clear
                .frame(width: Space.lg + Space.xxs)
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack(spacing: Space.xxs) {
                        Circle()
                            .fill(color(values.accent))
                            .frame(width: 6, height: 6)
                        line(values.fg, width: 46)
                    }
                    line(values.fg2, width: 38)
                    line(values.fg3, width: 30)
                }
                .padding(Space.sm)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(color(values.bg).opacity(cardOpacity))
        }
        .frame(height: Space.xxl + Space.xl)
        .background(ThemeCanvasBackground(gradient: gradientHalf, fallback: color(values.bgSidebar)))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(color(values.lineSoft))
        )
    }

    private func line(_ rgba: RiffetRGBA, width: CGFloat) -> some View {
        Capsule()
            .fill(color(rgba))
            .frame(width: width, height: 3)
    }

    private func color(_ rgba: RiffetRGBA) -> Color {
        Color(.sRGB, red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha)
    }
}

/// The gallery's last card: a new custom theme, shaped like the theme cards around it.
private struct NewThemeCard: View {
    let action: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Space.sm) {
                Image(icon: "plus")
                    .font(.riffet(size: S(14), weight: .medium))
                    .foregroundStyle(palette.fg3)
                    .frame(maxWidth: .infinity)
                    .frame(height: Space.xxl + Space.xl)
                    .background(hovering ? palette.bgHover : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                Text("新建主题")
                    .font(.riffet(size: S(12.5), weight: .medium))
                    .foregroundStyle(palette.fg2)
                    .lineLimit(1)
            }
            .padding(Space.sm)
            .overlay(
                RoundedRectangle(cornerRadius: Radius.container, style: .continuous)
                    .strokeBorder(palette.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            )
            .contentShape(RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
            .opacity(enabled ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 && enabled }
    }
}

/// One Dock icon choice: the icon's dark tile with the mark sized as in the favicon, selected the
/// way a theme card is.
private struct AppIconTile: View {
    static let side: CGFloat = 52
    /// The tile plus the gap to its selection ring.
    static let width = side + 2 * Space.xs

    let variant: AppIconVariant
    let selected: Bool
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let radius = Self.side * 0.22
        Button(action: action) {
            BrandMark(front: .white, back: variant.accent)
                .frame(width: Self.side * 0.87, height: Self.side * 0.87)
                .frame(width: Self.side, height: Self.side)
                .background(AppIconVariant.tile, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
                .padding(Space.xs)
                .overlay(
                    RoundedRectangle(cornerRadius: radius + Space.xs, style: .continuous)
                        .strokeBorder(selected ? palette.accent : palette.lineSoft, lineWidth: selected ? 1.5 : 1)
                )
                .overlay(alignment: .topTrailing) {
                    if selected {
                        Image(icon: "checkmark.circle.fill")
                            .font(.riffet(size: S(13), weight: .semibold))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, palette.accent)
                            .offset(x: Space.xs, y: -Space.xs)
                    }
                }
                .contentShape(RoundedRectangle(cornerRadius: radius + Space.xs, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(variant.name)
        .accessibilityLabel(variant.name)
        .accessibilityAddTraits(selected ? .isSelected : AccessibilityTraits())
    }
}
