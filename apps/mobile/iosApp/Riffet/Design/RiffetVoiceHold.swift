import SwiftUI
import UIKit
import RiffetKit

// Hold to talk (docs/design/system/surfaces.md「语音输入（触屏）」): the bar that starts a recording while it is
// pressed, and the full-screen overlay that shows it. The overlay lives in its own window so the finger that
// began the press keeps feeding the bar's gesture: a cover or sheet would take the touch away.

// MARK: - Level bars

/// The recent loudness as thin bars, the web's scale: a quiet room stays a dotted line, ordinary speech fills the height.
struct RiffetLevelBars: View {
    let levels: [Float]
    var count = 16
    var color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shown = Array(levels.suffix(count))
        let padded = Array(repeating: Float(0), count: max(0, count - shown.count)) + shown
        HStack(spacing: 2) {
            ForEach(padded.indices, id: \.self) { index in
                Capsule().fill(color).frame(width: 2, height: min(20, 2 + CGFloat(padded[index]) * 80))
            }
        }
        .frame(height: 20)
        .animation(reduceMotion ? nil : RiffetMotion.effects, value: levels)
        .accessibilityHidden(true)
    }
}

// MARK: - The bar

/// The long「按住 说话」bar. A press calls `began`, finger moves `moved` with the distance above the press point,
/// and release `ended`; a VoiceOver activation calls `activate`, which records hands-free.
struct RiffetHoldToTalkBar: View {
    var height: CGFloat = RiffetMetrics.hitTarget
    /// The dictation is finishing after a release: a spinner stands in for the label and a new press does nothing.
    var finishing = false
    let began: () -> Void
    let moved: (CGFloat) -> Void
    let ended: () -> Void
    let activate: () -> Void
    @State private var pressed = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            if finishing { ProgressView().controlSize(.small) }
            else { Text(String(localized: "按住 说话", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg2).lineLimit(1) }
        }
            .frame(maxWidth: .infinity, minHeight: height)
            .background(pressed ? palette.press : palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.controlRadius, style: .continuous))
            .contentShape(Rectangle())
            // A SwiftUI gesture hears a press near the bottom edge only once the system has ruled out a home swipe,
            // about 0.8 s on a device, and a shorter press not at all. A UIKit recognizer hears it at once.
            .gesture(RiffetHoldPress { phase, rise in
                switch phase {
                case .began: guard isEnabled, !finishing else { return }; pressed = true; began()
                case .changed: if pressed { moved(rise) }
                default: if pressed { pressed = false; ended() }
                }
            })
            .accessibilityElement().accessibilityLabel(String(localized: "按住 说话", bundle: .riffet))
            .accessibilityAddTraits(.isButton).accessibilityAction(.default) { if !finishing { activate() } }
            .accessibilityIdentifier("dictationHold")
    }
}

/// A press on the hold bar: begins with the touch, follows the finger, and ends with its lift or cancellation.
private struct RiffetHoldPress: UIGestureRecognizerRepresentable {
    /// The phase, and how far the finger is above where it came down.
    let changed: (UIGestureRecognizer.State, CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> Recognizer { Recognizer() }

    func handleUIGestureRecognizerAction(_ recognizer: Recognizer, context: Context) {
        changed(recognizer.state, recognizer.rise)
    }

    final class Recognizer: UIGestureRecognizer {
        private var touch: UITouch?
        private var start: CGFloat = 0
        private(set) var rise: CGFloat = 0

        override init(target: Any?, action: Selector?) {
            super.init(target: target, action: action)
            delaysTouchesBegan = false
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            guard touch == nil, let first = touches.first else { return }
            touch = first; start = first.location(in: nil).y; rise = 0
            state = .began
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let touch, touches.contains(touch) else { return }
            rise = start - touch.location(in: nil).y
            state = .changed
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let touch, touches.contains(touch) else { return }
            state = .ended
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let touch, touches.contains(touch) else { return }
            state = .cancelled
        }

        override func reset() { touch = nil; rise = 0 }
    }
}

// MARK: - The overlay's model and window

/// One hold's overlay: the dictation it mirrors, whether the finger is in the cancel zone, and the window that draws it.
@MainActor @Observable
final class RiffetVoiceHold {
    /// A hold is on: the overlay is up and the composer keeps its layout under the finger.
    private(set) var session = false
    private(set) var state: DictationState?
    private(set) var cancelling = false
    private(set) var released = false
    var composerFrame: CGRect = .zero
    /// The composer sits at the bottom of the screen, and the dome covers it whole for the hold. One higher up is part of
    /// the page; the dome is then a strip of its own at the bottom.
    private(set) var docked = false
    /// The composer's frame when the press began: the overlay is laid out from it, so text landing in the draft does not
    /// move the bubble or the dome while they fade.
    private(set) var anchor: CGRect = .zero
    fileprivate var screenHeight: CGFloat = 0
    fileprivate var screenWidth: CGFloat = 0
    fileprivate var bottomInset: CGFloat = 0
    /// The overlay is up: only while the finger is down or the dictation failed.
    fileprivate var visible = false
    /// Released and the dictation is still finishing: the bar spins and takes no new press.
    var finishing: Bool { session && released && state?.active == true }
    fileprivate var palette = Palette.builtin(RiffetThemeCatalog.all[0].id)
    var retry: () -> Void = {}
    var discard: () -> Void = {}
    @ObservationIgnored private var window: UIWindow?
    @ObservationIgnored private var sawActive = false
    @ObservationIgnored private let haptic = UIImpactFeedbackGenerator(style: .light)

    func begin(palette: Palette, scheme: ColorScheme) {
        self.palette = palette
        session = true; released = false; cancelling = false; sawActive = false
        haptic.prepare(); haptic.impactOccurred()
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }) else { return }
        screenHeight = scene.coordinateSpace.bounds.height
        screenWidth = scene.coordinateSpace.bounds.width
        bottomInset = scene.windows.first?.safeAreaInsets.bottom ?? 0
        anchor = composerFrame
        docked = screenHeight - anchor.minY <= screenHeight * 0.4
        state = nil
        let host = UIHostingController(rootView: RiffetVoiceHoldOverlay(hold: self).environment(\.colorScheme, scheme))
        host.view.backgroundColor = .clear
        let overlay = UIWindow(windowScene: scene)
        overlay.windowLevel = .alert
        overlay.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        overlay.rootViewController = host
        // The press stays with the main window's gesture; the overlay only takes touches to ask 重试 or 放弃.
        overlay.isUserInteractionEnabled = false
        overlay.isHidden = false
        window = overlay
        // A frame later the window is up with the dome opaque over the composer: the scrim and the bubble fade in.
        Task { @MainActor [weak self] in
            guard let self, self.session, !self.released else { return }
            withAnimation(RiffetMotion.effects) { self.visible = true }
        }
    }

    /// The finger moved `rise` points above where it went down.
    func move(rise: CGFloat) {
        let now = rise > CGFloat(DictationGesture.shared.CANCEL_DISTANCE_DP)
        guard now != cancelling else { return }
        cancelling = now
        haptic.impactOccurred()
    }

    /// The finger lifted: the overlay leaves at once and the composer shows again under it.
    func release() {
        released = true
        withAnimation(RiffetMotion.effects) { visible = false }
    }

    func update(_ next: DictationState) {
        // The overlay keeps what it last showed while it fades: an idle state would empty the bubble first.
        if next.phase != .idle || !session { state = next }
        if next.active { sawActive = true }
        window?.isUserInteractionEnabled = next.phase == .failed
        // A failure after the release brings the overlay back with the message and its choices.
        if session, next.phase == .failed, !visible { withAnimation(RiffetMotion.effects) { visible = true } }
        if session, released || sawActive, next.phase == .idle { end() }
    }

    /// The overlay fades out; the layout is released once it is gone.
    func end() {
        guard session else { return }
        session = false
        withAnimation(RiffetMotion.effects) { visible = false }
        let closing = window
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            // A hold begun meanwhile has its own window: this one goes regardless.
            if self?.window === closing {
                if self?.session == true { return }
                self?.window = nil; self?.docked = false; self?.cancelling = false
            }
            closing?.isHidden = true
        }
    }
}

// MARK: - The overlay

struct RiffetVoiceHoldOverlay: View {
    let hold: RiffetVoiceHold
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let gap = RiffetMetrics.floatingGap
    private let zoneHeight: CGFloat = 112
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = hold.palette
        let state = hold.state
        let failed = state?.phase == .failed
        let cancelling = hold.cancelling && !failed
        let docked = hold.docked
        let anchor = hold.anchor
        // Docked, the dome covers the composer whole, its sides level with the composer's top edge, so the composer can stay
        // where it is underneath. In the page, the dome is its own strip at the bottom.
        let arc = docked ? max(zoneHeight + hold.bottomInset, hold.screenHeight - anchor.minY + RiffetVoiceArc.bow) : zoneHeight + hold.bottomInset
        // Centred on the screen, as the dome under it: the composer's narrower margin on both sides, so a composer
        // beside something else does not pull the bubble off the dome's middle.
        let inset = max(0, min(anchor.minX, hold.screenWidth - anchor.maxX))
        let bubble = self.bubble(palette: palette, state: state, failed: failed, cancelling: cancelling)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, inset)
            // Fades in place: nothing moves on the way in, since a phone that drops a rise's first frames shows it as a jump.
            .opacity(hold.visible ? 1 : 0)
        ZStack(alignment: .bottom) {
            // The web's scrim over the system blur: twice as dark in a dark scheme, where a light dim reads as none.
            Rectangle().fill(.ultraThinMaterial).overlay(Color.black.opacity(scheme == .dark ? 0.5 : 0.25))
                .opacity(hold.visible ? 1 : 0)
            // The bubble always stands on the dome: above a composer in the page it would cover whatever sits there.
            VStack(spacing: gap) {
                bubble
                // The whole overlay leaves with the release; only a failure swaps the dome for the message.
                // Docked it is opaque over the composer from the window's first frame, so the composer never shows through
                // it; in the page it fades in with the scrim. Either way it fades out with it.
                zone(palette: palette, cancelling: cancelling).frame(height: arc)
                    .opacity(failed ? 0 : docked && hold.session && !hold.released || hold.visible ? 1 : 0)
                    .accessibilityHidden(true)
            }
        }
        .ignoresSafeArea()
        .environment(\.palette, palette)
        .animation(reduceMotion ? nil : RiffetMotion.effects, value: hold.visible)
        .animation(reduceMotion ? nil : RiffetMotion.effects, value: cancelling)
        .animation(reduceMotion ? nil : RiffetMotion.effects, value: failed)
    }

    private func bubble(palette: Palette, state: DictationState?, failed: Bool, cancelling: Bool) -> some View {
        let finishing = state?.phase == .finishing
        let warn = (state?.elapsedMs ?? 0) >= DictationGesture.shared.WARN_AT_MS
        let text = (state?.written ?? "") + (state?.live ?? "")
        return VStack(alignment: .trailing, spacing: gap) {
            VStack(alignment: .leading, spacing: gap) {
                if failed {
                    Text(state?.failure ?? "").riffetFont(.body).foregroundStyle(palette.danger).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    if !text.isEmpty {
                        // Head truncation keeps the newest words in view.
                        Text(styled(written: state?.written ?? "", live: state?.live ?? "", palette: palette, cancelling: cancelling))
                            .riffetFont(.body).lineLimit(6).truncationMode(.head).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack(spacing: gap) {
                        Spacer(minLength: 0)
                        if finishing { ProgressView().controlSize(.small) }
                        else { RiffetLevelBars(levels: (state?.levels ?? []).map { $0.floatValue }, color: cancelling ? palette.danger : palette.fg3) }
                        Text(dictationClock(elapsedMs: state?.elapsedMs ?? 0)).riffetFont(.caption).monospacedDigit()
                            .foregroundStyle(cancelling ? palette.danger : warn ? palette.warning : palette.fg3)
                        // Alone in the bubble, the meter is its centre; under words it sits at their end.
                        if text.isEmpty { Spacer(minLength: 0) }
                    }
                }
            }
            .padding(.horizontal, RiffetMetrics.groupInset).padding(.vertical, RiffetMetrics.floatingGap)
            .background(palette.bgPopover, in: RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous))
            .background(cancelling ? palette.dangerSoft : Color.clear, in: RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous))
            .riffetFloatingShadow()
            if failed {
                HStack(spacing: 0) {
                    if state?.canRetry == true {
                        Button(String(localized: "重试", bundle: .riffet)) { hold.retry() }.tint(palette.accent)
                    }
                    Button(String(localized: "放弃", bundle: .riffet)) { hold.discard() }.tint(palette.fg3)
                }.riffetFont(.label).buttonStyle(RiffetDimPressStyle())
                    .padding(.horizontal, RiffetMetrics.groupInset).frame(minHeight: RiffetMetrics.hitTarget)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func styled(written: String, live: String, palette: Palette, cancelling: Bool) -> AttributedString {
        var first = AttributedString(written)
        first.foregroundColor = cancelling ? palette.danger : palette.fg
        var second = AttributedString(live)
        second.foregroundColor = cancelling ? palette.danger : palette.fg3
        return first + second
    }

    /// The bottom zone: a shallow dome of the floating surface, a hairline along its edge, the hint and the microphone
    /// centred in the room under the bow.
    private func zone(palette: Palette, cancelling: Bool) -> some View {
        ZStack(alignment: .top) {
            RiffetVoiceArc().fill(palette.bgPopover)
                .overlay(RiffetVoiceArc().fill(cancelling ? palette.dangerSoft : Color.clear))
                .overlay(RiffetVoiceArc().stroke(palette.line, lineWidth: 1))
                .riffetFloatingShadow()
            VStack(spacing: gap) {
                Text(cancelling ? String(localized: "松开取消", bundle: .riffet) : String(localized: "松开转文字，上滑取消", bundle: .riffet)).riffetFont(.caption)
                    .foregroundStyle(cancelling ? palette.danger : palette.fg2)
                Image(systemName: "mic.fill").riffetFont(.barTitle).foregroundStyle(cancelling ? palette.fg3 : palette.fg)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.top, RiffetVoiceArc.bow).padding(.bottom, hold.bottomInset)
        }
    }
}

/// The zone's top edge bows up in the middle.
private struct RiffetVoiceArc: Shape {
    static let bow: CGFloat = 24
    func path(in rect: CGRect) -> Path {
        let bow = Self.bow
        var path = Path()
        path.move(to: CGPoint(x: 0, y: rect.minY + bow))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + bow), control: CGPoint(x: rect.midX, y: rect.minY - bow))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: 0, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}
