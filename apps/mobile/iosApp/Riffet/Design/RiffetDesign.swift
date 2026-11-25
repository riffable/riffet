import SwiftUI

// The iPhone's design layer: the type scale, metrics, motion and the few drawn
// components every page shares. The generated regions come from the ios style in
// packages/contracts/src/mobile-styles.ts (`pnpm gen:tokens`), the same values the
// Android client's `IosPreset` draws; materials are the system's.

/// Text roles. Sizes scale with Dynamic Type relative to the listed text style.
enum RiffetText {
    /// Prose, inputs, row titles that are not emphasised.
    case body
    /// Emphasised row titles.
    case headline
    /// Navigation titles.
    case barTitle
    /// Section headers, chips, segmented labels, buttons, tool and turn rows.
    case label
    /// Subtitles, timestamps, captions.
    case caption
    /// Code in prose and code blocks.
    case mono
    /// Commands and paths in tool rows, code block language names.
    case monoSmall

    // BEGIN GENERATED text (scripts/gen-design-tokens.ts)
    fileprivate var size: CGFloat {
        switch self {
        case .body: 16
        case .headline: 16
        case .barTitle: 17
        case .label: 15
        case .caption: 13
        case .mono: 14
        case .monoSmall: 13
        }
    }
    fileprivate var weight: Font.Weight {
        switch self {
        case .body: .regular
        case .headline: .medium
        case .barTitle: .semibold
        case .label: .medium
        case .caption: .regular
        case .mono: .regular
        case .monoSmall: .regular
        }
    }
    // END GENERATED text
    fileprivate var design: Font.Design { self == .mono || self == .monoSmall ? .monospaced : .default }
    fileprivate var style: Font.TextStyle {
        switch self {
        case .body, .headline, .mono: .body
        case .barTitle: .headline
        case .label: .subheadline
        case .caption, .monoSmall: .footnote
        }
    }
}

struct RiffetFont: ViewModifier {
    let role: RiffetText
    let weight: Font.Weight?
    @ScaledMetric private var size: CGFloat
    init(_ role: RiffetText, weight: Font.Weight?) {
        self.role = role
        self.weight = weight
        _size = ScaledMetric(wrappedValue: role.size, relativeTo: role.style)
    }
    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight ?? role.weight, design: role.design))
    }
}

extension View {
    /// Applies a text role from the shared scale; `weight` overrides the role's own.
    /// Returns the concrete type, not `some View`, like every modifier the design layer applies widely: each
    /// opaque layer makes the runtime resolve the type again when SwiftUI instantiates a view's metadata, and
    /// deep pages overflowed the main thread's stack on iOS 27 (ios.md §2, 2026-11-15).
    func riffetFont(_ role: RiffetText, weight: Font.Weight? = nil) -> ModifiedContent<Self, RiffetFont> {
        modifier(RiffetFont(role, weight: weight))
    }
}

/// Layout metrics shared by every page.
enum RiffetMetrics {
    // BEGIN GENERATED metrics (scripts/gen-design-tokens.ts)
    static let pageInset: CGFloat = 16
    static let groupRadius: CGFloat = 16
    static let settingsRowHeight: CGFloat = 52
    static let composerRadius: CGFloat = 24
    static let sendButton: CGFloat = 36
    static let groupInset: CGFloat = 16
    static let controlRadius: CGFloat = 10
    static let rowRadius: CGFloat = 8
    static let selectionRadius: CGFloat = 6
    static let menuRadius: CGFloat = 10
    /// A row's symbol tile: its square and corner.
    static let iconSlot: CGFloat = 30
    static let iconTileRadius: CGFloat = 8
    /// The floating shadow before Liquid Glass: SwiftUI's radius is half the Compose blur.
    static let floatingShadowRadius: CGFloat = 7
    static let floatingShadowY: CGFloat = 4
    static let floatingShadowOpacity: Double = 0.12
    // END GENERATED metrics
    // The iPhone's own: not part of the shared style.
    static let rowMinHeight: CGFloat = 68
    static let avatar: CGFloat = 44
    static let chipHeight: CGFloat = 34
    /// A chip's label inset from its capsule ends.
    static let chipInset: CGFloat = 14
    /// Between something floating (a toast) and the edge or control it clears.
    static let floatingGap: CGFloat = 8
    static let hitTarget: CGFloat = 44
    /// The terminal grid's distance from the screen's sides (Android's terminal uses the same).
    static let terminalInset: CGFloat = 6
    /// How far a viewed pane wider than the screen is scaled down: 8pt text from 12.5pt, as on Android.
    static let terminalMinScale: CGFloat = 8 / 12.5
    /// Added to the terminal's size so its own column count never rounds down.
    static let terminalSlack: CGFloat = 0.5
    /// Between group cards laid out outside a list (a fitted sheet), and from a card to its footnote.
    static let groupGap: CGFloat = 12
    static let footnoteGap: CGFloat = 8
    /// The conversation column on a wide window (iPad, an unfolded iPhone Duo); narrower windows use their full width.
    static let readingWidth: CGFloat = 760
    /// A code block's body in a reply, and a tool's command or output: capped, and scrolled inside the
    /// block both ways (lines do not wrap). Android draws the same caps; a block never takes over 65% of
    /// the visible height either.
    static let codeBlockMaxHeight: CGFloat = 448
    static let codeOutputMaxHeight: CGFloat = 288
}

/// Motion shared by every page, generated from the ios style's tokens: a spring's response is one
/// period of the Compose stiffness, its damping the same ratio.
enum RiffetMotion {
    // BEGIN GENERATED motion (scripts/gen-design-tokens.ts)
    static let spatial = Animation.spring(response: 0.27, dampingFraction: 0.86)
    static let effects = Animation.spring(response: 0.16, dampingFraction: 1)
    static let release = Animation.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.28)
    static let chevron = Animation.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.18)
    // END GENERATED motion
    /// How long a size holds still before it counts as settled (`onSettledSize`).
    static let settle = Duration.milliseconds(120)
}

extension View {
    /// Runs `action` once the view's size has held still: after a sheet that grows into place has finished
    /// growing, since a scroll position set on the way is measured against a size the view no longer has.
    func onSettledSize(_ action: @escaping () -> Void) -> ModifiedContent<Self, SettledSize> {
        modifier(SettledSize(action: action))
    }
}

struct SettledSize: ViewModifier {
    let action: () -> Void
    @State private var size: CGSize?
    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .task(id: size) {
                guard size != nil else { return }
                try? await Task.sleep(for: RiffetMotion.settle)
                if !Task.isCancelled { action() }
            }
    }
}

// MARK: - Glass

extension View {
    /// The floating material: Liquid Glass on iOS 26, a thin material with a soft lift before it.
    @ViewBuilder func riffetGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color.primary.opacity(0.06), lineWidth: 0.5))
                .riffetFloatingShadow()
        }
    }

    /// The one drop shadow: under what floats over the page (a toast, the glass before iOS 26).
    func riffetFloatingShadow() -> some View {
        shadow(color: .black.opacity(RiffetMetrics.floatingShadowOpacity), radius: RiffetMetrics.floatingShadowRadius, y: RiffetMetrics.floatingShadowY)
    }

    /// The soft scroll edge under a bar (iOS 26); earlier systems keep their default edge.
    @ViewBuilder func riffetSoftEdges() -> some View {
        if #available(iOS 26.0, *) {
            scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            self
        }
    }
}

// MARK: - Edges of a reading page

/// Behind a transparent navigation bar over a scrolling page: content passing under the bar is
/// blurred, strongest at the screen edge and gone just below the bar, so the title stays legible while
/// the page still shows through. The system's soft scroll edge alone is too faint for that, so every
/// top-level scrolling page (conversation, tasks, settings) adds this one.
struct RiffetBarScrim: View {
    var body: some View {
        // Zero high at the safe area's top edge; the blur below it extends up through the bars.
        Color.clear.frame(height: 20)
            .background {
                Rectangle().fill(.ultraThinMaterial)
                    .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.55), .init(color: .clear, location: 1)],
                                         startPoint: .top, endPoint: .bottom))
                    .ignoresSafeArea(edges: .top)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

// MARK: - Press feedback

/// Rows and plain tappable areas: the press fill lands at once and fades out on release.
struct RiffetRowPressStyle: ButtonStyle {
    var radius: CGFloat = 0
    @Environment(\.palette) private var palette
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(palette.press)
                    .opacity(configuration.isPressed ? 1 : 0)
                    .animation(configuration.isPressed ? nil : RiffetMotion.release, value: configuration.isPressed)
            )
    }
}

/// Icon buttons, chips and inline controls: the label dims while pressed.
struct RiffetDimPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(configuration.isPressed ? nil : RiffetMotion.effects, value: configuration.isPressed)
    }
}

// MARK: - Section header

/// A list section title: label weight, the third text colour, aligned with the content column.
struct RiffetSectionHeader: View {
    let title: String
    var leading: CGFloat = 20
    @Environment(\.palette) private var palette
    var body: some View {
        Text(title)
            .riffetFont(.label)
            .foregroundStyle(palette.fg3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, leading)
            .padding(.top, 18)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Chips

/// A row of filter chips; the selected fill slides between chips and takes each one's width.
struct RiffetChipBar<Value: Hashable>: View {
    struct Item: Identifiable {
        let value: Value
        let title: String
        /// An agent's mark before the title (the agents of a new task); nil for plain chips.
        var mark: String? = nil
        var enabled = true
        var id: Value { value }
    }
    let items: [Item]
    /// From the bar's ends to the first and last chip: the page's inset, or a panel's.
    var inset: CGFloat = RiffetMetrics.pageInset
    @Binding var selection: Value
    @Namespace private var indicator
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The person has scrolled the bar; it no longer re-centres on the selection when its width changes.
    @State private var scrolled = false
    var body: some View {
        ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items) { item in
                    let selected = item.value == selection
                    Button {
                        withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { selection = item.value }
                    } label: {
                        HStack(spacing: 6) {
                            if let mark = item.mark { AgentMarkView(backend: mark, size: 14, color: item.enabled ? agentMarkColor(mark, palette) : palette.fg3) }
                            Text(item.title)
                        }
                            .riffetFont(.label)
                            .foregroundStyle(selected ? palette.fg : item.enabled ? palette.fg2 : palette.fg3)
                            .padding(.horizontal, RiffetMetrics.chipInset)
                            .frame(minHeight: RiffetMetrics.chipHeight)
                            .background {
                                Capsule().fill(palette.press)
                                if selected {
                                    Capsule().fill(palette.selected).matchedGeometryEffect(id: "chip", in: indicator)
                                }
                            }
                            .frame(minHeight: RiffetMetrics.hitTarget)
                    }
                    .buttonStyle(RiffetDimPressStyle())
                    .disabled(!item.enabled)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .id(item.value)
                }
            }
            .padding(.horizontal, inset)
        }
        .scrollClipDisabled()
        // The selected chip is always in view: where the bar appears, again once it has its size (a sheet
        // grows into place), and when the selection changes. Until the person scrolls the bar themselves.
        // In place, not animated: a bar that slides after it appears reads as the panel moving.
        .onAppear { proxy.scrollTo(selection, anchor: .center) }
        .onSettledSize { if !scrolled { proxy.scrollTo(selection, anchor: .center) } }
        .onScrollPhaseChange { _, phase in if phase == .interacting { scrolled = true } }
        // A tapped chip is already where the finger is: the bar moves only as far as it takes to show a
        // chip that is cut off at an edge, instead of sliding the tapped one to the middle.
        .onChange(of: selection) { _, value in
            withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { proxy.scrollTo(value) }
        }
        // Other chips are another bar: it starts from the beginning instead of keeping the last one's offset.
        .id(items.map(\.value))
        .onChange(of: items.map(\.value)) { _, _ in scrolled = false }
        }
    }
}

/// A chip that opens a menu: the task list's project filter, a settings page's scope.
/// Same capsule, height and press as `RiffetChipBar`; `leading` is an optional mark before the title.
struct RiffetMenuChip<Leading: View, Items: View>: View {
    let title: String
    var highlighted = false
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var items: () -> Items
    @Environment(\.palette) private var palette

    var body: some View {
        Menu { items() } label: {
            HStack(spacing: 6) {
                leading()
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg3)
            }
            .riffetFont(.label).foregroundStyle(highlighted ? palette.fg : palette.fg2)
            .padding(.horizontal, RiffetMetrics.chipInset).frame(minHeight: RiffetMetrics.chipHeight)
            .background(Capsule().fill(highlighted ? palette.selected : palette.press))
            .frame(minHeight: RiffetMetrics.hitTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(RiffetDimPressStyle())
    }
}

/// The same chip opening a picker sheet instead of a menu (a scope with many values: projects).
struct RiffetChipButton<Leading: View>: View {
    let title: String
    var highlighted = false
    @ViewBuilder var leading: () -> Leading
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                leading()
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").riffetFont(.caption, weight: .semibold).imageScale(.small).foregroundStyle(palette.fg3)
            }
            .riffetFont(.label).foregroundStyle(highlighted ? palette.fg : palette.fg2)
            .padding(.horizontal, RiffetMetrics.chipInset).frame(minHeight: RiffetMetrics.chipHeight)
            .background(Capsule().fill(highlighted ? palette.selected : palette.press))
            .frame(minHeight: RiffetMetrics.hitTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(RiffetDimPressStyle())
    }
}

extension RiffetChipButton where Leading == EmptyView {
    init(title: String, highlighted: Bool = false, action: @escaping () -> Void) {
        self.init(title: title, highlighted: highlighted, leading: { EmptyView() }, action: action)
    }
}

extension RiffetMenuChip where Leading == EmptyView {
    init(title: String, highlighted: Bool = false, @ViewBuilder items: @escaping () -> Items) {
        self.init(title: title, highlighted: highlighted, leading: { EmptyView() }, items: items)
    }
}

// MARK: - Agent avatar

/// What an agent avatar shows about its session.
enum AgentAvatarState: Equatable {
    case idle, running, waiting, failed
}

/// A session's agent: its mark on a tinted disc, with the session's state drawn on the avatar —
/// a turning accent arc while it runs, a cut-out dot while it waits or after it failed.
struct AgentAvatar: View {
    let backend: String
    var state: AgentAvatarState = .idle
    var size: CGFloat = RiffetMetrics.avatar
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let tint = agentMarkColor(backend, palette) ?? palette.fg2
        ZStack {
            Circle()
                .fill(tint.opacity(0.12))
                .padding(state == .running ? size * 3 / 44 : 0)
                .animation(RiffetMotion.spatial, value: state)
            AgentMarkView(backend: backend, size: size * 0.48, color: agentMarkColor(backend, palette))
            if state == .running { RunningArc(color: palette.accent, animated: !reduceMotion) }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if state == .waiting || state == .failed {
                ZStack {
                    Circle().fill(palette.bg)
                    Circle().fill(state == .failed ? palette.danger : palette.warning).frame(width: 9, height: 9)
                    if state == .failed {
                        Text("!").font(.system(size: 7, weight: .heavy)).foregroundStyle(.white)
                    }
                }
                .frame(width: 18, height: 18)
                .offset(x: 2, y: 2)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct RunningArc: View {
    let color: Color
    let animated: Bool
    @State private var turning = false
    var body: some View {
        Circle()
            .trim(from: 0, to: 80.0 / 360)
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .padding(1)
            .rotationEffect(.degrees(turning ? 270 : -90))
            .onAppear {
                guard animated else { return }
                // motion-loop: running arc, animated is false under Reduce Motion
                withAnimation(.linear(duration: 1.05).repeatForever(autoreverses: false)) { turning = true }
            }
    }
}

// MARK: - Composer parts

/// The composer's send-settings label: an optional icon or the context ring before the model name, plain
/// text with no fill or arrow, since the composer has little room. The icon is the agent's mark where
/// the agent is still being chosen, a plain symbol for a quick chat; inside a conversation the context
/// ring leads instead, once the agent has reported how full its window is. While the catalog loads the
/// icon turns into a spinner, and into a warning when the catalog could not be read; without an icon
/// those follow the model name. Either way the name never shifts.
struct RiffetModelLabel: View {
    enum Icon { case none, agent(String), symbol(String) }
    let title: String
    var icon: Icon = .none
    /// How full the context window is (0…1), shown as a ring before the model name; nil draws no ring.
    var context: Double? = nil
    var loading = false
    var failed = false
    let action: () -> Void
    @Environment(\.palette) private var palette

    private var leading: Bool { if case .none = icon { false } else { true } }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if leading {
                    if failed || loading { status }
                    else {
                        switch icon {
                        case .none: EmptyView()
                        case let .agent(backend): AgentMarkView(backend: backend, size: 14, color: agentMarkColor(backend, palette)).frame(width: 16, height: 16)
                        case let .symbol(name): Image(systemName: name).font(.system(size: 13, weight: .medium)).frame(width: 16, height: 16)
                        }
                    }
                }
                if let context { RiffetContextRing(ratio: context) }
                Text(title).riffetFont(.label).lineLimit(1).truncationMode(.middle)
                if !leading, failed || loading { status }
            }
            .foregroundStyle(palette.accent)
            .padding(.horizontal, 6)
            .frame(minHeight: RiffetMetrics.hitTarget)
        }
        .buttonStyle(RiffetDimPressStyle())
    }

    @ViewBuilder private var status: some View {
        if failed { Image(systemName: "exclamationmark.triangle").foregroundStyle(palette.warning).font(.system(size: 13, weight: .medium)).frame(width: 16, height: 16) }
        else { ProgressView().controlSize(.mini).frame(width: 16, height: 16) }
    }
}

/// How full the agent's context window is: a ring that fills clockwise from the top, neutral until 75%,
/// `warning` from 75%, `danger` from 90% (Android's `ContextRing`). Drawn only from a reported value.
struct RiffetContextRing: View {
    let ratio: Double
    /// The square it sits in; the ring keeps a point clear on each side, like the label's other icons.
    var size: CGFloat = 16
    @Environment(\.palette) private var palette
    private var tone: Color { ratio >= 0.9 ? palette.danger : ratio >= 0.75 ? palette.warning : palette.fg2 }
    var body: some View {
        let line = (size - 2) * 2.5 / 16
        ZStack {
            Circle().stroke(palette.lineStrong, lineWidth: line)
            Circle().trim(from: 0, to: min(max(ratio, 0), 1))
                .stroke(tone, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .padding(1 + line / 2)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The composer's round send button: accent when there is something to send, a quiet disc when not.
/// `stop` turns it into the stop control of a running turn; `symbol` and `busy` make it voice input's done.
struct RiffetSendButton: View {
    var enabled: Bool
    var stop = false
    var symbol = "arrow.up"
    var busy = false
    let action: () -> Void
    @Environment(\.palette) private var palette
    var body: some View {
        Button(action: action) {
            ZStack {
                if stop {
                    Circle().stroke(palette.danger, lineWidth: 1.5)
                    RoundedRectangle(cornerRadius: 2.5, style: .continuous).fill(palette.danger).frame(width: 11, height: 11)
                } else {
                    Circle().fill(enabled || busy ? palette.accent : palette.press)
                    if busy { ProgressView().controlSize(.small).tint(Color.white) }
                    else {
                        Image(systemName: symbol).font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(enabled ? Color.white : palette.fg4)
                    }
                }
            }
            .frame(width: RiffetMetrics.sendButton, height: RiffetMetrics.sendButton)
            .frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget)
            .animation(RiffetMotion.effects, value: enabled)
        }
        .buttonStyle(RiffetDimPressStyle())
        .disabled(!enabled && !stop)
        // A hardware keyboard (iPad, Duo) sends with ⌘↩; Return itself stays a new line.
        .keyboardShortcut(stop ? nil : KeyboardShortcut(.return, modifiers: .command))
    }
}

extension View {
    /// The composer card: a glass island over the page. What passes behind it is frosted inside the
    /// card only, so the input stays legible while the page keeps showing around and below it.
    @ViewBuilder func riffetComposerSurface() -> some View {
        let shape = RoundedRectangle(cornerRadius: RiffetMetrics.composerRadius, style: .continuous)
        if #available(iOS 26.0, *) {
            background(.ultraThinMaterial, in: shape).riffetGlass(in: shape)
        } else {
            riffetGlass(in: shape)
        }
    }
}
