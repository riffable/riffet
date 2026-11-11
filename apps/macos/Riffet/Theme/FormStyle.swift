import SwiftUI

extension View {
    /// A form as the style draws it: the system's grouped boxes, or bare rows split by hairlines
    /// under each section's title (`StyleSpec.Form`). Every form uses this, never `.formStyle(.grouped)`.
    func riffetForm() -> some View { modifier(RiffetFormModifier()) }

    /// A text field in a form. A lined form draws it as a hairline on the paper; otherwise it keeps
    /// the system's look, with a rounded bezel when `bezeled`. A grouped form shows a field's title
    /// beside it, a lined one only as a placeholder: a field that is its own row passes `label` too.
    func formField(bezeled: Bool = false, label: LocalizedStringResource? = nil) -> some View {
        modifier(FormFieldModifier(bezeled: bezeled, label: label))
    }

    /// A pop-up menu in a form. A lined form shows its title and chevrons alone, without the bezel.
    func formPicker() -> some View { modifier(FormPickerModifier()) }
}

private struct FormFieldModifier: ViewModifier {
    let bezeled: Bool
    let label: LocalizedStringResource?
    @Environment(\.palette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        switch DisplayPreferences.shared.style.form {
        case .grouped:
            if bezeled { content.textFieldStyle(.roundedBorder) } else { content }
        case .lined:
            if let label {
                LabeledContent { outlined(content).frame(maxWidth: 320) } label: { Text(label) }
            } else {
                outlined(content)
            }
        }
    }

    private func outlined(_ content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .padding(.horizontal, Space.sm)
            .frame(minHeight: 28)
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
    }
}

private struct FormPickerModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        switch DisplayPreferences.shared.style.form {
        case .grouped: content
        // A borderless button style is what the system's pop-up reads to drop its bezel.
        case .lined: content.buttonStyle(.borderless)
        }
    }
}

/// A segmented choice in a form, written like a `Picker`: a title, then options tagged with their
/// value. The system's segmented control, or on a lined form a quiet track with the chosen option
/// on the paper under a hairline. The title names the control for VoiceOver; it is shown only where
/// the system's segmented control would show it, and the drawn one is always set in a titled row.
struct FormSegmented<Value: Hashable, Content: View>: View {
    let title: LocalizedStringResource
    @Binding var selection: Value
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    init(_ title: LocalizedStringResource, selection: Binding<Value>, @ViewBuilder content: () -> Content) {
        self.title = title
        _selection = selection
        self.content = content()
    }

    var body: some View {
        switch DisplayPreferences.shared.style.form {
        case .grouped:
            Picker(selection: $selection) { content } label: { Text(title) }.pickerStyle(.segmented)
        case .lined:
            // A group named by the title; each option keeps its own name.
            drawn.accessibilityElement(children: .contain).accessibilityLabel(Text(title))
        }
    }

    private var drawn: some View {
        SegmentedTrack(selection: $selection) { content }
    }
}

/// The quiet segmented control: the chosen option on the paper under a hairline, on a muted track,
/// sliding to the next one rather than blinking over. It reads like the toolbar's segmented control,
/// so a switch inside a page or panel does not take the accent colour the system gives its own there.
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
                                    .fill(palette.bgElevated)
                                    .overlay(RoundedRectangle(cornerRadius: max(Radius.control - 2, 2), style: .continuous).strokeBorder(palette.line))
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
        .animation(.snappy(duration: 0.2), value: selection)
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
        .fixedSize()
        .opacity(enabled ? 1 : 0.5)
        // One element holding the options: a label the caller gives names the control, and each
        // option keeps its own name.
        .accessibilityElement(children: .contain)
    }
}

/// A modifier rather than one `FormStyle` that switches: the system's grouped style cannot be
/// wrapped from inside `makeBody`.
private struct RiffetFormModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        switch DisplayPreferences.shared.style.form {
        case .grouped: content.formStyle(.grouped)
        case .lined: content.formStyle(LinedFormStyle())
        }
    }
}

/// After Claude Desktop's settings: no boxes and no fill. A title over each section, then its rows
/// split by hairlines, the control on the trailing edge. The page keeps the window's own backdrop.
private struct LinedFormStyle: FormStyle {
    @Environment(\.palette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xxl - Space.xs) {
                ForEach(sections: configuration.content) { section in
                    VStack(alignment: .leading, spacing: 0) {
                        if !section.header.isEmpty {
                            section.header.padding(.bottom, Space.md)
                        }
                        // Subviews that resolve to nothing (an `if` that is false) are not rows.
                        ForEach(subviews: section.content) { row in
                            row
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, Space.md)
                            Rectangle().fill(palette.line).frame(height: 1)
                        }
                        if !section.footer.isEmpty {
                            section.footer
                                .font(.riffet(size: S(11.5)))
                                .foregroundStyle(palette.fg4)
                                .padding(.top, Space.sm)
                        }
                    }
                }
            }
            // A reading column: wide panes and sheets keep the rows from stretching across.
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity)
            .padding(Space.xl)
        }
        .toggleStyle(TrailingSwitchStyle())
        .labeledContentStyle(TrailingContentStyle())
        .environment(\.chipOutlined, true)
    }
}

/// A switch's label on the leading side, the switch on the trailing edge. An explicit style on a
/// toggle (a hidden-label switch inside a custom row) still wins over this one.
/// `.labelsHidden()` reaches a custom style only through `labelsVisibility`, so both honour it.
private struct TrailingSwitchStyle: ToggleStyle {
    @Environment(\.labelsVisibility) private var labels

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Space.md) {
            if labels != .hidden {
                configuration.label
                Spacer(minLength: Space.md)
            }
            // The toggle itself, so VoiceOver still reads its label.
            Toggle(configuration)
                .toggleStyle(.switch)
                .labelsHidden()
        }
    }
}

private struct TrailingContentStyle: LabeledContentStyle {
    @Environment(\.labelsVisibility) private var labels

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Space.md) {
            if labels != .hidden {
                configuration.label
                Spacer(minLength: Space.md)
            }
            configuration.content
        }
    }
}

extension Palette {
    /// The fill of a card or field beside a form's sections. A lined form has no fills: the outline
    /// each of these already draws is what holds it.
    @MainActor func formFill(_ fill: Color) -> Color {
        DisplayPreferences.shared.style.form == .lined ? .clear : fill
    }
}
