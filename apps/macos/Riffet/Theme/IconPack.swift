import AppKit
import Observation
import os
import SwiftUI

/// The icon pack on screen: the reader's choice, else the interface style's.
///
/// Call sites keep naming SF Symbols; `Image(icon:)`, `Label(_:icon:)` and `NSImage.icon(_:accessibilityDescription:)`
/// swap in the pack's custom symbol (Icons.xcassets, from scripts/gen-macos-icons.ts) when the pack is not
/// `sf-symbols` and the name is in the map. A custom symbol scales with `.font`, sits on the baseline and takes
/// `foregroundStyle` like the system one. `AgentMarks` and `BrandMark` draw their own images and never come through here.
@MainActor
@Observable
final class IconPack {
    static let shared = IconPack()
    /// The system's own symbols: no swap.
    nonisolated static let system = "sf-symbols"
    private static let defaultsKey = "riffet.icon-pack"

    /// SF Symbols, then the generated packs: id and display name.
    static let choices: [(id: String, title: String)] = [(system, "SF Symbols")] + IconSymbols.packs

    /// The reader's pick; empty follows the interface style.
    var choice: String {
        didSet {
            UserDefaults.standard.set(choice, forKey: Self.defaultsKey)
            publish()
        }
    }

    /// The pack in use. Reading it in a body tracks both the pick and the interface style.
    var effective: String { choice.isEmpty ? DisplayPreferences.shared.style.icons : choice }

    /// What off-main callers (the transcript lays out on a background queue) read; the main thread reads `effective` itself.
    private nonisolated static let published = OSAllocatedUnfairLock(initialState: system)

    private init() {
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey) ?? ""
        choice = Self.choices.contains { $0.id == stored } ? stored : ""
        publish()
        observeStyle()
    }

    private func publish() {
        let pack = effective
        Self.published.withLock { $0 = pack }
    }

    /// The style default changes through `DisplayPreferences`, not through `choice`.
    private func observeStyle() {
        withObservationTracking { _ = effective } onChange: { [weak self] in
            Task { @MainActor in
                self?.publish()
                self?.observeStyle()
            }
        }
    }

    /// The pack in use, from any thread.
    nonisolated private static func current() -> String {
        if Thread.isMainThread { return MainActor.assumeIsolated { shared.effective } }
        return published.withLock { $0 }
    }

    /// Which `<pack>.<key>` images exist; a pack id nothing generated (a stale preference) draws the system symbol.
    private nonisolated static let installed = OSAllocatedUnfairLock<[String: Bool]>(initialState: [:])

    /// The custom symbol standing in for an SF Symbol name, or nil to draw the system symbol: one dictionary lookup.
    nonisolated static func asset(for symbol: String) -> String? {
        let pack = current()
        guard pack != system, let key = IconSymbols.keys[symbol] else { return nil }
        let asset = pack + "." + key
        let exists = installed.withLock { cache -> Bool in
            if let known = cache[asset] { return known }
            let found = NSImage(named: asset) != nil
            cache[asset] = found
            return found
        }
        return exists ? asset : nil
    }

    /// What VoiceOver reads for a custom symbol: the key's words (`ArrowUpRight` is "Arrow Up Right").
    nonisolated static func label(of asset: String) -> String {
        var words = ""
        for character in asset.drop(while: { $0 != "." }).dropFirst() {
            if character.isUppercase, !words.isEmpty { words.append(" ") }
            words.append(character)
        }
        return words
    }
}

extension Image {
    /// `Image(systemName:)` that follows the icon pack.
    nonisolated init(icon name: String) {
        if let asset = IconPack.asset(for: name) {
            self.init(asset, bundle: .main, label: Text(IconPack.label(of: asset)))
        } else {
            self.init(systemName: name)
        }
    }
}

extension Label where Title == Text, Icon == Image {
    /// `Label(_:systemImage:)` that follows the icon pack.
    nonisolated init(_ titleKey: LocalizedStringKey, icon name: String) {
        self.init { Text(titleKey) } icon: { Image(icon: name) }
    }

    @_disfavoredOverload
    nonisolated init<S: StringProtocol>(_ title: S, icon name: String) {
        self.init { Text(title) } icon: { Image(icon: name) }
    }
}

extension NSImage {
    /// `NSImage(systemSymbolName:accessibilityDescription:)` that follows the icon pack.
    nonisolated static func icon(_ name: String, accessibilityDescription: String? = nil) -> NSImage? {
        guard let asset = IconPack.asset(for: name), let image = NSImage(named: asset) else {
            return NSImage(systemSymbolName: name, accessibilityDescription: accessibilityDescription)
        }
        // `NSImage(named:)` is the shared instance; a description goes on a copy.
        guard let accessibilityDescription, let copy = image.copy() as? NSImage else { return image }
        copy.accessibilityDescription = accessibilityDescription
        return copy
    }
}

extension ContentUnavailableView where Label == SwiftUI.Label<Text, Image>, Description == Text?, Actions == EmptyView {
    /// `ContentUnavailableView(_:systemImage:description:)` in the current icon pack.
    init(_ title: LocalizedStringKey, icon: String, description: Text? = nil) {
        self.init(label: { SwiftUI.Label { Text(title) } icon: { Image(icon: icon) } }, description: { description }, actions: { EmptyView() })
    }

    @_disfavoredOverload
    init<S: StringProtocol>(_ title: S, icon: String, description: Text? = nil) {
        self.init(label: { SwiftUI.Label { Text(title) } icon: { Image(icon: icon) } }, description: { description }, actions: { EmptyView() })
    }
}
