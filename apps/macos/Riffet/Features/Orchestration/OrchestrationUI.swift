import SwiftUI
import RiffetKit

/// The frame of the orchestration sheets (handoff, rewind, parallel attempts, adopting one): title,
/// the fields, an error line and cancel / confirm. [confirmKind] is `.danger` for the one that
/// overwrites files.
struct OrchestrationSheet<Content: View>: View {
    let title: String
    let subtitle: String
    let confirmTitle: String
    var confirmKind: SolidButtonStyle.Kind = .primary
    let canConfirm: Bool
    let busy: Bool
    let error: String?
    /// A second action beside the confirm button, such as starting over.
    var secondaryTitle: String?
    var secondary: (() -> Void)?
    /// Lets Cancel stop a long wait (it dismisses, and the owner cancels the work on disappear).
    var cancelWhileBusy = false
    let confirm: () -> Void
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.riffet(size: S(15), weight: .semibold)).foregroundStyle(palette.fg)
                Text(subtitle).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, Space.xl)
            .padding(.top, Space.xl)
            .padding(.bottom, Space.md)
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) { content }
                    .padding(.horizontal, Space.xl)
                    .padding(.vertical, Space.xs)
            }
            .scrollBounceBehavior(.basedOnSize)
            .disabled(busy)
            HStack(spacing: Space.sm) {
                if let error {
                    Text(error).font(.riffet(size: S(12))).foregroundStyle(palette.danger).lineLimit(3).textSelection(.enabled)
                }
                Spacer(minLength: Space.md)
                if busy { Spinner(size: .small) }
                Button("取消") { dismiss() }
                    .buttonStyle(SolidButtonStyle())
                    .keyboardShortcut(.cancelAction)
                    .disabled(busy && !cancelWhileBusy)
                if let secondaryTitle, let secondary {
                    Button(secondaryTitle, action: secondary)
                        .buttonStyle(SolidButtonStyle())
                        .disabled(busy)
                }
                Button(confirmTitle, action: confirm)
                    .buttonStyle(SolidButtonStyle(kind: confirmKind))
                    // Return must not be enough to overwrite files.
                    .keyboardShortcut(confirmKind == .danger ? nil : .defaultAction)
                    .disabled(busy || !canConfirm)
            }
            .padding(Space.xl)
        }
        .frame(width: 500)
        .frame(maxHeight: 640)
        .background(palette.bg)
    }
}

/// A caption above one field of a sheet, with an optional note below it.
struct OrchestrationField<Content: View>: View {
    let label: String
    var hint: String?
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs + 2) {
            Text(label).font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg2)
            content
            if let hint {
                Text(hint).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A multi-line field in the look of `GitField`.
struct OrchestrationTextArea: View {
    @Binding var text: String
    let placeholder: String
    var minHeight: CGFloat = 80
    var maxHeight: CGFloat = 200
    @Environment(\.palette) private var palette

    var body: some View {
        TextEditor(text: $text)
            .font(.riffet(size: S(12.5)))
            .scrollContentBackground(.hidden)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs + 2)
            .frame(minHeight: minHeight, maxHeight: maxHeight)
            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder)
                        .font(.riffet(size: S(12.5)))
                        .foregroundStyle(palette.fg4)
                        .padding(.horizontal, Space.sm + 5)
                        .padding(.vertical, Space.xs + 2 + 1)
                        .allowsHitTesting(false)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
    }
}

/// A line of text with a switch at its end.
struct OrchestrationToggle: View {
    let title: String
    let detail: String
    @Binding var isOn: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.riffet(size: S(13)))
                Text(detail).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3)
            }
            Spacer(minLength: 0)
            Toggle(title, isOn: $isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
    }
}

/// An outcome or refusal that has no place in a sheet of its own, shown as an alert.
struct OrchestrationMessage: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let detail: String
}

extension Workbench {
    /// Opens the conversation a launch (fork, handoff) created. The server already has it, so it is
    /// put in the store first: the list has not reloaded yet, and the open must not wait for it.
    func openLaunched(_ result: NativeSessionCreateResult) {
        openLaunched(session: result.session)
    }

    func openLaunched(_ result: ForkSessionResult) {
        openLaunched(session: result.session)
    }

    private func openLaunched(session: Session) {
        store.applySession(session: session)
        open(session)
        refresh()
    }
}
