import SwiftUI

// 外观 (theme, display mode) and 语言: settings that only concern this phone.

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
                            ThemePreview(values: theme.values)
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

/// Light, dark or the system's, shown in the current theme.
struct DisplayModeSettingsView: View {
    @Environment(ThemeStore.self) private var themeStore
    @AppStorage("riffet.ios.appearance") private var appearance = "system"
    private static let modes: [(id: String, title: LocalizedStringKey)] = [("system", "跟随系统"), ("light", "浅色"), ("dark", "深色")]

    var body: some View {
        RiffetForm {
            Section {
                HStack(spacing: 14) {
                    ForEach(Self.modes, id: \.id) { mode in
                        PreviewChoice(title: Text(mode.title), selected: appearance == mode.id) {
                            withAnimation(RiffetMotion.effects) { appearance = mode.id }
                        } preview: {
                            ModePreview(values: themeStore.entry.values, mode: mode.id)
                        }
                    }
                }
                .padding(.vertical, 4)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
            } footer: { Text("仅保存在这台设备") }
        }
        .navigationTitle(String(localized: "显示模式", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
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
private struct PageSketch: View {
    let colors: RiffetPaletteValues
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(rgba: colors.bg)
            VStack(alignment: .leading, spacing: 5) {
                Capsule().fill(Color(rgba: colors.fg)).frame(width: 30, height: 4)
                Capsule().fill(Color(rgba: colors.fg3)).frame(width: 40, height: 3)
                Capsule().fill(Color(rgba: colors.fg3)).frame(width: 26, height: 3)
                Spacer(minLength: 0)
                HStack {
                    Spacer(minLength: 0)
                    RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color(rgba: colors.bgBubble))
                        .frame(width: 30, height: 12)
                }
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color(rgba: colors.bgSubtle)).frame(height: 12)
                    Circle().fill(Color(rgba: colors.accent)).frame(width: 12, height: 12)
                }
            }
            .padding(9)
        }
    }
}

/// 跟随系统 shows both halves side by side, split down the middle.
private struct ModePreview: View {
    let values: RiffetThemeValues
    let mode: String
    var body: some View {
        Group {
            switch mode {
            case "light": PageSketch(colors: values.light)
            case "dark": PageSketch(colors: values.dark)
            default:
                PageSketch(colors: values.light)
                    .overlay {
                        PageSketch(colors: values.dark)
                            .mask(HStack(spacing: 0) { Color.clear; Color.black })
                    }
            }
        }
        .frame(height: 112)
    }
}

/// A theme in the half the app is showing now.
private struct ThemePreview: View {
    let values: RiffetThemeValues
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        PageSketch(colors: scheme == .dark ? values.dark : values.light).frame(height: 96)
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

struct LanguageSettingsView: View {
    @State private var selection = AppLanguage.current
    var body: some View {
        RiffetForm {
            Section {
                ForEach(AppLanguage.allCases) { language in
                    SettingsCheckRow(title: language.name, selected: selection == language) {
                        selection = language
                        AppLocalization.shared.apply(language)
                    }
                }
            }
        }
        .navigationTitle(String(localized: "语言", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }
}
