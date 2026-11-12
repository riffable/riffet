import AppKit
import SwiftUI

/// 机器人: the IM bots connected to this server. A row opens that bot in place; its card has a page of its own.
struct ChannelsSettings: View {
    private enum Pending: Identifiable {
        case deleteBot(ChannelAccount)
        case unbind(ChannelIdentity)
        case removeChat(ChannelChat)

        var id: String {
            switch self {
            case let .deleteBot(account): "bot-\(account.id)"
            case let .unbind(identity): "identity-\(identity.id)"
            case let .removeChat(chat): "chat-\(chat.key)"
            }
        }
    }

    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var model = ChannelsModel()
    @State private var detailId: String?
    @State private var showCard = false
    @State private var sheet: ChannelSheet?
    @State private var pending: Pending?

    var body: some View {
        Form {
            if app.workbench == nil {
                Section { SettingsHint("连接服务器后可修改。") }
            } else if let state = model.state {
                if let id = detailId, let account = state.accounts.first(where: { $0.id == id }) {
                    if showCard { card(account) } else { detail(account, state) }
                } else {
                    list(state)
                }
                if let error = model.error { Section { SettingsErrorText(message: error) } }
            } else if let error = model.loadError {
                Section {
                    SettingsErrorText(message: error)
                    SettingsActionButton("重试", symbol: "arrow.clockwise") { Task { await model.reload() } }
                }
            } else {
                Section { HStack { Spacer(); Spinner(size: .small); Spacer() } }
            }
            SettingsScopeFooter()
        }
        .riffetForm()
        .task(id: app.workbench?.baseURL) { if app.workbench != nil { await model.reload() } }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.channels.rawValue, app.workbench != nil else { return }
            Task { await model.reload() }
        }
        .sheet(item: $sheet, onDismiss: { Task { await model.reload() } }) { sheet in
            switch sheet {
            case .add: ChannelAddSheet(mode: .add, model: model)
            case let .reauthorize(account): ChannelAddSheet(mode: .reauthorize(account), model: model)
            case let .replace(account): ChannelAddSheet(mode: .replace(account), model: model)
            case let .bind(account): ChannelBindSheet(account: account)
            }
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible, presenting: pending) { item in
            switch item {
            case let .deleteBot(account):
                Button("删除", role: .destructive) {
                    Task { await model.perform { try await ChannelsAPI.delete(account.id); detailId = nil; showCard = false } }
                }
            case let .unbind(identity):
                Button("解绑", role: .destructive) { Task { await model.perform { try await ChannelsAPI.deleteIdentity(identity.id) } } }
            case let .removeChat(chat):
                Button("移除", role: .destructive) { Task { await model.perform { try await ChannelsAPI.deleteChat(chat.key) } } }
            }
            Button("取消", role: .cancel) {}
        } message: { item in
            switch item {
            case .deleteBot: Text("飞书里的应用不会被删除")
            case .unbind: EmptyView()
            case .removeChat: Text("这个聊天里的会话绑定一并忘记")
            }
        }
    }

    private var confirmTitle: String {
        switch pending {
        case let .deleteBot(account): String(localized: "删除 \(account.name)？")
        case let .unbind(identity): String(localized: "解绑 \(identity.name ?? identity.userId)？")
        case let .removeChat(chat): String(localized: "移除 \(chat.name ?? chat.chatId)？")
        case nil: ""
        }
    }

    // MARK: List

    @ViewBuilder
    private func list(_ state: ChannelsState) -> some View {
        Section {
            ForEach(state.accounts) { account in
                Button { detailId = account.id } label: {
                    HStack(spacing: Space.sm) {
                        avatar(account, size: 24)
                        Text(account.name).foregroundStyle(palette.fg)
                        if account.isLark { Text(verbatim: "Lark").font(.riffet(size: S(11))).foregroundStyle(palette.fg3) }
                        Spacer(minLength: Space.sm)
                        let status = status(account)
                        SettingsStatusBadge(text: status.text, tint: status.tint)
                        Image(icon: "chevron.right").font(.riffet(size: S(11), weight: .semibold)).foregroundStyle(palette.fg4)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            SettingsActionButton("添加飞书机器人", symbol: "plus", kind: state.accounts.isEmpty ? .primary : .secondary) { sheet = .add }
                .controlSize(.small)
        }
    }

    private func status(_ account: ChannelAccount) -> (text: String, tint: Color) {
        let pending = model.pending(account)
        switch account.status.state {
        case "disabled": return (String(localized: "已停用"), palette.fg3)
        case "connecting": return (String(localized: "连接中"), palette.warning)
        case "connected":
            if pending > 0 { return (String(localized: "待完成 \(pending) 项"), palette.warning) }
            let last = ServerTime.relative(model.healths[account.id]?.lastEventAt ?? account.status.lastEventAt)
            return (last.map { String(localized: "已连接 · \($0)") } ?? String(localized: "已连接"), palette.success)
        default: return (String(localized: "连接失败"), palette.danger)
        }
    }

    private func avatar(_ account: ChannelAccount, size: CGFloat) -> some View {
        AsyncImage(url: account.avatarUrl.flatMap(URL.init(string:))) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Image(icon: "person.crop.circle").resizable().scaledToFit().foregroundStyle(palette.fg3)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    // MARK: Bot

    @ViewBuilder
    private func detail(_ account: ChannelAccount, _ state: ChannelsState) -> some View {
        let identities = state.identities.filter { $0.account == account.id }
        let chats = state.chats.filter { $0.account == account.id }
        Section {
            backButton(String(localized: "机器人")) { detailId = nil }
            SettingsRow(account.name, detail: "\(account.appId) · \(account.isLark ? "Lark" : String(localized: "飞书"))") {
                HStack(spacing: Space.sm) {
                    CopyButton(text: account.appId, help: String(localized: "复制 App ID"))
                    if let link = account.links.open, let url = URL(string: link) {
                        SettingsActionButton("在飞书中打开") { NSWorkspace.shared.open(url) }.controlSize(.small)
                    }
                    Menu {
                        Button("重新扫码授权") { sheet = .reauthorize(account) }
                        Button("更换凭据") { sheet = .replace(account) }
                        if let link = account.links.console, let url = URL(string: link) {
                            Button("打开开发者后台") { NSWorkspace.shared.open(url) }
                        }
                        Divider()
                        Button("删除", role: .destructive) { pending = .deleteBot(account) }
                    } label: {
                        Image(icon: "ellipsis")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .disabled(model.busy)
                }
            }
        }

        checklist(account)

        Section {
            Toggle("启用", isOn: Binding(
                get: { account.enabled },
                set: { value in Task { await model.perform { try await ChannelsAPI.update(account.id, ["enabled": value]) } } }
            ))
            .disabled(model.busy)
            Button { showCard = true } label: {
                HStack {
                    Text("卡片").foregroundStyle(palette.fg)
                    Spacer()
                    Image(icon: "chevron.right").font(.riffet(size: S(11), weight: .semibold)).foregroundStyle(palette.fg4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }

        SettingsBlock("可以使用的人") {
            ForEach(identities) { identity in
                SettingsRow(identity.name ?? identity.userId, detail: ServerTime.date(identity.boundAt)?.formatted(date: .abbreviated, time: .omitted)) {
                    Button("解绑", role: .destructive) { pending = .unbind(identity) }
                        .buttonStyle(.plain)
                        .foregroundStyle(palette.danger)
                        .font(.riffet(size: S(12.5)))
                        .disabled(model.busy)
                }
            }
            SettingsActionButton("添加", symbol: "plus") { sheet = .bind(account) }
                .controlSize(.small)
                .disabled(model.busy)
        }

        if !chats.isEmpty {
            SettingsBlock("聊天") {
                ForEach(chats) { chat in chatRow(chat) }
            }
        }
    }

    private func chatRow(_ chat: ChannelChat) -> some View {
        SettingsRow(chat.name ?? chat.chatId) {
            HStack(spacing: Space.md) {
                if chat.isGroup {
                    Toggle("整群一个会话", isOn: Binding(
                        get: { chat.flat },
                        set: { value in Task { await model.perform { try await ChannelsAPI.updateChat(chat.key, ["flat": value]) } } }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }
                Picker("项目", selection: Binding(
                    get: { chat.projectId ?? "" },
                    set: { value in Task { await model.perform { try await ChannelsAPI.updateChat(chat.key, ["projectId": value.isEmpty ? NSNull() : value]) } } }
                )) {
                    Text(verbatim: "—").tag("")
                    ForEach(app.workbench?.projects ?? [], id: \.id) { project in Text(project.name).tag(project.id) }
                }
                .labelsHidden()
                .formPicker()
                .fixedSize()
                Menu {
                    Button("移除", role: .destructive) { pending = .removeChat(chat) }
                } label: {
                    Image(icon: "ellipsis")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
            .disabled(model.busy)
        }
    }

    /// The server's live self-check; hidden once everything passes.
    @ViewBuilder
    private func checklist(_ account: ChannelAccount) -> some View {
        if let health = model.healths[account.id] {
            let missing = health.missingScopes ?? []
            let lastEvent = health.lastEventAt ?? account.status.lastEventAt
            if !(health.connected && health.activated != false && missing.isEmpty && lastEvent != nil && health.needsLongConnection != true) {
                let connection = health.connected ? ChannelCheckRow<EmptyView>.Mark.ok
                    : account.status.state == "connecting" ? .busy : account.enabled ? .bad : .todo
                SettingsBlock("待完成") {
                    ChannelCheckRow(connection, String(localized: "连接飞书"), detail: connection == .bad ? account.status.error : nil)
                    if let activated = health.activated {
                        ChannelCheckRow(activated ? .ok : .bad, String(localized: "启用机器人"))
                    }
                    if health.missingScopes != nil {
                        ChannelCheckRow(mark: missing.isEmpty ? .ok : .bad, title: String(localized: "开通权限"), detail: missing.isEmpty ? nil : missing.joined(separator: " ")) {
                            if !missing.isEmpty, let link = health.grantUrl, let url = URL(string: link) {
                                Button("去申请") { NSWorkspace.shared.open(url) }
                            }
                        }
                    }
                    if health.needsLongConnection == true {
                        ChannelCheckRow(mark: .bad, title: String(localized: "把事件订阅改为长连接")) {
                            if let link = account.links.console, let url = URL(string: link) {
                                Button("打开开发者后台") { NSWorkspace.shared.open(url) }
                            }
                        }
                    }
                    ChannelCheckRow(lastEvent == nil ? .todo : .ok, String(localized: "收到第一条消息"), detail: lastEvent == nil ? String(localized: "在飞书私聊机器人发一条消息") : nil)
                    SettingsActionButton("重新检查", symbol: "arrow.clockwise") { Task { await model.refreshHealth(account.id) } }
                        .controlSize(.small)
                }
            }
        }
    }

    // MARK: Card

    @ViewBuilder
    private func card(_ account: ChannelAccount) -> some View {
        Section { backButton(account.name) { showCard = false } }
        Section {
            cardToggle("思考过程", detail: String(localized: "单独一条消息，展示思考与工具调用"), on: account.card.process, key: "process", account: account) { $0.process = $1 }
        }
        SettingsBlock("卡片") {
            cardToggle("标题栏", on: account.card.header, key: "header", account: account) { $0.header = $1 }
            cardToggle("中断按钮", on: account.card.stopButton, key: "stopButton", account: account) { $0.stopButton = $1 }
        }
        SettingsBlock("页脚", detail: "新设置从下一条回复开始生效") {
            footerToggle("模型", on: account.card.footer.model, key: "model", account: account) { $0.footer.model = $1 }
            footerToggle("改动行数", on: account.card.footer.changes, key: "changes", account: account) { $0.footer.changes = $1 }
            footerToggle("上下文占用", on: account.card.footer.context, key: "context", account: account) { $0.footer.context = $1 }
            footerToggle("用时", on: account.card.footer.elapsed, key: "elapsed", account: account) { $0.footer.elapsed = $1 }
        }
    }

    private func cardToggle(_ title: LocalizedStringResource, detail: String? = nil, on: Bool, key: String, account: ChannelAccount, apply: @escaping (inout ChannelCard, Bool) -> Void) -> some View {
        SettingsRow(String(localized: title), detail: detail) {
            Toggle(String(localized: title), isOn: Binding(
                get: { on },
                set: { value in Task { await model.setCard(account.id, [key: value]) { apply(&$0, value) } } }
            ))
            .labelsHidden()
            .disabled(model.busy)
        }
    }

    private func footerToggle(_ title: LocalizedStringResource, on: Bool, key: String, account: ChannelAccount, apply: @escaping (inout ChannelCard, Bool) -> Void) -> some View {
        SettingsRow(String(localized: title)) {
            Toggle(String(localized: title), isOn: Binding(
                get: { on },
                set: { value in Task { await model.setCard(account.id, ["footer": [key: value]]) { apply(&$0, value) } } }
            ))
            .labelsHidden()
            .disabled(model.busy)
        }
    }

    private func backButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, icon: "chevron.left")
        }
        .buttonStyle(.plain)
        .foregroundStyle(palette.fg2)
    }
}
