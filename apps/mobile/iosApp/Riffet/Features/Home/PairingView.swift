import SwiftUI
import RiffetKit

/// What the pairing page starts from: a server the reader picked, or nothing.
private struct PairingPrefill: Hashable {
    var address = ""
    var name: String?
}

/// The first page of an unpaired phone (mobile.md §9.7): the mark, one sentence, the pairing action;
/// servers already paired and Macs found on the network are rows under it.
struct ConnectionView: View {
    @Bindable var model: AppModel
    @Environment(\.palette) private var palette
    @State private var discovery = BonjourDiscovery()
    @State private var target: PairingPrefill?

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 20) {
                BrandMark(front: palette.fg, back: palette.accent).frame(width: 56, height: 56)
                Text(String(localized: "Riffet 运行在你的服务器上", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg2).multilineTextAlignment(.center)
                Button { target = PairingPrefill(address: model.address) } label: {
                    Text(String(localized: "配对", bundle: .riffet)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: 280)
                .accessibilityIdentifier("pairNew")
            }
            .padding(.horizontal, RiffetMetrics.pageInset)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if !model.pairedServers.isEmpty || !discovery.servers.isEmpty || discovery.failure != nil {
                RiffetList {
                    if !model.pairedServers.isEmpty {
                        PairedServersSection(model: model, connects: true) { server in target = PairingPrefill(address: server.baseUrl, name: server.name) }
                    }
                    if !discovery.servers.isEmpty {
                        Section { ForEach(discovery.servers) { found in discovered(found) } }
                            header: { RiffetSectionTitle(String(localized: "同一网络中的设备", bundle: .riffet)) }
                    }
                    // Without local-network permission the search fails; say so, the address still pairs by hand.
                    RiffetNotice.section(.warning, discovery.failure, actionTitle: String(localized: "重新查找", bundle: .riffet)) {
                        discovery.stop(); discovery.start()
                    }
                }
                .containerRelativeFrame(.vertical) { height, _ in height * 0.5 }
            }
        }
        .background(palette.bg)
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $target) { prefill in
            PairingView(model: model, initialAddress: prefill.address, initialName: prefill.name)
        }
        .task {
            model.error = nil
            await model.refreshPairedServers()
            discovery.start()
        }
        .onDisappear { discovery.stop() }
    }

    private func discovered(_ found: DiscoveredRiffetServer) -> some View {
        Button { target = PairingPrefill(address: found.baseURL, name: found.name) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(found.name).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                    Text(found.baseURL).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg3)
            }
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The pairing page (mobile.md §2.3): the server address and the code, 配对 on the bar's trailing edge,
/// scanning a bar icon that pushes the camera, pasting an icon inside the code field.
struct PairingView: View {
    @Bindable var model: AppModel
    var initialServer: PairedServer? = nil
    var initialAddress: String? = nil
    var initialName: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var address = ""
    @State private var code = ""
    @State private var scanning = false
    @State private var scannerError: String?
    @State private var serviceName: String?
    @State private var namedAddress = ""
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
        }
        .navigationDestination(isPresented: $scanning) {
            PairingScanner(onDecoded: { raw in
                scanning = false
                do {
                    let value = try model.decodePairing(raw)
                    address = value.address; code = value.code
                    serviceName = value.name; namedAddress = value.address
                    scannerError = nil; model.error = nil
                } catch { scannerError = error.riffetMessage }
            }, onFailure: { failure in scannerError = failure.localizedDescription; scanning = false })
            .overlay { ScannerFrame() }
            .ignoresSafeArea()
            .navigationTitle(String(localized: "扫描二维码", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        }
    }

    private func pair() {
        guard !model.connectionBusy, !address.isEmpty, !code.isEmpty else { return }
        Task { if await model.pair(address: address, code: code, name: address == namedAddress ? serviceName : nil) { code = ""; dismiss() } }
    }
}
