import SwiftUI
import RiffetKit

/// The install commands of the Agents Riffet drives. The server reports whether an Agent is usable,
/// not how to get it, so the two with a stable one-line install are listed here.
enum AgentInstall {
    struct Row: Identifiable {
        let id: String
        let name: String
        let command: String
    }

    private static let commands: [(id: String, command: String)] = [
        ("claude", "npm install -g @anthropic-ai/claude-code"),
        ("codex", "npm install -g @openai/codex"),
    ]

    /// The Agents that are not usable yet and can be installed by one command; both known ones when
    /// the server lists none of them.
    @MainActor
    static func rows(for backends: [NativeBackendCatalogEntry]) -> [Row] {
        let missing = Set(backends.filter { $0.isPickable && !$0.available }.map(\.agent))
        let wanted = commands.filter { missing.contains($0.id) }
        return (wanted.isEmpty ? commands : wanted).map { Row(id: $0.id, name: AgentDirectory.shared.label($0.id), command: $0.command) }
    }
}

/// One install command per row: the Agent's mark and name, the command, a copy button.
struct AgentInstallList: View {
    let rows: [AgentInstall.Row]
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows) { row in
                HStack(spacing: Space.md) {
                    HStack(spacing: Space.sm) {
                        AgentMarkView(backend: row.id, size: 14, color: palette.fg)
                        Text(row.name).font(RiffetFont.label).foregroundStyle(palette.fg).lineLimit(1)
                    }
                    .frame(width: 124, alignment: .leading)
                    Text(row.command)
                        .font(RiffetFont.codeSmall)
                        .foregroundStyle(palette.fg3)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    CopyButton(text: row.command)
                }
                .padding(.leading, Space.sm)
                .padding(.trailing, Space.xs)
                .frame(height: 36)
            }
        }
        .padding(Space.xs)
        .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
    }
}

/// A first-launch page's column: title, one line under it, the content, then the buttons.
struct OnboardingColumn<Content: View, Foot: View>: View {
    let title: LocalizedStringResource
    let subtitle: LocalizedStringResource
    @ViewBuilder var content: Content
    @ViewBuilder var foot: Foot
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(RiffetFont.pageTitle).foregroundStyle(palette.fg)
            Text(subtitle).font(RiffetFont.label).foregroundStyle(palette.fg3).padding(.top, Space.sm)
            VStack(spacing: Space.sm) { content }.padding(.top, Column.gutter)
            HStack(spacing: Space.sm) { foot }.padding(.top, Column.gutter)
        }
    }
}

/// The page's main button: full width, 40 high, Return runs it, with a dimmed return glyph.
struct OnboardingPrimaryButton: View {
    let title: LocalizedStringResource
    var busy = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.xs) {
                if busy { Spinner(size: .small) }
                Text(title)
                if !busy { Text(verbatim: "↩").opacity(0.45) }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(OnboardingButtonStyle(kind: .primary))
        .keyboardShortcut(.defaultAction)
        .disabled(!enabled || busy)
    }
}

struct OnboardingButtonStyle: ButtonStyle {
    enum Kind { case primary, ghost }
    var kind: Kind
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(RiffetFont.label)
            .foregroundStyle(kind == .primary ? palette.primaryFg : palette.fg2)
            .padding(.horizontal, Space.lg)
            .frame(height: 40)
            .background(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(kind == .primary ? palette.primary : (configuration.isPressed ? palette.bgActive : .clear)))
            .opacity(enabled ? (configuration.isPressed && kind == .primary ? 0.82 : 1) : 0.5)
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
}

/// A radio card: a tile, a name with one line under it, a radio mark; the chosen card has a 1.5 outline.
struct ChoiceCard<Tile: View>: View {
    let title: String
    let detail: String
    let selected: Bool
    var enabled = true
    let action: () -> Void
    @ViewBuilder var tile: Tile
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        Button(action: action) {
            HStack(spacing: Space.md) {
                tile
                    .frame(width: 40, height: 40)
                    .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                VStack(alignment: .leading, spacing: 0) {
                    Text(title).font(RiffetFont.text(RiffetTextSize.sm, weight: .medium)).foregroundStyle(palette.fg)
                    Text(detail).font(RiffetFont.caption).foregroundStyle(palette.fg3).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Circle()
                    .strokeBorder(selected ? palette.fg : palette.fg4, lineWidth: 1.25)
                    .overlay { if selected { Circle().fill(palette.fg).padding(Space.xs) } }
                    .frame(width: 16, height: 16)
            }
            .padding(.vertical, Space.sm)
            .padding(.leading, Space.md)
            .padding(.trailing, Space.lg)
            .frame(minHeight: 64)
            .background(shape.fill(hovering && enabled ? palette.bgHover : .clear))
            .overlay(shape.strokeBorder(selected ? palette.fg : palette.line, lineWidth: selected ? 1.5 : 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .animation(Motion.fast, value: selected)
    }
}
