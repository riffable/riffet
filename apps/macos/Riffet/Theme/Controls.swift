import AppKit
import SwiftUI

// BEGIN GENERATED motion (scripts/gen-design-tokens.ts)
/// The three animation tiers (docs/design/macos-native.md 3.1); nothing in the app picks a free duration.
enum Motion {
    /// Hover, press, a check, an icon changing shape.
    static let fast = Animation.snappy(duration: 0.15)
    /// Cross-fades, menus and popovers, the selection pill sliding.
    static let standard = Animation.snappy(duration: 0.2)
    /// Panels, a sidebar's content, sheets, the search panel.
    static let expressive = Animation.smooth(duration: 0.3)
}
// END GENERATED motion

// BEGIN GENERATED space (scripts/gen-design-tokens.ts)
/// Spacing steps used everywhere (docs/design/system/foundations.md 3); nothing in the app picks a free number.
enum Space {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}
// END GENERATED space

/// The width the transcript and its composer share, so the input lines up with what it answers.
@MainActor
enum Column {
    /// The reading width the reader chose (640–1600, 640 by default).
    static var width: CGFloat { CGFloat(DisplayPreferences.shared.contentWidth) }
    static let gutter: CGFloat = 28
}

/// An indeterminate spinner that animates on its own thread. SwiftUI's `ProgressView` spinner
/// re-lays out its host every frame, which keeps the whole window's display cycle (and the
/// pointer, when the system pointer is customised) busy for as long as it spins.
struct Spinner: NSViewRepresentable {
    var size: NSControl.ControlSize = .small

    func makeNSView(context: Context) -> NSProgressIndicator {
        let indicator = NSProgressIndicator()
        indicator.style = .spinning
        indicator.isIndeterminate = true
        indicator.usesThreadedAnimation = true
        indicator.controlSize = size
        indicator.startAnimation(nil)
        return indicator
    }

    func updateNSView(_ indicator: NSProgressIndicator, context: Context) {
        indicator.controlSize = size
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSProgressIndicator, context: Context) -> CGSize? {
        switch size {
        case .mini: CGSize(width: 10, height: 10)
        case .small: CGSize(width: 16, height: 16)
        default: CGSize(width: 32, height: 32)
        }
    }
}

/// A button drawn by its own label that opens an AppKit menu of [options] under itself. A SwiftUI
/// `Menu` styled `.borderlessButton` ignores the label's styling on macOS 26 (an accent-coloured
/// title with the chevron in front), so the look of selects is ours this way.
struct ChoiceMenu<Label: View>: View {
    let options: [ChoiceOption]
    @ViewBuilder let label: Label
    @State private var anchor = MenuAnchor()

    var body: some View {
        Button { anchor.popUp(options) } label: { label.contentShape(Rectangle()) }
            .buttonStyle(.plain)
            .background(MenuAnchorView(anchor: anchor))
    }
}

struct ChoiceOption {
    let title: String
    let selected: Bool
    let action: () -> Void
}

extension NSMenu {
    /// [options] as a menu, the chosen ones checked.
    @MainActor static func choices(_ options: [ChoiceOption]) -> NSMenu {
        let menu = NSMenu()
        for option in options {
            let item = MenuAction.item(option.title, option.action)
            item.state = option.selected ? .on : .off
            menu.addItem(item)
        }
        return menu
    }
}

/// Where a `ChoiceMenu` opens its menu.
final class MenuAnchor {
    weak var view: NSView?

    @MainActor
    func popUp(_ options: [ChoiceOption]) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var selected: (() -> Void)?
        for option in options {
            let item = MenuAction.item(option.title) { selected = option.action }
            item.state = option.selected ? .on : .off
            menu.addItem(item)
        }
        if popUp(menu) { selected?() }
    }

    @MainActor
    @discardableResult
    func popUp(_ menu: NSMenu, aboveAnchor: Bool = false) -> Bool {
        guard let view, let window = view.window else { return false }
        let selected = menu.popUpStyled(at: NSPoint(x: 0, y: view.isFlipped ? view.bounds.height + 4 : -4), in: view, aboveAnchor: aboveAnchor)
        // A page or terminal can change while the menu's nested event loop is running.
        return selected && view.window === window
    }
}

struct MenuAnchorView: NSViewRepresentable {
    let anchor: MenuAnchor

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        anchor.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) { anchor.view = view }
}

/// A quiet control: neutral text, a background only on hover or press. The composer's model, mode
/// and approval pickers and the inspector's toolbars use it; accent colour is kept for the one
/// primary action on screen.
/// A chip's size: the toolbar's, or a larger one where chips are the row's main controls (the line
/// composer's environment row).
struct ChipMetrics: Equatable {
    var height: CGFloat = 26
    var text: CGFloat = 12

    static let row = ChipMetrics(height: 28, text: 13)
}

extension EnvironmentValues {
    @Entry var chipMetrics = ChipMetrics()
    /// Chips carry a hairline at rest: a lined form outlines every control (`LinedFormStyle`).
    @Entry var chipOutlined = false
}

struct ChipButtonStyle: ButtonStyle {
    var active = false
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled
    @Environment(\.chipMetrics) private var metrics
    @Environment(\.chipOutlined) private var outlined

    func makeBody(configuration: Configuration) -> some View {
        ChipBody(configuration: configuration, active: active, palette: palette, enabled: enabled, metrics: metrics, outlined: outlined)
    }

    private struct ChipBody: View {
        let configuration: Configuration
        let active: Bool
        let palette: Palette
        let enabled: Bool
        let metrics: ChipMetrics
        let outlined: Bool
        @State private var hovering = false

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: metrics == ChipMetrics() ? Radius.control : Radius.container, style: .continuous)
            configuration.label
                .font(.riffet(size: S(metrics.text)))
                .foregroundStyle(enabled ? (active ? palette.fg : palette.fg2) : palette.fg4)
                .padding(.horizontal, 8)
                .frame(height: metrics.height)
                .background(
                    shape.fill(configuration.isPressed ? palette.bgActive : (hovering || active) ? palette.bgHover : .clear)
                )
                .overlay(shape.strokeBorder(outlined ? palette.line : .clear))
                .contentShape(shape)
                .onHover { hovering = $0 && enabled }
                .animation(Motion.fast, value: hovering)
        }
    }
}

/// A square icon button that shows its target only on hover.
struct IconButtonStyle: ButtonStyle {
    var size: CGFloat = 26
    /// The place this button leads to is the one on screen.
    var active = false
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        IconBody(configuration: configuration, size: size, active: active, palette: palette, enabled: enabled)
    }

    private struct IconBody: View {
        let configuration: Configuration
        let size: CGFloat
        let active: Bool
        let palette: Palette
        let enabled: Bool
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.riffet(size: S(13), weight: .regular))
                .foregroundStyle(enabled ? (hovering || active ? palette.fg : palette.fg3) : palette.fg4)
                .frame(width: size, height: size)
                .background(
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .fill(configuration.isPressed || active ? palette.bgActive : hovering ? palette.bgHover : .clear)
                )
                .contentShape(Rectangle())
                .onHover { hovering = $0 && enabled }
        }
    }
}

/// A row that tints on hover, for list rows that are buttons (tool calls, files, palette entries).
struct HoverRowStyle: ButtonStyle {
    /// The style's control radius unless the row asks for its own.
    var radius: CGFloat?
    @Environment(\.palette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        HoverRowBody(configuration: configuration, radius: radius ?? Radius.control, palette: palette)
    }

    private struct HoverRowBody: View {
        let configuration: Configuration
        let radius: CGFloat
        let palette: Palette
        @State private var hovering = false

        var body: some View {
            configuration.label
                .background(
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .fill(configuration.isPressed ? palette.bgActive : hovering ? palette.bgHover : .clear)
                )
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

/// A picker chip label: icon, text and a small chevron, truncating the text before anything else.
struct ChipLabel: View {
    let text: String
    var symbol: String?
    /// Kept as text even in a narrow composer (the model name is the one choice worth reading).
    var essential = false
    /// A menu shows its chevron; a switch does not.
    var chevron = true
    @Environment(\.palette) private var palette
    @Environment(\.compactControls) private var compact

    var body: some View {
        HStack(spacing: 5) {
            if let symbol { Image(icon: symbol).font(.riffet(size: S(12))) }
            if !compact || essential || symbol == nil {
                Text(text).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: compact ? 130 : 260, alignment: .leading)
                    .fixedSize(horizontal: !compact, vertical: false)
            }
            if chevron {
                Image(icon: "chevron.down").font(.riffet(size: S(8), weight: .bold)).foregroundStyle(palette.fg4)
            }
        }
        .help(text)
    }
}

private struct CompactControlsKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// The composer is narrow: pickers show their icon and keep the model name short.
    var compactControls: Bool {
        get { self[CompactControlsKey.self] }
        set { self[CompactControlsKey.self] = newValue }
    }
}

extension View {
    /// Hairline card: elevated surface and soft border. The hairline carries the edge; the one faint
    /// shadow only lifts it a little, so cards do not read as panels floating over the page.
    @MainActor
    func card(radius: CGFloat? = nil, palette: Palette) -> some View {
        let radius = radius ?? Radius.floating
        let raised = DisplayPreferences.shared.style.surface == .raised
        return background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(palette.bgElevated)
                .elevation(raised ? .raised : nil)
        )
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(raised ? palette.line : palette.lineStrong, lineWidth: 1))
    }

    /// Liquid Glass on macOS 26; before it, the material and hairline of the composer's menus.
    /// The only caller of `.glassEffect` (perf-lint C1), so every surface falls back the same way.
    @ViewBuilder
    func riffetGlass(in shape: some InsettableShape) -> some View {
        if #available(macOS 26, *) {
            glassEffect(.regular, in: shape) // perf-lint: allow the one pre-26 fallback
        } else {
            background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
        }
    }
}

extension ToolbarContent {
    /// Drops the glass capsule macOS 26 puts behind a toolbar item; earlier systems draw none.
    /// The only caller of `.sharedBackgroundVisibility` (perf-lint C1).
    @ToolbarContentBuilder
    func hideSharedToolbarBackground() -> some ToolbarContent {
        if #available(macOS 26, *) {
            sharedBackgroundVisibility(.hidden) // perf-lint: allow the one pre-26 fallback
        } else {
            self
        }
    }
}

/// What shows behind a workbench window: nothing but the palette, the desktop through a blur, or
/// macOS 26 glass. The palette's sidebar and content colours lie over it at the reader's tint.
enum WindowMaterial: String, CaseIterable, Identifiable {
    case solid, frosted, glass

    var id: String { rawValue }

    var title: String {
        switch self {
        case .solid: String(localized: "不透明")
        case .frosted: String(localized: "磨砂")
        case .glass: String(localized: "玻璃")
        }
    }

    static var defaultValue: WindowMaterial {
        if #available(macOS 26, *) { .glass } else { .solid }
    }

    static var available: [WindowMaterial] {
        if #available(macOS 26, *) { allCases } else { [.solid, .frosted] }
    }
}

/// The window's backdrop. A solid window stays opaque; the others clear the window so the
/// material can blend with what is behind it.
struct WindowBackdrop: NSViewRepresentable {
    let material: WindowMaterial

    final class Backdrop: NSView {
        var material: WindowMaterial? {
            didSet { if material != oldValue { rebuild() } }
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            applyToWindow()
        }

        private func rebuild() {
            subviews.forEach { $0.removeFromSuperview() }
            if let effect = effectView() {
                effect.frame = bounds
                effect.autoresizingMask = [.width, .height]
                addSubview(effect)
            }
            applyToWindow()
        }

        private func effectView() -> NSView? {
            switch material {
            case .frosted:
                let view = NSVisualEffectView()
                view.material = .underWindowBackground
                view.blendingMode = .behindWindow
                view.state = .followsWindowActiveState
                return view
            case .glass:
                if #available(macOS 26, *) {
                    let view = NSGlassEffectView()
                    view.style = .regular
                    return view
                }
                return nil
            case .solid, nil:
                return nil
            }
        }

        private func applyToWindow() {
            guard let window, let material else { return }
            let clear = material != .solid
            window.isOpaque = !clear
            window.backgroundColor = clear ? .clear : .windowBackgroundColor
        }
    }

    func makeNSView(context: Context) -> Backdrop { Backdrop() }

    func updateNSView(_ view: Backdrop, context: Context) { view.material = material }
}

/// A labelled button for dialogs and cards: primary is solid, secondary is a quiet outline.
struct SolidButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, danger, quiet }
    var kind: Kind = .secondary
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.riffet(size: S(12.5), weight: kind == .primary ? .semibold : .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .frame(minHeight: 28)
            .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(background))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(kind == .secondary ? palette.line : .clear))
            .opacity(enabled ? (configuration.isPressed ? 0.82 : 1) : 0.5)
            .contentShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }

    private var foreground: Color {
        switch kind {
        case .primary: palette.primaryFg
        case .secondary: palette.fg
        case .danger: .white
        case .quiet: palette.fg2
        }
    }

    private var background: Color {
        switch kind {
        case .primary: palette.primary
        case .secondary: palette.bgElevated
        case .danger: palette.danger
        case .quiet: .clear
        }
    }
}

/// A disclosure row in a turn's process (`Timeline.tsx`'s `Disclosure`): quiet text that brightens
/// on hover, no fill, and a chevron that only appears under the pointer.
struct DisclosureRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        DisclosureBody(configuration: configuration)
    }

    private struct DisclosureBody: View {
        let configuration: Configuration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .environment(\.disclosureHovered, hovering)
                .opacity(configuration.isPressed ? 0.7 : 1)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

private struct DisclosureHoveredKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var disclosureHovered: Bool {
        get { self[DisclosureHoveredKey.self] }
        set { self[DisclosureHoveredKey.self] = newValue }
    }
}

/// The chevron of a disclosure row: turned when open, shown on hover or while open.
struct DisclosureChevron: View {
    let open: Bool
    var symbol = "chevron.right"
    @Environment(\.palette) private var palette
    @Environment(\.disclosureHovered) private var hovering

    var body: some View {
        Image(icon: symbol)
            .font(.riffet(size: S(9), weight: .semibold))
            .foregroundStyle(palette.fg4)
            .rotationEffect(.degrees(open && symbol == "chevron.right" ? 90 : 0))
            .opacity(hovering || open ? 1 : 0)
    }
}

/// Text of a disclosure row: `fg-3`, `fg-2` under the pointer.
struct DisclosureText: ViewModifier {
    var danger = false
    @Environment(\.palette) private var palette
    @Environment(\.disclosureHovered) private var hovering

    func body(content: Content) -> some View {
        content.foregroundStyle(danger ? palette.danger : hovering ? palette.fg2 : palette.fg3)
    }
}
