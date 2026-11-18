import SwiftUI
import RiffetKit

/// What the pairing page starts from: a server the reader picked, or nothing; `scan` opens the camera at once.
struct PairingPrefill: Hashable {
    var address = ""
    var name: String?
    var scan = false
}

/// The pairing page (mobile.md §2.3): the server address and the code, 配对 on the bar's trailing edge,
/// scanning a bar icon that pushes the camera, pasting an icon inside the code field.
struct PairingView: View {
    @Bindable var model: AppModel
    var initialServer: PairedServer? = nil
    var initialAddress: String? = nil
    var initialName: String? = nil
    var initialScan = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var address = ""
    @State private var code = ""
    @State private var scanning = false
    @State private var scannerError: String?
    @State private var serviceName: String?
    @State private var namedAddress = ""
    /// The scanned QR's other addresses, tried when the one in the field does not answer.
    @State private var alternates: [String] = []
    /// The fields are filled once: coming back from the scanner must not put the old address back.
    @State private var prefilled = false

    private var insecure: Bool { address.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("http://") }

    var body: some View {
        RiffetForm {
            Section {
                RiffetField(label: String(localized: "服务器地址", bundle: .riffet), prompt: "http://Mac.local:4337", text: $address, mono: true)
                    .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.next)
                    .accessibilityIdentifier("serverAddress")
                HStack(spacing: 8) {
                    RiffetField(label: String(localized: "配对码", bundle: .riffet), prompt: String(localized: "一次性配对码", bundle: .riffet), text: $code, mono: true)
                        .textContentType(.oneTimeCode).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .submitLabel(.go).onSubmit(pair)
                        .accessibilityIdentifier("pairingCode")
                    Button { if let text = UIPasteboard.general.string { code = text.trimmingCharacters(in: .whitespacesAndNewlines) } } label: {
                        Image(systemName: "doc.on.clipboard").riffetFont(.body).foregroundStyle(palette.fg2)
                            .frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel(String(localized: "粘贴", bundle: .riffet))
                }
            }
            if let error = model.error ?? scannerError {
                Section {
                    RiffetNotice(kind: .error, message: error,
                                 actionTitle: model.needsNetworkSettings ? String(localized: "打开系统设置", bundle: .riffet) : nil) {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            } else if insecure {
                Section {
                    RiffetNotice(kind: .warning, message: String(localized: "局域网 HTTP 不加密；跨网络连接请使用你配置的 HTTPS 地址。", bundle: .riffet))
                }
            }
        }
        .navigationTitle(initialServer == nil ? String(localized: "配对", bundle: .riffet) : String(localized: "重新配对", bundle: .riffet))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(model.pairing)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { scanning = true } label: { Image(systemName: "qrcode.viewfinder") }
                    .disabled(model.connectionBusy)
                    .accessibilityLabel(String(localized: "扫描二维码", bundle: .riffet))
                    .accessibilityIdentifier("scanPairing")
            }
            ToolbarItem(placement: .confirmationAction) {
                if model.pairing { ProgressView() }
                else {
                    Button(String(localized: "配对", bundle: .riffet), action: pair)
                        .disabled(model.connectionBusy || address.isEmpty || code.isEmpty)
                        .accessibilityIdentifier("pairServer")
                }
            }
        }
        .task {
            guard !prefilled else { return }
            prefilled = true
            address = initialServer?.baseUrl ?? initialAddress ?? model.address
            serviceName = initialServer?.name ?? initialName
            namedAddress = initialServer?.baseUrl ?? initialAddress ?? ""
            model.error = nil
            if initialScan { scanning = true }
        }
        .navigationDestination(isPresented: $scanning) {
            PairingScanner(onDecoded: { raw in
                scanning = false
                do {
                    let value = try model.decodePairing(raw)
                    address = value.address; code = value.code
                    serviceName = value.name; namedAddress = value.address; alternates = value.alternates
                    scannerError = nil; model.error = nil
                    // Opened by 扫码配对: the code is the whole input, so scanning it pairs.
                    if initialScan { pair() }
                } catch { scannerError = error.riffetMessage }
            }, onFailure: { failure in scannerError = failure.localizedDescription; scanning = false })
            .overlay { ScannerFrame() }
            .ignoresSafeArea()
            .navigationTitle(String(localized: "扫描二维码", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        }
    }

    private func pair() {
        guard !model.connectionBusy, !address.isEmpty, !code.isEmpty else { return }
        let scanned = address == namedAddress
        Task { if await model.pair(address: address, code: code, name: scanned ? serviceName : nil, alternates: scanned ? alternates : []) { code = ""; dismiss() } }
    }
}
