import SwiftUI
import RiffetKit

// Text parameters work as SwiftUI's `Text` does: a literal goes through the string catalog (the
// `LocalizedStringResource` initializers) and a `String` value is shown as it is (the disfavored
// `String` ones). A call that mixes a literal with a `String` value takes the `String` initializer,
// so wrap that literal in `String(localized:)`.

/// Where a setting is stored. The settings window mixes per-Mac preferences with server-wide
/// account settings; each pane states its own once and a section stored elsewhere says so.
enum SettingsScope {
    case mac
    case server
    case mixed

    var label: String {
        switch self {
        case .mac: String(localized: "本机")
        case .server: String(localized: "所有设备")
        case .mixed: String(localized: "本机 + 所有设备")
        }
    }

    var symbol: String {
        switch self {
        case .mac: "laptopcomputer"
        case .server: "network"
        case .mixed: "arrow.left.arrow.right"
        }
    }
}

/// A quiet capsule beside a section title. Neutral by design: it answers "where does this live",
/// not "is something wrong".
struct SettingsScopeBadge: View {
    let scope: SettingsScope
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 3) {
            Image(icon: scope.symbol).font(.riffet(size: S(8.5), weight: .medium))
            Text(scope.label).font(.riffet(size: S(10), weight: .medium))
        }
        .foregroundStyle(palette.fg3)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(palette.bgMuted, in: Capsule())
        .overlay(Capsule().strokeBorder(palette.lineSoft))
        .accessibilityLabel("作用范围：\(scope.label)")
    }
}

/// The pane's dominant storage, set by the settings window. A section that lives in the same place
/// leaves its scope unsaid; `SettingsScopeFooter` states it once at the end of the pane. (A toolbar
/// item would turn the settings window's title bar into a full toolbar and push the sidebar down.)
extension EnvironmentValues {
    @Entry var settingsPaneScope: SettingsScope?
}

/// The last section of a pane: where the pane's settings are kept, in one quiet line.
struct SettingsScopeFooter: View {
    @Environment(\.palette) private var palette
    @Environment(\.settingsPaneScope) private var scope

    var body: some View {
        if let text {
            Section {} footer: {
                Text(text)
                    .font(.riffet(size: S(11.5)))
                    .foregroundStyle(palette.fg4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var text: String? {
        switch scope {
        case .mac: String(localized: "仅保存在这台 Mac")
        case .server: String(localized: "同步到所有设备")
        case .mixed, nil: nil
        }
    }
}

/// The header of one grouped `Section`: title, a scope when it differs from the pane's, and one
/// sentence of context. Plain text, like System Settings.
struct SettingsSectionHeader: View {
    let title: String
    var scope: SettingsScope?
    var detail: String?
    @Environment(\.palette) private var palette
    @Environment(\.settingsPaneScope) private var paneScope

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Text(title)
                    .font(.riffet(size: S(DisplayPreferences.shared.style.text.label), weight: .semibold))
                    .foregroundStyle(palette.fg3)
                Spacer(minLength: Space.sm)
                if let scope, scope != paneScope { SettingsScopeBadge(scope: scope) }
            }
            if let detail {
                Text(detail)
                    .font(.riffet(size: S(DisplayPreferences.shared.style.text.label)))
                    .foregroundStyle(palette.fg4)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.trailing, 4)
            }
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .padding(.bottom, 1)
    }
}

/// A grouped settings section with the app's header style. Use this instead of a bare
/// `Section("…")` so every pane shares the same title, scope and description rhythm.
struct SettingsBlock<Content: View>: View {
    let title: String
    var scope: SettingsScope?
    var detail: String?
    @ViewBuilder var content: Content

    init(
        _ title: LocalizedStringResource,
        scope: SettingsScope? = nil,
        detail: LocalizedStringResource? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.init(String(localized: title), scope: scope, detail: detail.map { String(localized: $0) }, content: content)
    }

    @_disfavoredOverload
    init(
        _ title: String,
        scope: SettingsScope? = nil,
        detail: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.scope = scope
        self.detail = detail
        self.content = content()
    }

    var body: some View {
        Section {
            content
        } header: {
            SettingsSectionHeader(title: title, scope: scope, detail: detail)
        }
    }
}

/// Label and optional explanation on the left, one control on the right. Built on `LabeledContent`
/// so it keeps the same label/value column as the native rows beside it.
struct SettingsRow<Trailing: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder var trailing: Trailing
    @Environment(\.palette) private var palette

    init(
        _ title: LocalizedStringResource,
        detail: LocalizedStringResource? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.init(String(localized: title), detail: detail.map { String(localized: $0) }, trailing: trailing)
    }

    @_disfavoredOverload
    init(
        _ title: String,
        detail: String? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.detail = detail
        self.trailing = trailing()
    }

    var body: some View {
        LabeledContent {
            trailing
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(palette.fg)
                if let detail {
                    Text(detail)
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// A row whose control needs the full width: segmented pickers, text fields, editors.
struct SettingsFieldRow<Control: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder var control: Control
    @Environment(\.palette) private var palette

    init(_ title: LocalizedStringResource, detail: LocalizedStringResource? = nil, @ViewBuilder control: () -> Control) {
        self.init(String(localized: title), detail: detail.map { String(localized: $0) }, control: control)
    }

    @_disfavoredOverload
    init(_ title: String, detail: String? = nil, @ViewBuilder control: () -> Control) {
        self.title = title
        self.detail = detail
        self.control = control()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(title)
                .font(.riffet(size: S(13)))
                .foregroundStyle(palette.fg)
            control
                // The row title is the control's label; a TextField/Picker inside would otherwise
                // repeat it as a second label on its own line.
                .labelsHidden()
            if let detail {
                Text(detail)
                    .font(.riffet(size: S(11.5)))
                    .foregroundStyle(palette.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 1)
    }
}

/// A status word with a dot, for permissions, connections and service state.
struct SettingsStatusBadge: View {
    let text: String
    var tint: Color?
    @Environment(\.palette) private var palette

    var body: some View {
        let color = tint ?? palette.fg3
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text)
                .font(.riffet(size: S(11.5), weight: .medium))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .background(color.opacity(0.12), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// A status row: what is being reported, an optional detail, and a state badge that is not a
/// bare word.
struct SettingsStatusRow: View {
    let title: String
    var detail: String?
    let status: String
    var tint: Color?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(palette.fg)
                if let detail {
                    Text(detail)
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Space.sm)
            SettingsStatusBadge(text: status, tint: tint)
        }
    }
}

/// Inline feedback for something the reader must act on or that just failed. One component for
/// all four tones keeps colour and spacing consistent across panes.
struct SettingsCallout: View {
    enum Tone {
        case info
        case success
        case warning
        case danger
    }

    let tone: Tone
    var title: String?
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?
    @Environment(\.palette) private var palette

    init(
        _ tone: Tone,
        title: LocalizedStringResource? = nil,
        message: LocalizedStringResource,
        actionTitle: LocalizedStringResource? = nil,
        action: (() -> Void)? = nil
    ) {
        self.init(
            tone,
            title: title.map { String(localized: $0) },
            message: String(localized: message),
            actionTitle: actionTitle.map { String(localized: $0) },
            action: action
        )
    }

    @_disfavoredOverload
    init(
        _ tone: Tone,
        title: String? = nil,
        message: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.tone = tone
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(icon: symbol)
                .font(.riffet(size: S(12), weight: .medium))
                .foregroundStyle(foreground)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                if let title {
                    Text(title)
                        .font(.riffet(size: S(12.5), weight: .medium))
                        .foregroundStyle(palette.fg)
                }
                Text(message)
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg2)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(SolidButtonStyle(kind: .secondary))
                        .controlSize(.small)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm + 2)
        .background(background, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.lineSoft))
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch tone {
        case .info: "info.circle"
        case .success: "checkmark.circle"
        case .warning: "exclamationmark.triangle"
        case .danger: "xmark.octagon"
        }
    }

    private var foreground: Color {
        switch tone {
        case .info: palette.accent
        case .success: palette.success
        case .warning: palette.warning
        case .danger: palette.danger
        }
    }

    private var background: Color {
        switch tone {
        case .info: palette.bgSubtle
        case .success: palette.successSoft.opacity(0.5)
        case .warning: palette.warningSoft.opacity(0.5)
        case .danger: palette.dangerSoft.opacity(0.5)
        }
    }
}

/// A small decision-changing note inside a card. Use one per section at most; ordinary
/// explanations belong in `SettingsSectionHeader`.
struct SettingsHint: View {
    let text: String
    var symbol: String?
    @Environment(\.palette) private var palette

    init(_ text: LocalizedStringResource, symbol: String? = nil) {
        self.init(String(localized: text), symbol: symbol)
    }

    @_disfavoredOverload
    init(_ text: String, symbol: String? = nil) {
        self.text = text
        self.symbol = symbol
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            if let symbol {
                Image(icon: symbol)
                    .font(.riffet(size: S(10.5)))
                    .foregroundStyle(palette.fg4)
            }
            Text(text)
                .font(.riffet(size: S(11.5)))
                .foregroundStyle(palette.fg4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A keyboard shortcut rendered as keycaps rather than a row of punctuation.
struct SettingsKeycaps: View {
    let keys: [String]
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 3) {
            ForEach(keys.indices, id: \.self) { index in
                Text(keys[index])
                    .font(.riffet(size: S(10.5), weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.fg2)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
            }
        }
    }
}

struct SettingsShortcutRow: View {
    let title: String
    let keys: [String]
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            Text(title)
                .font(.riffet(size: S(13)))
                .foregroundStyle(palette.fg)
            Spacer(minLength: Space.sm)
            SettingsKeycaps(keys: keys)
        }
    }
}

/// A page action in the app's button language. Row-level actions stay `.controlSize(.small)`;
/// primary page actions should be the only `.primary` on screen.
struct SettingsActionButton: View {
    enum Kind {
        case primary
        case secondary
        case danger
    }

    let title: String
    var symbol: String?
    var kind: Kind = .secondary
    let action: () -> Void

    init(_ title: LocalizedStringResource, symbol: String? = nil, kind: Kind = .secondary, action: @escaping () -> Void) {
        self.init(verbatim: String(localized: title), symbol: symbol, kind: kind, action: action)
    }

    /// Labelled rather than disfavoured: for a lone literal and a trailing closure the type checker
    /// picks a `String` overload before ranking, and the title would skip the catalog.
    init(verbatim title: String, symbol: String? = nil, kind: Kind = .secondary, action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.kind = kind
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            if let symbol {
                Label(title, icon: symbol)
            } else {
                Text(title)
            }
        }
        .buttonStyle(SolidButtonStyle(kind: style))
    }

    private var style: SolidButtonStyle.Kind {
        switch kind {
        case .primary: .primary
        case .secondary: .secondary
        case .danger: .danger
        }
    }
}

/// The standard empty state inside a settings pane. Keeps the icon/title/description rhythm of the
/// app's other pages while giving the reader the one action that fixes it.
struct SettingsEmptyState: View {
    let title: String
    let message: String
    var symbol: String = "tray"
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, icon: symbol)
        } description: {
            Text(message)
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(SolidButtonStyle(kind: .primary))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Per-pane transport state for server settings. Deliberately not a global store: several panes
/// (a plugin's two-request save, backups, CLI commands, project configs) have bespoke semantics and
/// must keep them.
@MainActor
@Observable
final class SettingsSaveState {
    private(set) var busy = false
    private(set) var error: String?
    private(set) var savedAt: Date?

    @ObservationIgnored private var clearSaved: Task<Void, Never>?

    func run(_ action: () async throws -> Void) async {
        busy = true
        error = nil
        do {
            try await action()
            savedAt = .now
            clearSaved?.cancel()
            clearSaved = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                self?.savedAt = nil
            }
        } catch {
            savedAt = nil
            self.error = error.riffetMessage
        }
        busy = false
    }

    func save(_ workbench: Workbench, _ body: AppSettingsUpdate) async {
        await run { try await SettingsStore.save(workbench, body) }
    }

    func clear() {
        error = nil
        savedAt = nil
    }
}

/// Renders a save state. Auto-saved controls show progress and failures only; explicit save
/// buttons pass `explicit: true` to also show a short "已保存".
struct SettingsFeedback: View {
    let state: SettingsSaveState
    var explicit = false
    @Environment(\.palette) private var palette
    @State private var savingShown = false

    private enum Feedback: Equatable {
        case error(String), saving, saved

        var identity: AnyHashable {
            if case let .error(message) = self { return "error|\(message)" }
            return "save"
        }
    }

    private var feedback: Feedback? {
        if let error = state.error { return .error(error) }
        if state.busy { return savingShown ? .saving : nil }
        return explicit && state.savedAt != nil ? .saved : nil
    }

    var body: some View {
        FeedbackRegion(value: feedback, renewal: state.savedAt?.hashValue ?? 0, identity: { $0.identity }) { held, live in
            switch held {
            case let .error(error):
                SettingsCallout(live ? .danger : .info, message: error)
            case .saving:
                // Progress goes away when it ends; an explicit save then continues as `.saved`.
                if live {
                    HStack(spacing: Space.sm) {
                        Spinner(size: .mini)
                        Text("保存中…")
                    }
                    .font(.riffet(size: S(11.5)))
                    .foregroundStyle(palette.fg3)
                }
            case .saved:
                HStack(spacing: 5) {
                    Image(icon: "checkmark.circle")
                        .font(.riffet(size: S(11), weight: .medium))
                        .foregroundStyle(palette.success)
                    Text("已保存")
                        .font(.riffet(size: S(11.5)))
                        .foregroundStyle(palette.fg3)
                }
                .transition(.opacity)
            }
        }
        .task(id: state.busy) {
            savingShown = false
            guard state.busy else { return }
            do { try await Task.sleep(for: .milliseconds(600)) } catch { return }
            guard !Task.isCancelled, state.busy else { return }
            savingShown = true
        }
        .id(ObjectIdentifier(state))
    }
}
