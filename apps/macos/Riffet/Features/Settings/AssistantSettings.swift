import SwiftUI
import RiffetKit

/// 个人助理 (docs/ASSISTANT.md §7.6): what it does in the background, which costs the owner tokens
/// while they are away, and how it starts tasks. Saved at once, on the server, for every device.
struct AssistantSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var usage: AssistantRunUsage?
    @State private var delegations: [AssistantDelegation]?
    @State private var showsDelegations = false
    @State private var packs: [AssistantPack] = []
    @State private var removing: AssistantPack?
    @State private var save = SettingsSaveState()
    @State private var refreshedAt = Date.distantPast

    private static let dailyChoices = [10, 30, 100]

    var body: some View {
        if let workbench = model.workbench {
            form(workbench)
        } else {
            NeedsServerView()
        }
    }

    private func form(_ workbench: Workbench) -> some View {
        let assistant = workbench.settings?.assistant
        let dailyRuns = assistant?.dailyRuns?.intValue ?? Self.dailyDefault
        let dispatch = assistant?.dispatch == "all" ? "all" : "edits"
        return Form {
            Section {
                modelRow(workbench)
            }

            if !packs.isEmpty {
                packsSection(workbench)
            }

            SettingsBlock("后台运行", detail: "用个人助理的模型，按用量计费") {
                SettingsRow(
                    String(localized: "跟进任务"),
                    detail: spent("supervise") ?? String(localized: "任务的会话停下、你不在时，核对交付或推动它")
                ) {
                    Toggle("跟进任务", isOn: Binding(
                        get: { assistant?.supervision?.boolValue == true },
                        set: { on in persist(workbench) { try await $0.setAssistantSupervision(on: on) } }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .disabled(save.busy)
                }

                SettingsRow(
                    String(localized: "记忆整理"),
                    detail: spent("consolidate") ?? String(localized: "每晚，以及主对话压缩前")
                ) {
                    Toggle("记忆整理", isOn: Binding(
                        get: { assistant?.consolidation?.boolValue != false },
                        set: { on in persist(workbench) { try await $0.setAssistantConsolidation(on: on) } }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .disabled(save.busy)
                }

                Button { showsDelegations = true } label: {
                    HStack(spacing: Space.sm) {
                        Text("委托").foregroundStyle(palette.fg)
                        Spacer(minLength: Space.sm)
                        if let note = delegationNote {
                            Text(note).font(RiffetFont.text(RiffetTextSize.x2xs)).foregroundStyle(palette.fg3)
                        }
                        Image(icon: "chevron.right").font(RiffetFont.text(RiffetTextSize.x2xs, weight: .medium)).foregroundStyle(palette.fg4)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                SettingsRow(String(localized: "24 小时内最多"), detail: budgetNote) {
                    Picker("24 小时内最多", selection: Binding(
                        get: { dailyRuns },
                        set: { count in persist(workbench) { try await $0.setAssistantDailyRuns(count: Int32(count)) } }
                    )) {
                        ForEach(Self.dailyChoices.contains(dailyRuns) ? Self.dailyChoices : (Self.dailyChoices + [dailyRuns]).sorted(), id: \.self) { count in
                            Text("\(count) 次").tag(count)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize()
                    .disabled(save.busy)
                }

                SettingsFeedback(state: save)
            }

            SettingsBlock("任务") {
                SettingsRow(String(localized: "开始任务前")) {
                    FormSegmented("开始任务前", selection: Binding(
                        get: { dispatch },
                        set: { value in persist(workbench) { try await $0.setAssistantDispatch(value: value) } }
                    )) {
                        Text("改代码的先问我").tag("edits")
                        Text("都先问我").tag("all")
                    }
                    .labelsHidden()
                    .fixedSize()
                    .disabled(save.busy)
                }
            }

            SettingsScopeFooter()
        }
        .riffetForm()
        .task { await refresh(workbench) }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSectionDidShow)) { note in
            guard note.object as? String == SettingsSection.assistant.rawValue,
                  Date.now.timeIntervalSince(refreshedAt) > 30 else { return }
            Task { await refresh(workbench) }
        }
        .confirmationDialog(
            removing.map { String(localized: "去掉「\($0.title)」？") } ?? "",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible,
            presenting: removing
        ) { pack in
            Button("去掉", role: .destructive) { setPack(workbench, pack, on: false) }
            Button("取消", role: .cancel) {}
        } message: { _ in
            Text("它的文件夹会删除，可以从个人助理目录的提交历史找回")
        }
        .sheet(isPresented: $showsDelegations, onDismiss: { Task { await loadDelegations(workbench) } }) {
            AssistantDelegationsSheet(workbench: workbench)
        }
    }

    private static let dailyDefault = 30

    // MARK: Model

    /// The assistant's own agent and provider, as `assistantChoice` in `packages/contracts` resolves them.
    private func choice(_ workbench: Workbench) -> (backend: String, profileId: String?, model: String?)? {
        let saved = workbench.settings?.assistant
        let savedBackend = saved?.backendId.map(backendWire)
        guard let entry = workbench.backends.assistantEntry(saved: savedBackend) else { return nil }
        // A saved provider and model belong to the saved agent only.
        let kept = entry.agent == savedBackend && (saved?.profileId.map { id in id.isEmpty || entry.profiles.contains { $0.id == id } } ?? true)
        let profile = kept ? saved?.profileId.flatMap { $0.isEmpty ? nil : $0 } : nil
        let model = kept ? saved?.model.flatMap { $0.isEmpty ? nil : $0 } : nil
        return (entry.agent, profile, model)
    }

    private func modelRow(_ workbench: Workbench) -> some View {
        let own = choice(workbench)
        return AgentModelRow(
            workbench: workbench,
            title: String(localized: "模型"),
            agent: own?.backend,
            profileId: own?.profileId,
            model: own?.model,
            disabled: save.busy
        ) { entry, profile, value in
            persist(workbench) { try await $0.rememberAssistant(backendId: entry.backendId, profileId: profile, model: value) }
        }
    }

    // MARK: Usage

    private func spent(_ job: String) -> String? {
        guard let usage, let row = usage.jobs.first(where: { $0.job == job }), row.runs > 0 else { return nil }
        return String(localized: "近 \(Int(usage.days)) 天 \(Int(row.runs)) 次 · \(formatTokens(Double(row.tokens))) tokens")
    }

    private var delegationNote: String? {
        if let note = spent("delegation") { return note }
        guard let delegations else { return nil }
        return String(localized: "\(delegations.filter { $0.state == "active" }.count) 项进行中")
    }

    private var budgetNote: String? {
        guard let usage else { return nil }
        return usage.waiting > 0
            ? String(localized: "已开始 \(Int(usage.started)) 次，\(Int(usage.waiting)) 次在等")
            : String(localized: "已开始 \(Int(usage.started)) 次")
    }

    // MARK: Loading and saving

    private func refresh(_ workbench: Workbench) async {
        refreshedAt = .now
        guard let api = workbench.host.api else { return }
        async let latest = try? api.settings()
        async let used = try? api.assistantRunUsage()
        async let listed: Void = loadDelegations(workbench)
        if let list = try? await api.assistantPacks() { packs = list }
        if let used = await used { usage = used }
        await listed
        if let settings = await latest { workbench.store.applySavedSettings(settings: settings) }
    }

    private func packsSection(_ workbench: Workbench) -> some View {
        Section {
            ForEach(packs, id: \.id) { pack in
                packRow(workbench, pack)
            }
        } header: {
            SettingsSectionHeader(title: String(localized: "能力包"))
        } footer: {
            Text("个人助理空闲时生效；去掉后记忆保留")
                .font(RiffetFont.text(RiffetTextSize.x2xs))
                .foregroundStyle(palette.fg3)
        }
    }

    private func packRow(_ workbench: Workbench, _ pack: AssistantPack) -> some View {
        let detail: String? = pack.description_?.isEmpty == false ? pack.description_ : nil
        let binding = Binding<Bool>(
            get: { pack.installed },
            set: { on in
                if on || pack.builtIn { setPack(workbench, pack, on: on) } else { removing = pack }
            }
        )
        return SettingsRow(pack.title, detail: detail) {
            if pack.providedBy != nil {
                Text("随插件启停")
                    .font(RiffetFont.text(RiffetTextSize.x2xs))
                    .foregroundStyle(palette.fg3)
            } else {
                Toggle(pack.title, isOn: binding)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .disabled(save.busy)
            }
        }
    }

    private func setPack(_ workbench: Workbench, _ pack: AssistantPack, on: Bool) {
        guard let api = workbench.host.api else { return }
        Task {
            await save.run { packs = try await on ? api.addAssistantPack(id: pack.id) : api.removeAssistantPack(id: pack.id) }
        }
    }

    private func loadDelegations(_ workbench: Workbench) async {
        if let api = workbench.host.api, let list = try? await api.assistantDelegations() { delegations = list }
    }

    private func persist(_ workbench: Workbench, _ change: @escaping (RiffetApi) async throws -> AppSettings) {
        guard let api = workbench.host.api else { return }
        Task {
            await save.run {
                workbench.store.applySavedSettings(settings: try await change(api))
            }
            if let used = try? await api.assistantRunUsage() { usage = used }
        }
    }
}

/// What the assistant follows over time. New ones and changes go through the assistant itself, so
/// the only action here is ending one.
private struct AssistantDelegationsSheet: View {
    let workbench: Workbench
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var items: [AssistantDelegation]?
    @State private var ending: AssistantDelegation?
    @State private var busy: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text("委托").font(.title3.weight(.semibold))
            Group {
                if let items {
                    if items.isEmpty {
                        Text("还没有委托").foregroundStyle(palette.fg3).frame(maxWidth: .infinity, minHeight: 120)
                    } else {
                        ScrollView {
                            VStack(spacing: 0) {
                                ForEach(items, id: \.id) { row($0) }
                            }
                        }
                    }
                } else {
                    HStack { Spacer(); Spinner(size: .small); Spacer() }.frame(minHeight: 120)
                }
            }
            if let error { SettingsErrorText(message: error) }
            HStack {
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(Space.lg)
        .frame(width: 460)
        .frame(maxHeight: 520)
        .task { items = try? await workbench.host.api?.assistantDelegations() ?? [] }
        .confirmationDialog("结束这项委托？", isPresented: Binding(get: { ending != nil }, set: { if !$0 { ending = nil } }), titleVisibility: .visible, presenting: ending) { item in
            Button("结束", role: .destructive) { Task { await end(item) } }
            Button("取消", role: .cancel) {}
        } message: { item in
            Text(item.goal)
        }
    }

    private func row(_ item: AssistantDelegation) -> some View {
        let active = item.state == "active"
        return HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.goal).foregroundStyle(active ? palette.fg : palette.fg3)
                Text(Self.trigger(item.trigger)).font(RiffetFont.text(RiffetTextSize.x2xs)).foregroundStyle(palette.fg3)
            }
            Spacer(minLength: Space.sm)
            Text(active ? untilNote(item.until) : String(localized: "已结束"))
                .font(RiffetFont.text(RiffetTextSize.x2xs)).foregroundStyle(palette.fg3)
            if active {
                Button("结束") { ending = item }
                    .controlSize(.small)
                    .disabled(busy == item.id)
            }
        }
        .padding(.vertical, Space.sm)
    }

    private func end(_ item: AssistantDelegation) async {
        guard let api = workbench.host.api else { return }
        busy = item.id
        error = nil
        do {
            let ended = try await api.endAssistantDelegation(id: item.id)
            items = items?.map { $0.id == ended.id ? ended : $0 }
        } catch {
            self.error = error.riffetMessage
        }
        busy = nil
    }

    private func untilNote(_ value: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "" }
        return String(localized: "到 \(date.formatted(date: .abbreviated, time: .omitted))")
    }

    private static func trigger(_ trigger: AssistantDelegationTrigger) -> String {
        if trigger.kind == "task-status", let number = trigger.taskNumber?.intValue {
            let status = switch trigger.status {
            case "todo": String(localized: "待办")
            case "doing": String(localized: "进行中")
            case "review": String(localized: "待验收")
            case "done": String(localized: "已完成")
            case "cancelled": String(localized: "已取消")
            default: ""
            }
            return status.isEmpty ? "#\(number)" : "#\(number) · \(status)"
        }
        return switch trigger.kind {
        case "schedule": String(localized: "定时 \(trigger.cron ?? "")")
        case "github-release": String(localized: "\(trigger.repo ?? "") 发版")
        case "plugin-event": trigger.topic ?? ""
        default: String(localized: "\(trigger.url ?? "") 有变化")
        }
    }
}
