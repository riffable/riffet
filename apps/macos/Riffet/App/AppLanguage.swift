import AppKit

/// The interface language (docs/MACOS.md, 界面语言). Chinese unless the reader picked another one,
/// in 外观与显示 or in System Settings → General → Language & Region → Applications: both write
/// this app's own `AppleLanguages`, which the bundle reads once at launch. A change therefore
/// applies after the app restarts; the server is its own LaunchAgent and keeps running.
enum AppLanguage: String, CaseIterable, Identifiable {
    case chinese = "zh-Hans"
    case english = "en"

    var id: String { rawValue }

    /// The option's name in its own language, whichever one the interface is in.
    var name: String {
        switch self {
        case .chinese: "中文" // i18n-ignore: an endonym, the same in every interface language
        case .english: "English"
        }
    }

    private static let key = "AppleLanguages"

    /// Writes Chinese when nothing chose a language yet, so a Mac set to English still opens in
    /// Chinese. Call before anything resolves a string.
    static func applyDefault() {
        guard ownChoice == nil else { return }
        UserDefaults.standard.set([chinese.rawValue], forKey: key)
    }

    /// The language the next launch uses.
    static var chosen: AppLanguage {
        get { matching(ownChoice?.first) }
        set { UserDefaults.standard.set([newValue.rawValue], forKey: key) }
    }

    /// The language this process shows.
    static let running = matching(Bundle.main.preferredLocalizations.first)

    /// The app's own domain only: `UserDefaults.standard` falls back to the system's language list.
    private static var ownChoice: [String]? {
        guard let id = Bundle.main.bundleIdentifier else { return nil }
        return UserDefaults.standard.persistentDomain(forName: id)?[key] as? [String]
    }

    /// System Settings may store a region with the language (`en-GB`, `zh-Hans-CN`).
    private static func matching(_ identifier: String?) -> AppLanguage {
        guard let identifier else { return .chinese }
        return Locale(identifier: identifier).language.languageCode == .english ? .english : .chinese
    }

    // MARK: - Restart

    @MainActor private static var restarting = false

    /// Quits, then opens this copy of the app again. Only the app restarts.
    @MainActor
    static func restart() {
        restarting = true
        NSApp.terminate(nil)
    }

    /// From `applicationWillTerminate`, where the quit can no longer be cancelled: waits for this
    /// process to exit, then opens the bundle.
    @MainActor
    static func relaunchIfRestarting() {
        guard restarting else { return }
        let waiter = Process()
        waiter.executableURL = URL(fileURLWithPath: "/bin/sh")
        waiter.arguments = [
            "-c", #"while /bin/kill -0 "$0" 2>/dev/null; do /bin/sleep 0.2; done; exec /usr/bin/open "$1""#,
            String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundlePath,
        ]
        try? waiter.run()
    }
}

/// The locale every formatter uses: the interface language with the Mac's region, so dates and
/// numbers read in the same language as the text around them.
enum AppLocale {
    static let current: Locale = {
        let system = Locale.current
        let language = Bundle.main.preferredLocalizations.first ?? AppLanguage.chinese.rawValue
        if system.language.languageCode == Locale(identifier: language).language.languageCode { return system }
        return Locale(identifier: language + (system.region.map { "_\($0.identifier)" } ?? ""))
    }()
}
