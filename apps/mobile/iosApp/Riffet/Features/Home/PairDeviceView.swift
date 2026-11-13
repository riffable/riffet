import SwiftUI
import RiffetKit
import CoreImage.CIFilterBuiltins

/// A one-use code and QR from the server this phone is connected to, for another device to join it.
struct PairDeviceView: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var issued: Issued?
    @State private var error: String?
    @State private var attempt = 0
    @State private var copied = false
    @State private var expired = false

    /// The server's own TTL; a phone clock ahead of the server's must not stretch it.
    private static let ttl: TimeInterval = 300

    private struct Issued {
        let code: String
        let address: String
        let deadline: Date
        let localOnly: Bool
        /// Nil for a server that predates `payload`; the address and typed code still work.
        let qr: UIImage?
    }

    var body: some View {
        Form {
            Section {
                qrView.frame(maxWidth: .infinity).padding(.vertical, 8)
            }.listRowBackground(Color.clear)
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                    Button("重试") { attempt += 1 }
                }.listRowBackground(palette.groupedRow)
            }
            if let issued {
                Section {
                    HStack {
                        if expired { Text("已过期").foregroundStyle(.red) }
                        else { Text("有效至 \(issued.deadline.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(AppLocalization.shared.locale)))").foregroundStyle(.secondary) }
                        Spacer()
                        Button("重新生成") { attempt += 1 }
                    }
                    LabeledContent("服务器地址") { Text(issued.address).textSelection(.enabled) }
                    LabeledContent("配对码") {
                        HStack {
                            Text(issued.code).font(.body.monospaced()).textSelection(.enabled)
                            Button(copied ? "已复制" : "复制配对码", systemImage: copied ? "checkmark" : "doc.on.doc") { copy(issued.code) }
                                .labelStyle(.iconOnly)
                        }
                    }
                }
                    .listRowBackground(palette.groupedRow)
                if issued.localOnly {
                    Section {
                        Label("服务器只监听本机，其他设备无法连接。", systemImage: "exclamationmark.triangle").foregroundStyle(palette.warning)
                    }.listRowBackground(palette.groupedRow)
                }
            }
        }
        .scrollContentBackground(.hidden).background(palette.bgSidebar)
        .navigationTitle(String(localized: "配对新设备", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .task(id: attempt) { await generate() }
    }

    @ViewBuilder private var qrView: some View {
        let side: CGFloat = 232
        if issued == nil || issued?.qr != nil {
            ZStack {
                if let qr = issued?.qr {
                    // The encoder adds no quiet zone; the padding on white is it.
                    Image(uiImage: qr).interpolation(.none).resizable().padding(14).opacity(expired ? 0.12 : 1)
                } else if error == nil {
                    ProgressView()
                }
            }
            .frame(width: side, height: side)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .accessibilityHidden(true)
        }
    }

    private func generate() async {
        issued = nil; error = nil; expired = false
        guard let api = workbench.api else { error = String(localized: "未连接服务器", bundle: .riffet); return }
        do {
            let response = try await api.pairingCode(name: nil)
            let host = response.hosts.first ?? ""
            let bracketed = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
            let server = Date(timeIntervalSince1970: TimeInterval(response.expiresAt) / 1000)
            let deadline = min(server, Date().addingTimeInterval(Self.ttl))
            issued = Issued(
                code: response.code,
                address: "\(response.scheme)://\(bracketed):\(response.port)",
                deadline: deadline,
                localOnly: response.localOnly,
                qr: response.payload.flatMap(Self.qrImage)
            )
            try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
            expired = true
        } catch is CancellationError {
        } catch { self.error = error.riffetMessage }
    }

    private func copy(_ code: String) {
        UIPasteboard.general.string = code
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
    }

    private static let qrContext = CIContext()

    /// Encoded here from the server's `payload` rather than read out of the SVG it also sends, so a
    /// change in the server's QR library cannot break the picture.
    private static func qrImage(_ payload: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // Whole-pixel scaling keeps modules sharp; the view scales the bitmap with nearest-neighbour.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cgImage = qrContext.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
