import SwiftUI

struct MessageComposer: View {
    @Binding var text: String
    var placeholder: String = "继续这项任务…"
    var onSend: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...6)
                .padding(.horizontal, 15)
                .padding(.vertical, 12)
                .frame(minHeight: 46)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
                .accessibilityLabel("消息内容")
                .accessibilityIdentifier("messageComposer")
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .frame(minWidth: 44, minHeight: 46)
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("发送消息")
            .accessibilityIdentifier("sendMessage")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }
}
