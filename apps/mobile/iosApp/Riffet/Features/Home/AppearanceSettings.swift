import SwiftUI

// 外观 (theme, code theme) and 语言: settings that only concern this phone.

/// The palettes, each drawn as a small page in its own colours.
struct ThemeSettingsView: View {
    @Environment(ThemeStore.self) private var themeStore
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 14), count: 3)

    var body: some View {
        RiffetForm {
            Section {
                LazyVGrid(columns: columns, spacing: 18) {
                    ForEach(ThemeStore.builtins) { theme in
                        PreviewChoice(title: Text(verbatim: theme.name), selected: themeStore.themeId == theme.id) {
                            themeStore.themeId = theme.id
                        } preview: {
                            ThemePreview(theme: Palette.builtin(theme.id))
                        }
                    }
                }
                .padding(.vertical, 4)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
            } footer: { Text("仅保存在这台设备") }
        }
        .navigationTitle(String(localized: "主题", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }
}

/// A picture of a choice with its name under it; the picked one wears an accent ring.
private struct PreviewChoice<Preview: View>: View {
    let title: Text
    let selected: Bool
    let action: () -> Void
    @ViewBuilder let preview: () -> Preview
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                preview()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.line, lineWidth: 0.5))
                    .padding(3)
                    .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).strokeBorder(palette.accent, lineWidth: 2).opacity(selected ? 1 : 0))
                title
                .riffetFont(.caption, weight: selected ? .semibold : .regular)
                .foregroundStyle(selected ? palette.fg : palette.fg2)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(RiffetDimPressStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A sketch of a conversation page in one half of a theme: page, a reply's lines, the reader's bubble.
/// Takes only the six colours it draws: a whole half of a theme is kilobytes, and the theme grid holds dozens.
private struct PageSketch: View {
    let page, text, muted, bubble, field, accent: Color
    init(theme: Palette, dark: Bool) {
        let colors = dark ? theme.values.dark : theme.values.light
        page = Color(rgba: colors.bg); text = Color(rgba: colors.fg); muted = Color(rgba: colors.fg3)
        bubble = Color(rgba: colors.bgBubble); field = Color(rgba: colors.bgSubtle); accent = Color(rgba: colors.accent)
    }
    var body: some View {
        ZStack(alignment: .topLeading) {
            page
            VStack(alignment: .leading, spacing: 5) {
                Capsule().fill(text).frame(width: 30, height: 4)
                Capsule().fill(muted).frame(width: 40, height: 3)
                Capsule().fill(muted).frame(width: 26, height: 3)
                Spacer(minLength: 0)
                HStack {
                    Spacer(minLength: 0)
                    RoundedRectangle(cornerRadius: 5, style: .continuous).fill(bubble)
                        .frame(width: 30, height: 12)
                }
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 5, style: .continuous).fill(field).frame(height: 12)
                    Circle().fill(accent).frame(width: 12, height: 12)
                }
            }
            .padding(9)
        }
    }
}

/// A theme in the half the app is showing now.
private struct ThemePreview: View {
    let theme: Palette
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        PageSketch(theme: theme, dark: scheme == .dark).frame(height: 96)
    }
}

private extension Color {
    init(rgba: RiffetRGBA) {
        self.init(.sRGB, red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha)
    }
}

/// The pushed home-screen icon page; the selection is read back from the system.
struct AppIconSetting: View {
    @State private var icon = AppIconVariant.current
    var body: some View { AppIconPicker(selection: $icon) }
}

/// Code syntax highlighting theme, with a live preview of the selected style.
struct CodeThemeSettingsView: View {
    @Environment(ThemeStore.self) private var themeStore
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme
    @State private var syntax: ConversationSyntax.Result?

    private static let snippet = """
    // Syntax preview
    @tagged("api")
    async function loadConfig(limit = 42): Promise<Config> {
      const mode = true;
      return { name: "riffet", count: limit };
    }
    """

    var body: some View {
        let resolved = themeStore.codeTheme
        let displayed = syntax?.attributed(palette: palette, codeTheme: resolved, dark: scheme == .dark) ?? AttributedString(Self.snippet)
        RiffetForm {
            Section {
                Text(displayed)
                    .riffetFont(.monoSmall)
                    .foregroundStyle(palette.fg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(RiffetMetrics.groupInset)
                    .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.controlRadius, style: .continuous))
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            Section {
                SettingsCheckRow(
                    title: String(localized: "跟随界面主题", bundle: .riffet),
                    selected: themeStore.codeThemeId == "auto"
                ) {
                    themeStore.codeThemeId = "auto"
                }
                ForEach(RiffetCodeThemeCatalog.all, id: \.id) { entry in
                    SettingsCheckRow(
                        title: Self.displayName(for: entry),
                        selected: themeStore.codeThemeId == entry.id
                    ) {
                        themeStore.codeThemeId = entry.id
                    }
                }
            } footer: { Text("仅保存在这台设备") }
        }
        .navigationTitle(String(localized: "代码高亮", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task {
            if syntax == nil {
                syntax = await ConversationSyntax.shared.highlight(Self.snippet, language: "typescript")
            }
        }
    }

    static func displayName(for entry: RiffetCodeThemeValues) -> String {
        entry.id == "monochrome" ? String(localized: "极简墨色", bundle: .riffet) : entry.name
    }
}

// MARK: - Language

/// The language this app runs in. iOS keeps a per-app choice in the app's own `AppleLanguages`
/// (the system's per-app language setting writes the same key); [AppLocalization] switches the running app.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system, zhHans = "zh-Hans", en
    var id: String { rawValue }

    /// Each language in its own name; following the system takes the reader's language.
    var name: String {
        switch self {
        case .system: String(localized: "跟随系统", bundle: .riffet)
        case .zhHans: "简体中文"
        case .en: "English"
        }
    }

    private static let key = "AppleLanguages"

    /// The saved choice: a code the system wrote (`en-US`, `zh-Hans-CN`) maps to its language.
    static var current: AppLanguage {
        let domain = UserDefaults.standard.persistentDomain(forName: Bundle.main.bundleIdentifier ?? "")
        guard let code = (domain?[key] as? [String])?.first else { return .system }
        if code.hasPrefix("en") { return .en }
        if code.hasPrefix("zh") { return .zhHans }
        return .system
    }

    static func save(_ language: AppLanguage) {
        if language == .system { UserDefaults.standard.removeObject(forKey: key) }
        else { UserDefaults.standard.set([language.rawValue], forKey: key) }
    }
}
