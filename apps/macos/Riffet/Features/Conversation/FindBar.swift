import AppKit
import SwiftUI
import RiffetKit

/// 会话内查找: the field, the occurrence count and the steps through them, floating at the top
/// right of the transcript. The search itself is `SessionFind`; the transcript lands on each target.
struct FindBar: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @FocusState private var focused: Bool
    @State private var query = ""

    var body: some View {
        HStack(spacing: 6) {
            Image(icon: "magnifyingglass").font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4)
            TextField("在会话中查找", text: $query)
                .textFieldStyle(.plain)
                .font(.riffet(size: S(12.5)))
                .focused($focused)
                .frame(width: 150)
                .onSubmit { NSEvent.modifierFlags.contains(.shift) ? workbench.findPrevious() : workbench.findNext() }
                .onExitCommand { close() }
            Text(count(workbench.find))
                .font(.riffet(size: S(11.5)).monospacedDigit())
                .foregroundStyle(palette.fg3)
                .opacity(query.isEmpty ? 0 : 1)
            Button { workbench.findPrevious() } label: { Image(icon: "chevron.up") }
                .help("上一个")
            Button { workbench.findNext() } label: { Image(icon: "chevron.down") }
                .help("下一个")
            Button { close() } label: { Image(icon: "xmark") }
                .help("关闭查找")
        }
        .buttonStyle(IconButtonStyle(size: 22))
        .padding(.leading, Space.sm)
        .padding(.trailing, 4)
        .frame(height: 30)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgElevated))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
        .elevation(.pop)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isSearchField)
        .accessibilityLabel("在会话中查找")
        .onChange(of: query) { _, text in workbench.setFind(query: text) }
        .onChange(of: workbench.findFocus, initial: true) { _, _ in
            focused = true
            DispatchQueue.main.async { NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil) }
        }
        .onAppear { query = workbench.find?.query ?? "" }
    }

    private func count(_ find: FindState?) -> String {
        guard let find else { return "0/0" }
        return "\(find.current >= 0 ? Int(find.current) + 1 : 0)/\(find.total)"
    }

    private func close() {
        focused = false
        workbench.closeFind()
    }
}
