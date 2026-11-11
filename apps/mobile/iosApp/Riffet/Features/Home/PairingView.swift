import SwiftUI
import RiffetKit

struct PairingView: View {
    @Bindable var model: AppModel
    var initialServer: PairedServer? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var discovery = BonjourDiscovery()
    @State private var address = ""
    @State private var code = ""
    @State private var scanning = false
    @State private var scannerError: String?
    @State private var serviceName: String?
    @State private var namedAddress = ""
    var body: some View {
        Form {
            if model.workbench == nil && !model.pairedServers.isEmpty {
                PairedServersSection(model: model) { server in
                    address = server.baseUrl
                    serviceName = server.name
                    namedAddress = server.baseUrl
                    code = ""
                    model.error = nil
                }
            }
            Section("配对新服务器") {
                Text("在服务器上运行 `riffet pair`，或在已连接的设备上选择「配对新设备」获取配对码。")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button { scanning = true } label: { Label("扫描配对二维码", systemImage: "qrcode.viewfinder") }
                    .accessibilityIdentifier("scanPairing")
            }
            Section("手动连接") {
                TextField("http://Mac.local:4337", text: $address)
                    .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("serverAddress")
                TextField("一次性配对码", text: $code).textContentType(.oneTimeCode).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .accessibilityIdentifier("pairingCode")
                Button {
                    Task { if await model.pair(address: address, code: code, name: address == namedAddress ? serviceName : nil) { code = ""; dismiss() } }
                } label: {
                    HStack { Text(model.pairing ? "正在配对…" : "连接"); if model.pairing { ProgressView() } }
                }
                .disabled(model.connectionBusy || address.isEmpty || code.isEmpty)
                .accessibilityIdentifier("pairServer")
            }
            if let error = model.error ?? scannerError {
                Section {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                    if model.needsNetworkSettings {
                        Button("打开系统设置") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                }
            }
            Section {
                if discovery.servers.isEmpty { Text("尚未发现附近的 Mac").foregroundStyle(.secondary) }
                ForEach(discovery.servers) { server in
                    Button { address = server.baseURL; namedAddress = server.baseURL; serviceName = server.name } label: {
                        VStack(alignment: .leading) { Text(server.name); Text(server.baseURL).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                if let failure = discovery.failure { Text(failure).font(.caption).foregroundStyle(.secondary) }
                Button("重新查找") { discovery.stop(); discovery.start() }
            } header: { Text("同一网络中的设备") } footer: {
                Text("未发现设备时仍可手动连接。局域网 HTTP 不加密；跨网络连接请使用你配置的 HTTPS 地址。")
            }
        }
        .navigationTitle(initialServer == nil ? String(localized: "连接与配对", bundle: .riffet) : String(localized: "重新配对", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .task {
            address = initialServer?.baseUrl ?? model.address
            serviceName = initialServer?.name
            namedAddress = initialServer?.baseUrl ?? ""
            model.error = nil
            await model.refreshPairedServers()
            discovery.start()
        }
        .onDisappear { discovery.stop() }
        .sheet(isPresented: $scanning) {
            NavigationStack {
                PairingScanner(onDecoded: { raw in
                    scanning = false
                    do {
                        let value = try model.decodePairing(raw)
                        address = value.address; code = value.code
                        serviceName = value.name; namedAddress = value.address
                        scannerError = nil
                    }
                    catch { scannerError = error.riffetMessage }
                }, onFailure: { failure in scannerError = failure.localizedDescription; scanning = false })
                .navigationTitle(String(localized: "扫描二维码", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { scanning = false } } }
            }
        }
    }
}
