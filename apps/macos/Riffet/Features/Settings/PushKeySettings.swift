import SwiftUI
import UniformTypeIdentifiers
import RiffetKit

/// The APNs key status of the connected server; loaded with the device list (docs/DEVICES.md §3「后台推送」).
@MainActor @Observable
final class PushKeyStore {
    private(set) var status: PushKeyStatus?
    var error: String?
    private(set) var busy = false
    /// Bumped on a server switch, so an answer from the previous server is dropped.
    private var generation = 0

    func reset() {
        generation += 1
        status = nil
        error = nil
    }

    /// A server without `/api/settings/push` (404) shows no section rather than an error.
    func load(_ api: RiffetApi) async {
        let asked = generation
        do {
            let loaded = try await api.pushKey()
            guard asked == generation else { return }
            status = loaded
            error = nil
        } catch where error.riffetStatus == 404 {
            guard asked == generation else { return }
            status = nil
            self.error = nil
        } catch {
            guard asked == generation else { return }
            self.error = error.riffetMessage
        }
    }

    /// True when the change went through.
    @discardableResult
    func run(_ work: () async throws -> PushKeyStatus) async -> Bool {
        busy = true
        error = nil
        defer { busy = false }
        let asked = generation
        do {
            let changed = try await work()
            guard asked == generation else { return false }
            status = changed
            return true
        } catch {
            if asked == generation { self.error = error.riffetMessage }
            return false
        }
    }
}

/// 推送: the APNs auth key this server sends iPhone notifications with. Mirrors the web's `PushKeySection`.
struct PushKeyBlock: View {
    let store: PushKeyStore
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var keyId = ""
    @State private var teamId = ""
    @State private var file: (name: String, text: String)?
    @State private var picking = false
    @State private var confirmRemove = false

    var body: some View {
        if let status = store.status {
            SettingsBlock("推送", detail: "密钥只保存在这台服务器上") {
                if status.configured {
                    configured(status)
                } else {
                    form
                }
                SettingsErrorText(message: store.error)
            }
        } else if let error = store.error {
            SettingsBlock("推送") { SettingsErrorText(message: error) }
        }
    }

    private func configured(_ status: PushKeyStatus) -> some View {
        let invalid = status.status == "invalid"
        let detail = [[status.keyId, status.teamId].compactMap { $0 }.joined(separator: " · "), invalid ? status.detail : nil]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return SettingsRow(String("APNs"), detail: detail) {
            HStack(spacing: Space.md) {
                Circle()
                    .fill(invalid ? palette.danger : palette.success)
                    .frame(width: 6, height: 6)
                SettingsActionButton("移除", kind: .danger) { confirmRemove = true }
                    .controlSize(.small)
                    .disabled(store.busy)
            }
        }
        .confirmationDialog("移除推送密钥？", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("移除", role: .destructive) {
                Task { await perform { try await $0.removePushKey() } }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("iPhone 在后台将不再收到通知")
        }
    }

    private var form: some View {
        HStack(spacing: Space.sm) {
            TextField(text: upper($keyId)) { Text(verbatim: "Key ID") }
                .font(.riffet(size: S(13), design: .monospaced))
                .formField(bezeled: true)
                .frame(width: 120)
            TextField(text: upper($teamId)) { Text(verbatim: "Team ID") }
                .font(.riffet(size: S(13), design: .monospaced))
                .formField(bezeled: true)
                .frame(width: 120)
            Button { picking = true } label: {
                if let file {
                    Text(verbatim: file.name).lineLimit(1).truncationMode(.middle)
                } else {
                    Text("选择 .p8 文件")
                }
            }
            .buttonStyle(SolidButtonStyle(kind: .secondary))
            .frame(maxWidth: 200)
            .fileImporter(isPresented: $picking, allowedContentTypes: [UTType(filenameExtension: "p8") ?? .data]) { result in
                if case let .success(url) = result { pick(url) }
            }
            Spacer(minLength: Space.sm)
            SettingsActionButton("保存", kind: .primary) {
                guard let file else { return }
                let input = PushKeyInput(keyId: trimmed(keyId), teamId: trimmed(teamId), key: file.text)
                Task { await perform { try await $0.savePushKey(body: input) } }
            }
            .disabled(store.busy || trimmed(keyId).isEmpty || trimmed(teamId).isEmpty || file == nil)
        }
        .disabled(store.busy)
    }

    private func pick(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            file = (url.lastPathComponent, try String(contentsOf: url, encoding: .utf8))
        } catch {
            store.error = error.localizedDescription
            return
        }
        // Apple names the file `AuthKey_<Key ID>.p8`.
        if trimmed(keyId).isEmpty, let match = url.lastPathComponent.firstMatch(of: #/AuthKey_([A-Z0-9]{10})\.p8$/#.ignoresCase()) {
            keyId = String(match.1).uppercased()
        }
    }

    private func perform(_ work: @escaping (RiffetApi) async throws -> PushKeyStatus) async {
        guard let api = model.workbench?.host.api else { return }
        if await store.run({ try await work(api) }) { file = nil }
    }

    private func upper(_ value: Binding<String>) -> Binding<String> {
        Binding(get: { value.wrappedValue }, set: { value.wrappedValue = $0.uppercased() })
    }

    private func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
}
