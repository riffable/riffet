import SwiftUI
import RiffetKit

/// Voice input as it replaces the composer's footer: cancel, level bars with the live sentence, the clock, and done.
struct DictationBar: View {
    let state: DictationState
    let cancel: () -> Void
    let finish: () -> Void
    let retry: () -> Void
    @Environment(\.palette) private var palette
    private var failed: Bool { state.phase == .failed }
    private var finishing: Bool { state.phase == .finishing }

    var body: some View {
        HStack(spacing: 4) {
            Button(action: cancel) {
                Image(systemName: "xmark").riffetFont(.label).foregroundStyle(palette.fg3)
                    .frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
            }.buttonStyle(RiffetDimPressStyle()).accessibilityLabel(failed ? String(localized: "放弃", bundle: .riffet) : String(localized: "取消", bundle: .riffet))
                .accessibilityIdentifier("dictationCancel")
            if failed {
                Text(state.failure ?? "").riffetFont(.label).foregroundStyle(palette.danger).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if state.canRetry { Button(String(localized: "重试", bundle: .riffet), action: retry).riffetFont(.label).tint(palette.accent).frame(minHeight: RiffetMetrics.hitTarget) }
            } else {
                HStack(spacing: 8) {
                    RiffetLevelBars(levels: state.levels.map { $0.floatValue }, color: palette.fg3)
                    // Head truncation keeps the newest words in view.
                    Text(state.live).riffetFont(.label).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    Text(dictationClock(elapsedMs: state.elapsedMs)).riffetFont(.caption).monospacedDigit().foregroundStyle(palette.fg3)
                }
                RiffetSendButton(enabled: !finishing, symbol: "checkmark", busy: finishing, action: finish)
                    .accessibilityLabel(String(localized: "完成", bundle: .riffet)).accessibilityIdentifier("dictationFinish")
            }
        }
    }
}
