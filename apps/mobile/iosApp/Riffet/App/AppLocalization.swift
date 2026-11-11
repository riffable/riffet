import SwiftUI
import RiffetKit

/// The language the running app speaks, switched in place.
///
/// iOS picks an app's localization once at launch, so a switch is carried by hand: SwiftUI's own
/// string lookups (`Text("…")`, titles, buttons) follow the root `\.locale`, every
/// `String(localized:bundle: .riffet)` reads the picked language's table, and the shared Kotlin layer
/// is pinned to the same language. Strings the system draws itself (permission prompts, some system
/// sheets) keep the launch language until the next start, which the saved `AppleLanguages` covers.
@Observable
final class AppLocalization: @unchecked Sendable {
    static let shared = AppLocalization()

    /// `en` or `zh-Hans`.
    private(set) var language: String
    /// Each language's `.lproj`, opened once; read from any thread.
    @ObservationIgnored private let tables: [String: Bundle]

    private init() {
        language = Self.supported(Bundle.main.preferredLocalizations)
        tables = Dictionary(uniqueKeysWithValues: ["zh-Hans", "en"].map { code in
            (code, Bundle.main.path(forResource: code, ofType: "lproj").flatMap(Bundle.init(path:)) ?? .main)
        })
    }

    /// The picked language's string table. Reading it ties the reading view to the language.
    var bundle: Bundle { tables[language] ?? .main }

    /// The reader's region and formats, in the picked language.
    var locale: Locale {
        var components = Locale.Components(locale: .current)
        components.languageComponents = Locale.Language.Components(identifier: language)
        return Locale(components: components)
    }

    /// Saves the choice for the next launch and switches the running app to it.
    @MainActor func apply(_ choice: AppLanguage) {
        AppLanguage.save(choice)
        let next: String = switch choice {
        case .system: Self.supported(UserDefaults.standard.stringArray(forKey: "AppleLanguages") ?? Locale.preferredLanguages)
        case .zhHans: "zh-Hans"
        case .en: "en"
        }
        guard next != language else { return }
        language = next
        L10n.shared.locale = next
    }

    /// The first of `preferences` the app is translated into; Chinese otherwise, as the source language.
    private static func supported(_ preferences: [String]) -> String {
        Bundle.preferredLocalizations(from: ["zh-Hans", "en"], forPreferences: preferences).first ?? "zh-Hans"
    }
}

extension Bundle {
    /// The app's strings in the language the reader picked; pass it to every `String(localized:)`.
    static var riffet: Bundle { AppLocalization.shared.bundle }
}

/// A plugin's text in the app's language: exact tag, then without subtags, then `zh-Hans`, `en`, any.
func localizedText(_ text: [String: String]?, fallback: String) -> String {
    guard let text, !text.isEmpty else { return fallback }
    var tag = AppLocalization.shared.locale.identifier(.bcp47)
    while true {
        if let hit = text[tag] { return hit }
        guard let dash = tag.lastIndex(of: "-") else { break }
        tag = String(tag[..<dash])
    }
    return text["zh-Hans"] ?? text["en"] ?? text.min { $0.key < $1.key }?.value ?? fallback
}
