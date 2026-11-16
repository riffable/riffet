import AppKit
import CoreText
import SwiftUI

/// The faces the app carries for the interface styles that name one (`StyleSpec.fonts`): Inter and
/// JetBrains Mono, variable, from `Resources/Fonts`. The files are registered for this process the
/// first time anything asks, so there is no launch step to forget; `register()` just asks early.
enum BundledFonts {
    private static let files = ["InterVariable", "JetBrainsMono-Variable"]

    /// By the name a style uses ("Inter") and by the family the file carries ("Inter Variable").
    nonisolated static let faces: [String: ResolvedFont] = {
        var faces: [String: ResolvedFont] = [:]
        for file in files {
            guard let url = Bundle.main.url(forResource: file, withExtension: "ttf")
                    ?? Bundle.main.url(forResource: file, withExtension: "ttf", subdirectory: "Fonts") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor] ?? []
            guard let family = descriptors.first.flatMap({ CTFontDescriptorCopyAttribute($0, kCTFontFamilyNameAttribute) as? String }) else { continue }
            let face = ResolvedFont(id: "bundled:\(family)", family: family, identity: "bundled")
            faces[family] = face
            faces[family.replacingOccurrences(of: " Variable", with: "")] = face
        }
        return faces
    }()

    nonisolated static func register() { _ = faces }
}

/// Which face text is set in: a plugin's font, else the interface style's, else the system's.
enum RiffetFace {
    /// The font in the first source that has one at this size, or nil for the system font.
    /// Safe on any thread: layout queues pass the values they captured on the main thread.
    nonisolated static func nsFont(size: CGFloat, weight: NSFont.Weight = .regular, mono: Bool, plugin: AppearanceFonts, style: StyleSpec.Fonts) -> NSFont? {
        if let font = (mono ? plugin.mono : plugin.ui)?.nsFont(size: size, weight: weight) { return font }
        let name = mono ? style.mono : style.ui
        guard name != "system" else { return nil }
        return BundledFonts.faces[name]?.nsFont(size: size, weight: weight)
    }
}

extension Font {
    /// `Font.system(size:weight:design:)` that follows the interface style's fonts and a plugin's.
    /// `.rounded` and `.serif` stay system; `.monospaced` takes the mono face. Reads observable
    /// state, so call it from a view body (or any main-actor code that is re-run on change).
    @MainActor
    static func riffet(size: CGFloat, weight: Font.Weight? = nil, design: Font.Design? = nil) -> Font {
        let mono: Bool
        switch design {
        case nil, .default?: mono = false
        case .monospaced?: mono = true
        default: return .system(size: size, weight: weight, design: design)
        }
        let plugin = AppearanceStore.shared.fonts
        let style = DisplayPreferences.shared.style.fonts
        if let font = RiffetFace.nsFont(size: size, weight: (weight ?? .regular).nsWeight, mono: mono, plugin: plugin, style: style) {
            return Font(font as CTFont)
        }
        return .system(size: size, weight: weight, design: design)
    }
}

extension NSFont {
    /// The AppKit counterpart of `Font.riffet`: the system font where no plugin or style names one.
    @MainActor
    static func riffet(size: CGFloat, weight: NSFont.Weight = .regular, mono: Bool = false) -> NSFont {
        RiffetFace.nsFont(size: size, weight: weight, mono: mono, plugin: AppearanceStore.shared.fonts, style: DisplayPreferences.shared.style.fonts)
            ?? (mono ? .monospacedSystemFont(ofSize: size, weight: weight) : .systemFont(ofSize: size, weight: weight))
    }

    /// Italic of this font. The bundled faces have no italic file: those are slanted instead.
    nonisolated var riffetItalic: NSFont {
        FontMemo.shared.get("i|\(fontName)|\(pointSize)") { makeItalic() }
    }

    /// The system face with tabular figures, one instance per size and weight.
    nonisolated static func riffetDigits(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        FontMemo.shared.get("s|\(size)|\(weight.rawValue)") { .monospacedDigitSystemFont(ofSize: size, weight: weight) }
    }

    /// The face with tabular figures where it has them (the style's UI face, one instance per face and size).
    nonisolated var riffetTabular: NSFont {
        FontMemo.shared.get("t|\(fontName)|\(pointSize)") {
            let feature: [NSFontDescriptor.FeatureKey: Int] = [.typeIdentifier: kNumberSpacingType, .selectorIdentifier: kMonospacedNumbersSelector]
            return NSFont(descriptor: fontDescriptor.addingAttributes([.featureSettings: [feature]]), size: pointSize) ?? self
        }
    }

    private nonisolated func makeItalic() -> NSFont {
        let traits = fontDescriptor.withSymbolicTraits(.italic)
        if let font = NSFont(descriptor: traits, size: pointSize), font.fontDescriptor.symbolicTraits.contains(.italic) { return font }
        var slant = CGAffineTransform(a: 1, b: 0, c: 0.2, d: 1, tx: 0, ty: 0)
        return CTFontCreateCopyWithAttributes(self as CTFont, pointSize, &slant, nil) as NSFont
    }
}

/// Derived fonts (italic, tabular figures) built once per face and size: each new `NSFont` carries its
/// own glyph cache, and a transcript asked for the same few thousands of times.
final class FontMemo: @unchecked Sendable {
    static let shared = FontMemo()
    private let lock = NSLock()
    private var fonts: [String: NSFont] = [:]
    private static let limit = 256

    nonisolated func get(_ key: String, make: () -> NSFont) -> NSFont {
        lock.lock()
        if let hit = fonts[key] {
            lock.unlock()
            return hit
        }
        lock.unlock()
        let font = make()
        lock.lock()
        if fonts.count >= Self.limit { fonts.removeAll() }
        fonts[key] = font
        lock.unlock()
        return font
    }

    nonisolated func removeAll() {
        lock.lock()
        fonts.removeAll()
        lock.unlock()
    }
}

extension Font.Weight {
    var nsWeight: NSFont.Weight {
        switch self {
        case .ultraLight: .ultraLight
        case .thin: .thin
        case .light: .light
        case .medium: .medium
        case .semibold: .semibold
        case .bold: .bold
        case .heavy: .heavy
        case .black: .black
        default: .regular
        }
    }
}
