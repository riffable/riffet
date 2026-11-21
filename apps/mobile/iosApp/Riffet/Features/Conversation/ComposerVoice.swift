import SwiftUI
import RiffetKit

/// Touch voice input for a composer: the dictation controller, the voice mode, and the hold gesture's overlay.
/// The composer keeps its own focus and layout; it asks this for the state and forwards the gestures.
@MainActor @Observable
final class ComposerVoice {
    /// Voice mode: hold to talk stands in for the keyboard. Kept on this device only.
    private(set) var mode: Bool
    /// The draft's caret; a TextField binds it so dictation lands where the cursor was.
    var selection: TextSelection?
    /// The draft text `selection` indexes. A draft sent, restored or replaced in code leaves the caret behind,
    /// and its indices then point past or into the middle of the new text, where measuring them traps.
    @ObservationIgnored private var selectionText: String?
    func selectionBinding(_ draft: MessageDraft) -> Binding<TextSelection?> {
        Binding(get: { self.selection }, set: { picked in
            self.selection = picked
            // The field can report the caret before the text it belongs to; read the text once both are in.
            DispatchQueue.main.async { [weak self] in if let self, self.selection == picked { self.selectionText = draft.text } }
        })
    }
    private(set) var dictation: DictationState?
    let hold = RiffetVoiceHold()
    /// What the layout looked like when the press began; it stays so while the overlay is up, or the bar under the finger would move.
    private var frozenEmpty = true
    private var frozenContent = false
    @ObservationIgnored private var dictator: DictationController?
    @ObservationIgnored private var watch: Task<Void, Never>?
    @ObservationIgnored private var microphone = IOSDictationMicrophone()
    @ObservationIgnored private var pressedAt: Date?
    private static let preferences = createAppPreferences()

    init() { mode = ComposerVoiceMode.shared.isOn(preferences: Self.preferences) }

    var dictating: Bool { dictation?.active == true }
    var handsFree: Bool { dictating && !hold.session }
    func textEmpty(_ draft: MessageDraft) -> Bool { hold.session ? frozenEmpty : draft.text.isEmpty }
    func hasContent(_ live: Bool) -> Bool { hold.session ? frozenContent : live }

    func setMode(_ on: Bool) {
        guard mode != on else { return }
        mode = on
        ComposerVoiceMode.shared.set(preferences: Self.preferences, on: on)
    }
    func cancel() { dictator?.cancel() }
    func finish() { dictator?.finish() }
    func retry() { dictator?.retry() }
    /// A backgrounded app stops listening.
    func scenePhaseChanged(_ phase: ScenePhase) {
        if phase != .active, dictation?.phase == .recording { dictator?.finish() }
    }
    func teardown() {
        watch?.cancel(); watch = nil
        dictator?.close(); dictator = nil
        hold.end()
    }

    /// The controller is made on first use and its state followed from then on.
    func start(host: IOSHost, draft: MessageDraft) {
        if dictator == nil, let made = host.dictation(microphone: microphone) {
            dictator = made
            let flow = made.state
            watch = Task { for await _ in flow { dictation = flow.value; hold.update(flow.value) } }
        }
        guard let dictator else { return }
        let text = draft.text
        var from = text.utf16.count, to = from
        // A caret from another text means the end.
        if let selection, selectionText == text, case let .selection(range) = selection.indices,
           let lower = String.Index(range.lowerBound, within: text.utf16), let upper = String.Index(range.upperBound, within: text.utf16) {
            from = text.utf16.distance(from: text.utf16.startIndex, to: lower)
            to = text.utf16.distance(from: text.utf16.startIndex, to: upper)
        }
        dictator.start(draft: text, selectionStart: Int32(from), selectionEnd: Int32(to), target: DictationWriter { [weak self] text, caret in
            draft.text = text
            self?.selectionText = text
            self?.selection = TextSelection(insertionPoint: String.Index(utf16Offset: min(Int(caret), text.utf16.count), in: text))
        })
    }

    fileprivate func began(draft: MessageDraft, hasContent: Bool, host: IOSHost, palette: Palette, scheme: ColorScheme) {
        frozenEmpty = draft.text.isEmpty; frozenContent = hasContent
        pressedAt = Date()
        hold.retry = { [weak self] in self?.dictator?.retry() }
        hold.discard = { [weak self] in self?.dictator?.cancel() }
        hold.begin(palette: palette, scheme: scheme)
        start(host: host, draft: draft)
    }
    /// A quick tap leaves the recording to the hands-free bar; a longer hold finishes it, and the cancel zone drops it.
    fileprivate func ended() {
        let quick = Date().timeIntervalSince(pressedAt ?? Date()) * 1000 < Double(DictationGesture.shared.TAP_MS)
        let cancelled = hold.cancelling
        hold.release()
        if cancelled { dictator?.cancel() }
        else if quick { hold.end(); return }
        else if dictation?.phase == .recording { dictator?.finish() }
        if dictation?.active != true { hold.end() }
    }
}

/// Keyboard and voice take turns; the button shows the one a tap switches to.
struct ComposerVoiceToggle<Glyph: View>: View {
    let voice: ComposerVoice
    /// Called after switching to the keyboard, to put the cursor in the input.
    let keyboard: () -> Void
    @ViewBuilder let glyph: (String) -> Glyph
    var body: some View {
        Button {
            voice.setMode(!voice.mode)
            if !voice.mode { keyboard() }
        } label: {
            glyph(voice.mode ? "keyboard" : "mic")
        }.buttonStyle(RiffetDimPressStyle())
            .accessibilityLabel(voice.mode ? String(localized: "键盘", bundle: .riffet) : String(localized: "语音输入", bundle: .riffet))
            .accessibilityIdentifier("dictationToggle")
    }
}

/// The hold-to-talk bar wired to a composer's voice.
struct ComposerHoldBar: View {
    let voice: ComposerVoice
    let draft: MessageDraft
    let host: IOSHost
    let hasContent: Bool
    var height: CGFloat = RiffetMetrics.hitTarget
    /// Called when a press begins, to put the keyboard away.
    let unfocus: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        RiffetHoldToTalkBar(height: height, finishing: voice.hold.finishing, began: {
            unfocus()
            voice.began(draft: draft, hasContent: hasContent, host: host, palette: palette, scheme: colorScheme)
        }, moved: { voice.hold.move(rise: $0) }, ended: { voice.ended() }, activate: { unfocus(); voice.start(host: host, draft: draft) })
    }
}

/// Hands a dictation's text and caret to the composer's draft.
private final class DictationWriter: NSObject, DictationTarget {
    private let apply: (String, Int32) -> Void
    init(_ apply: @escaping (String, Int32) -> Void) { self.apply = apply }
    func replaceDraft(text: String, caret: Int32) { apply(text, caret) }
}
