import RiffetKit
import SwiftUI

/// What `GET /api/shares/capability` says about one publisher; RiffetKit reads it only inside a session's status.
private struct PublisherCapability: Decodable {
    struct Publisher: Decodable, Hashable {
        let id: String
        let label: String
    }

    let available: Bool
    let message: String?
    let username: String?
    let profile: String?
    let publisher: Publisher?
    let publishers: [Publisher]?
}

/// 会话分享: every link this server has published, kept manageable after its conversation is gone.
struct SharesSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var items: [SessionShare]?
    @State private var capability: PublisherCapability?
    /// A share is checked against the publisher that made it, which is not always the one new shares use.
    @State private var owned: [String: PublisherCapability] = [:]
    @State private var busy: String?
    @State private var error: String?
    @State private var removing: SessionShare?

    var body: some View {
        Form {
            if app.workbench == nil {
                Section { SettingsHint("连接服务器后可修改。") }
            } else if let items {
                content(items)
            } else if let error {
                Section {
                    SettingsErrorText(message: error)
                    SettingsActionButton("重试", symbol: "arrow.clockwise") { Task { await load() } }
                }
            } else {
                Section { HStack { Spacer(); Spinner(size: .small); Spacer() } }
            }
            SettingsScopeFooter()
        }
        .riffetForm()
        .task(id: app.workbench?.baseURL) { if app.workbench != nil { await load() } }
        .task(id: polling) {
            // An operation in flight finishes on the server; its row is read until it does.
            guard polling, let api = app.workbench?.host.api else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                if let values = try? await api.shares(), !Task.isCancelled { items = values }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.shares.rawValue, app.workbench != nil else { return }
            Task { await load() }
        }
        .confirmationDialog("取消分享？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { share in
            Button("取消分享", role: .destructive) { act(share, .remove) }
            Button("取消", role: .cancel) {}
        } message: { _ in
            Text("链接将失效。")
        }
    }

    private var polling: Bool {
        items?.contains { $0.operation != nil && $0.operation != "uncertain" } ?? false
    }

    @ViewBuilder
    private func content(_ items: [SessionShare]) -> some View {
        let visible = items.filter { $0.state != "removed" || $0.operation != nil }
        Section {
            SettingsRow(headline) {
                SettingsActionButton("刷新", symbol: "arrow.clockwise") { Task { await load() } }
                    .controlSize(.small)
                    .disabled(busy != nil)
            }
            if let capability, let current = capability.publisher, let publishers = capability.publishers, publishers.count > 1 {
                SettingsRow("发布到") {
                    Picker("发布到", selection: Binding(get: { current.id }, set: { choosePublisher($0) })) {
                        ForEach(publishers, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    .labelsHidden()
                    .formPicker()
                    .fixedSize()
                }
            }
        }
        Section {
            if visible.isEmpty {
                SettingsHint("在会话菜单中创建分享。")
            }
            ForEach(visible, id: \.id) { share in row(share) }
            SettingsErrorText(message: error)
        }
    }

    private var headline: String {
        guard let capability else { return String(localized: "会话分享") }
        if capability.available {
            return [capability.publisher?.label, capability.username].compactMap { $0 }.joined(separator: " · ")
        }
        return capability.message ?? String(localized: "分享服务暂不可用")
    }

    private func row(_ share: SessionShare) -> some View {
        let own = share.publisher.flatMap { owned[$0] } ?? capability
        let elsewhere = elsewhereMessage(share, own)
        let inFlight = share.operation != nil && share.operation != "uncertain"
        let mismatch = own?.username.map { $0 != share.username || (own?.profile ?? "") != (share.profile ?? "") } ?? false
        let disabled = busy != nil || own?.available != true || elsewhere != nil || mismatch || inFlight
        return HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(share.title).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(1)
                let meta = [share.username, ServerTime.date(share.expiresAt).map { String(localized: "到期时间：\($0.formatted(date: .abbreviated, time: .shortened))") }].compactMap { $0 }
                Text(meta.joined(separator: " · ")).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3)
                if let link = share.url, let url = URL(string: link) {
                    Link(link, destination: url).font(.riffet(size: S(11.5))).lineLimit(1).truncationMode(.middle)
                }
                if let operation = share.operation {
                    Text(operation == "uncertain" ? String(localized: "操作结果待核对") : operation == "publishing" ? String(localized: "正在发布…") : String(localized: "正在取消分享…"))
                        .font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3)
                }
                if let message = share.localizedError() {
                    Text(message).font(.riffet(size: S(11.5))).foregroundStyle(palette.danger)
                }
                if let elsewhere {
                    Text(elsewhere).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3)
                }
            }
            Spacer(minLength: Space.sm)
            HStack(spacing: Space.sm) {
                if busy == share.id { Spinner(size: .mini) }
                if let link = share.url {
                    Button("复制链接") { copyToPasteboard(link) }
                }
                if share.operation == "uncertain" {
                    Button("核对状态") { act(share, .reconcile) }.disabled(disabled)
                    Button("重试") { act(share, .retry) }.disabled(disabled)
                }
                if share.operation == nil || share.operation == "uncertain", share.url != nil || share.previewId != nil {
                    Button("取消分享", role: .destructive) { removing = share }.disabled(disabled)
                }
            }
            .buttonStyle(.link)
            .font(.riffet(size: S(12.5)))
        }
    }

    /// Why this share cannot be checked or cancelled: another integration than the active publisher made it.
    private func elsewhereMessage(_ share: SessionShare, _ capability: PublisherCapability?) -> String? {
        guard let current = capability?.publisher, let publisher = share.publisher, publisher != current.id else { return nil }
        return String(localized: "发布此分享的插件未启用")
    }

    private enum Action { case reconcile, retry, remove }

    private func act(_ share: SessionShare, _ action: Action) {
        guard let api = app.workbench?.host.api else { return }
        busy = share.id
        error = nil
        Task {
            do {
                let value: SessionShare
                switch action {
                case .reconcile: value = try await api.reconcileShare(id: share.id)
                case .retry: value = try await api.retryShare(id: share.id)
                case .remove: value = try await api.removeShare(id: share.id)
                }
                items = items?.map { $0.id == value.id ? value : $0 }
            } catch {
                self.error = error.riffetMessage
            }
            busy = nil
        }
    }

    private func choosePublisher(_ id: String) {
        guard let api = app.workbench?.host.api else { return }
        error = nil
        Task {
            do {
                _ = try await api.setDefaultSharePublisher(id: id)
                await load()
            } catch {
                self.error = error.riffetMessage
            }
        }
    }

    private func load() async {
        guard let api = app.workbench?.host.api else { return }
        do {
            let values = try await api.shares()
            let current: PublisherCapability = try await ServerJSON.send("GET", "/api/shares/capability")
            var found: [String: PublisherCapability] = [:]
            let others = Set(values.compactMap(\.publisher)).filter { $0 != current.publisher?.id }
            for owner in others {
                found[owner] = try? await ServerJSON.send("GET", "/api/shares/capability", query: [URLQueryItem(name: "publisher", value: owner)])
            }
            items = values
            capability = current
            owned = found
            error = nil
        } catch {
            self.error = error.riffetMessage
        }
    }
}
