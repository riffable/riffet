import SwiftUI

/// Pairs with a server on any reachable machine: its address and the five-minute code `riffet pair`
/// prints there. The payload that command (and its QR code) encodes can be pasted into the address.
struct RemotePairingSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var address = ""
    @State private var code = ""
    /// The name the payload carried and the address it filled in; a name of another address is not kept.
    @State private var payloadName: String?
    @State private var payloadAddress: String?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("连接服务器").font(RiffetFont.text(RiffetTextSize.lg, weight: .medium))
            Text("在服务器上执行 riffet pair 获取配对码。")
                .font(RiffetFont.caption).foregroundStyle(palette.fg3)
                .fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("地址", text: $address, prompt: Text(verbatim: "192.168.1.10:4337"))
                    .formField()
                    .onChange(of: address) { _, value in applyPayload(value) }
                TextField("配对码", text: $code)
                    .formField()
            }
            .riffetForm()
            if let error { Text(error).font(RiffetFont.caption).foregroundStyle(palette.danger) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("配对") {
                    busy = true
                    error = nil
                    Task {
                        do {
                            try await model.pairRemote(
                                address: address,
                                code: code.trimmingCharacters(in: .whitespaces),
                                name: address == payloadAddress ? payloadName : nil
                            )
                            dismiss()
                        } catch {
                            self.error = error.riffetMessage
                        }
                        busy = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy || address.isEmpty || code.isEmpty)
            }
        }
        .padding(Space.xl)
        .frame(width: 460)
    }

    private func applyPayload(_ raw: String) {
        guard let payload = PairingPayload(parsing: raw) else { return }
        address = payload.address
        code = payload.code
        payloadAddress = payload.address
        payloadName = payload.name
    }
}
