import SwiftUI

extension View {
    /// A settings form: the system's grouped boxes. Every form uses this, never `.formStyle(.grouped)`.
    /// Switches inside it turn on in the theme's `primary`; the window-wide tint stays `accent`.
    func riffetForm() -> some View { formStyle(.grouped).modifier(SwitchTint()) }

    /// A text field in a form, with a rounded bezel when `bezeled`.
    @ViewBuilder
    func formField(bezeled: Bool = false) -> some View {
        if bezeled { textFieldStyle(.roundedBorder) } else { self }
    }
}

private struct SwitchTint: ViewModifier {
    @Environment(\.palette) private var palette
    func body(content: Content) -> some View { content.tint(palette.primary) }
}

/// A segmented choice in a form, written like a `Picker`: a title, then options tagged with their
/// value. The title names the control for VoiceOver.
struct FormSegmented<Value: Hashable, Content: View>: View {
    let title: LocalizedStringResource
    @Binding var selection: Value
    @ViewBuilder var content: Content

    init(_ title: LocalizedStringResource, selection: Binding<Value>, @ViewBuilder content: () -> Content) {
        self.title = title
        _selection = selection
        self.content = content()
    }

    var body: some View {
        Picker(selection: $selection) { content } label: { Text(title) }.pickerStyle(.segmented)
    }
}

/// The quiet segmented control: the chosen option filled with the soft theme tint (`accentSoft`) with
/// ink text, on a muted track, sliding to the next one rather than blinking over.
/// Options are written like a `Picker`'s, each tagged with its value.
struct SegmentedTrack<Value: Hashable, Content: View>: View {
    @Binding var selection: Value
    var fontSize: CGFloat = 12.5
    /// Each option's side inset; a narrow place passes less before falling back to a menu.
    var inset: CGFloat = Space.md
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled
    @Namespace private var namespace

    var body: some View {
        HStack(spacing: 0) {
            ForEach(subviews: content) { option in
                let value = option.containerValues.tag(for: Value.self)
                let on = value == selection
                Button { if let value { selection = value } } label: {
                    option
                        .font(.riffet(size: S(fontSize)))
                        .foregroundStyle(on ? palette.fg : palette.fg3)
                        .lineLimit(1)
                        .padding(.horizontal, inset)
                        .frame(minHeight: 24)
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: max(Radius.control - 2, 2), style: .continuous)
                                    .fill(palette.accentSoft)
                                    .matchedGeometryEffect(id: "selection", in: namespace)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        // Only the track animates: a transaction around the write would also animate whatever the
        // selection swaps elsewhere (a panel's views, a result list, a whole settings page).
        .animation(Motion.standard, value: selection)
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
        .fixedSize()
        .opacity(enabled ? 1 : 0.5)
        // One element holding the options: a label the caller gives names the control, and each
        // option keeps its own name.
        .accessibilityElement(children: .contain)
    }
}
