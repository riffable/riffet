import SwiftUI
import RiffetKit

// The composer's model chip opens a picker panel (ios.md §4.3): a sheet from the bottom whose top bar
// holds the agents (on a new task) and the providers, whose list holds one provider's models, and whose
// bottom bar holds the model's parameters and the way on to 更多设置 (mode, permissions, skills and
// tools), pushed inside the panel. Picking a model closes it; parameters change in place.

/// One provider's models in the panel; `id` is the profile ("" where the agent has none).
struct ModelPanelGroup: Identifiable {
    let id: String
    /// The provider's name, shown as its chip when there are several.
    var title: String?
    let models: [ModelInfo]
    let isCurrent: Bool
    var usage: NativeBackendUsage?
    var unavailable: String?
    var failure: String?
}

/// The panel's content; the two owners below read the data and apply the picks.
private struct ModelPanel: View {
    var agents: [RiffetChipBar<String>.Item]? = nil
    var agent: Binding<String>? = nil
    let groups: [ModelPanelGroup]
    let selection: String?
    var loading = false
    var error: String?
    var retry: (() -> Void)?
    var note: String?
    var caption: String?
    var enabled = true
    let pick: (ModelPanelGroup, ModelInfo) -> Void
    var parameters: [ModelInfo]?
    var choose: (String) -> Void = { _ in }
    let more: () -> AnyView
    /// The provider whose models the list shows; nil follows the current one.
    @State private var browsing: String?
    /// The list already brought the current model into view for this agent and provider.
    @State private var landed: String?
    @State private var scrolled = false
    @Environment(\.palette) private var palette
    @Environment(\.displayScale) private var scale

    private var shownID: String? {
        if let browsing, groups.contains(where: { $0.id == browsing }) { return browsing }
        return groups.first(where: \.isCurrent)?.id ?? groups.first?.id
    }
    private var shown: ModelPanelGroup? { groups.first { $0.id == shownID } }
    /// The models are still on their way: placeholder rows hold the list's place.
    private var placeholder: Bool { error == nil && note == nil && (shown.map { loading && $0.models.isEmpty && $0.failure == nil } ?? true) }
    private var currentModel: String? {
        guard let group = groups.first(where: \.isCurrent) else { return nil }
        return resolveModelSelection(catalog: group.models, selection: selection).model
    }
    /// Where the current model would be shown: the shown provider, and whether it lists the model yet.
    private var landingKey: String {
        let listed = shown.map { group in group.isCurrent && !placeholder && group.models.contains { $0.value == currentModel } } ?? false
        return "\(agent?.wrappedValue ?? "")|\(shownID ?? "")|\(listed)"
    }
    /// Brings the current model to the middle of the list, once per agent and provider unless `again`,
    /// and never after the person has scrolled.
    private func land(_ proxy: ScrollViewProxy, again: Bool = false) {
        guard again || landed != landingKey, !scrolled, landingKey.hasSuffix("|true"), let currentModel else { return }
        landed = landingKey
        proxy.scrollTo(currentModel, anchor: .center)
    }

    var body: some View {
        // The bars sit above and below the list, not over it: the list scrolls in the space between
        // them, so nothing passes under the chips on the sheet's glass.
        VStack(spacing: 0) {
            topBar
            // Only the list in the reader: the chip bars scroll themselves.
            ScrollViewReader { proxy in
                RiffetList(rowHeight: RiffetMetrics.hitTarget, inSheet: true) { content }
                    // A chip tap changes the selection in an animated transaction (its highlight slides); the
                    // list must not take that animation and fade or resize, it swaps in place.
                    .transaction { $0.animation = nil }
                    // The current model is in view once the panel has grown into place, and when the models arrive later.
                    .onSettledSize { land(proxy, again: true) }
                    .onChange(of: landingKey) { _, _ in land(proxy) }
                    .onScrollPhaseChange { _, phase in if phase == .interacting { scrolled = true } }
            }
            bottomBar.transaction { $0.animation = nil }
        }
        // A title like the page it pushes, so the bar stays put when 更多设置 opens.
        .navigationTitle(agentRow == nil ? String(localized: "模型", bundle: .riffet) : String(localized: "Agent 与模型", bundle: .riffet))
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: agent?.wrappedValue) { _, _ in browsing = nil; landed = nil; scrolled = false }
        // No layout animation: switching agent changes the list several times in a row (placeholder,
        // models, quota), and springing each change shook the panel. The placeholder rows keep the
        // layout still instead.
    }

    @ViewBuilder private var content: some View {
        if let error {
            RiffetNotice.section(.error, error, actionTitle: retry == nil ? nil : String(localized: "重新读取", bundle: .riffet), action: retry)
        } else if let note {
            Section { Text(verbatim: note).foregroundStyle(palette.fg2) }
        } else if let group = shown, !placeholder {
            Section {
                if let account = group.usage?.account { ModelAccountUsageSummary(account: account) }
                if let failure = group.failure {
                    RiffetNotice(kind: .error, message: failure, actionTitle: retry == nil ? nil : String(localized: "重试", bundle: .riffet), action: retry)
                } else if let unavailable = group.unavailable {
                    RiffetNotice(kind: .warning, message: unavailable)
                }
                let current = group.isCurrent ? currentModel : nil
                ForEach(group.models, id: \.value) { model in
                    Button { pick(group, model) } label: {
                        ConfigurationChoiceRow(title: cleanLabel(value: model.name), detail: nil, selected: model.value == current,
                                               trailing: modelUsageLabel(group.usage?.models[model.value]), compact: true)
                    }
                    .foregroundStyle(palette.fg).disabled(!enabled || group.unavailable != nil)
                    .id(model.value).accessibilityIdentifier("modelChoice.\(group.id).\(model.value)")
                }
                if group.models.isEmpty && group.failure == nil { Text("没有可用的模型").foregroundStyle(palette.fg2) }
            } footer: { if let caption { Text(verbatim: caption) } }
        } else {
            Section {
                ForEach(0..<RiffetPanelMetrics.placeholderRows, id: \.self) { _ in
                    ConfigurationChoiceRow(title: "model-name-placeholder", detail: nil, selected: false, compact: true)
                }
            }
            .redacted(reason: .placeholder).accessibilityHidden(true)
        }
    }

    /// The agents, then the providers: what the list below belongs to.
    /// The agents to choose between: a new task with more than one.
    private var agentRow: [RiffetChipBar<String>.Item]? { agents.flatMap { $0.count > 1 ? $0 : nil } }

    @ViewBuilder private var topBar: some View {
        let providers = groups.count > 1 && note == nil && error == nil
        if agentRow != nil || providers {
            RiffetPanelBar(edge: .top) {
                if let agentRow, let agent { RiffetChipBar(items: agentRow, selection: agent) }
                if providers {
                    RiffetChipBar(items: groups.map { .init(value: $0.id, title: $0.title ?? $0.id) },
                                  selection: Binding(get: { shownID ?? "" }, set: { browsing = $0 }))
                        .accessibilityLabel(String(localized: "服务商配置", bundle: .riffet))
                } else if agentRow != nil {
                    // An agent with one provider keeps the row's height, so switching agents does not move the list.
                    Color.clear.frame(height: RiffetMetrics.hitTarget)
                }
            }
        } else {
            Color.clear.frame(height: RiffetPanelMetrics.gap)
        }
    }

    /// The model's parameters, scrolling in the width they get, then the way on to the settings the panel
    /// leaves out: a fixed button after a hairline, so the chips never crowd it.
    private var bottomBar: some View {
        RiffetPanelBar(edge: .bottom) {
            HStack(spacing: 0) {
                if let parameters, !parameters.isEmpty, note == nil {
                    ModelParameterChips(catalog: parameters, selection: selection, choose: choose).disabled(!enabled)
                }
                Spacer(minLength: 0)
                Rectangle().fill(palette.line).frame(width: 1 / scale, height: RiffetMetrics.chipHeight)
                NavigationLink { more() } label: {
                    Image(systemName: "slider.horizontal.3").riffetFont(.body).foregroundStyle(palette.fg2)
                        .frame(width: RiffetMetrics.hitTarget + RiffetMetrics.floatingGap, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
                }
                .buttonStyle(RiffetDimPressStyle())
                .accessibilityLabel(String(localized: "更多设置", bundle: .riffet))
                .accessibilityIdentifier("modelPanelMore")
                .padding(.trailing, RiffetMetrics.floatingGap)
            }
        }
    }
}

// MARK: - New task

/// The new task's model chip: agent, provider, model and parameters, saved into the draft and remembered
/// as the agent's default like the options sheet does.
struct NewTaskModelPanel: View {
    let workbench: Workbench
    @Bindable var draft: MessageDraft
    let catalog: NativeBackendCatalogEntry?
    let backend: NativeBackendId
    var loading = false
    var error: String?
    var retry: (() -> Void)?
    var assistant = false
    let more: () -> AnyView
    let close: () -> Void
    @State private var reader = ProfileCatalogs()

    private var agents: [NativeBackendCatalogEntry] {
        assistant ? workbench.backends.filter { AssistantKt.isStandingMemberBackend(entry: $0) } : workbench.backends
    }
    /// The agent as the app's agent list has it: its providers are known the moment it is picked, before
    /// its own catalog arrives, so the provider row does not appear a moment later.
    private var agentEntry: NativeBackendCatalogEntry? { workbench.backends.first { $0.backendId == backend } }
    private var profiles: [NativeBackendProfile] { (catalog ?? agentEntry)?.profiles ?? [] }
    private var keys: [String] { profiles.isEmpty ? [""] : profiles.map(\.id) }
    /// The provider and model the composer's chip shows: the draft's, else the ones remembered for this
    /// agent, else the catalog's defaults (`NewSessionDraft.resolve`). A kept list carries only the
    /// catalog's default, so going by it would tick another model until the fresh read arrived.
    private func choice(_ entry: NativeBackendCatalogEntry) -> NewSessionChoice {
        NativeConfigurationSummary.choice(catalog: entry, draft: draft, settings: workbench.settings)
    }
    private var effectiveProfile: String {
        draft.profileID ?? (catalog ?? agentEntry).flatMap { choice($0).profileId } ?? profiles.first { $0.isDefault?.boolValue == true }?.id ?? keys[0]
    }
    private var selectedCatalog: NativeBackendCatalogEntry? {
        (fresh ? reader.catalogs[effectiveProfile] : nil) ?? (draft.profileID == nil ? catalog : nil) ?? reader.kept(backend, draft.projectID, effectiveProfile)
    }
    /// The reader holds this agent's and project's catalogs, not the last ones: until it does, the list
    /// keeps its placeholders rather than saying there are no models.
    private var fresh: Bool { scope != nil && reader.scope == scope }
    private var selection: String? { draft.model ?? selectedCatalog.flatMap { entry in let model = choice(entry).model; return model.isEmpty ? nil : model } }
    private var scope: ModelUsageScope? {
        draft.projectID.map { ModelUsageScope(server: ObjectIdentifier(workbench), backend: backend.name, project: $0, profiles: keys, retry: reader.retries) }
    }

    var body: some View {
        ModelPanel(agents: agents.map { .init(value: $0.backendId.name, title: $0.label, mark: $0.backendId.name, enabled: $0.available) },
                   agent: Binding(get: { backend.name }, set: pickAgent),
                   groups: groups, selection: selection, loading: loading || reader.loading || !fresh,
                   error: error ?? agentsError, retry: retryRead,
                   note: note, enabled: (catalog ?? agentEntry)?.available == true,
                   pick: { group, model in
                       // The list it was picked from: this agent's fresh read or its kept list, never the last agent's read.
                       guard let picked = (fresh ? reader.catalogs[group.id] : nil) ?? (group.id == effectiveProfile ? catalog : nil) ?? reader.kept(backend, draft.projectID, group.id) else { return }
                       let remembered = workbench.settings?.nativeBackendDefaults?[backend]?.profileModels?[group.id]
                       apply(picked, profile: group.id, value: pickedSelection(catalog: picked.models, model: model.value, currentSelection: selection, remembered: remembered))
                       close()
                   },
                   parameters: note == nil ? selectedCatalog?.models : nil,
                   choose: { value in if let selectedCatalog { apply(selectedCatalog, profile: effectiveProfile, value: value) } },
                   more: more)
            .accessibilityElement(children: .contain).accessibilityIdentifier("newTaskModelPanel")
            // Re-read once the agent's catalog arrives: until then there is nothing to choose from.
            .task(id: ReadKey(scope: scope, ready: catalog?.backendId == backend && catalog?.capabilities.supportsModelSelection == true)) {
                guard let scope, catalog?.backendId == backend, catalog?.capabilities.supportsModelSelection == true else { return }
                await reader.load(workbench: workbench, backend: backend, projectID: scope.project, keys: keys, first: effectiveProfile, scope: scope)
            }
    }

    private struct ReadKey: Hashable { let scope: ModelUsageScope?; let ready: Bool }

    /// The agent list failed and nothing else says what this agent is; once either is known, the panel works.
    private var agentsError: String? { (catalog ?? agentEntry) == nil ? workbench.backendError : nil }
    private func retryRead() {
        if error != nil { retry?() }
        else if agentsError != nil { Task { await workbench.loadBackends() } }
        else { reader.retries += 1 }
    }

    private var note: String? {
        if draft.projectID == nil { return String(localized: "请先选择项目，再读取该项目可用的模型。", bundle: .riffet) }
        guard let catalog, !loading else { return nil }
        if !catalog.available { return catalog.reason ?? String(localized: "此 Agent 当前不可用", bundle: .riffet) }
        if !catalog.capabilities.supportsModelSelection { return String(localized: "此 Agent 使用它自己的默认模型。改变模型需要在 Mac 上的 Agent 中操作。", bundle: .riffet) }
        return nil
    }

    private var groups: [ModelPanelGroup] {
        // A just-picked agent shows the models this device kept for it, or placeholders, never the last
        // agent's models, until its catalog arrives.
        guard note == nil, (catalog ?? agentEntry)?.backendId == backend else { return [] }
        return keys.map { key in
            let entry = (fresh ? reader.catalogs[key] : nil) ?? reader.kept(backend, draft.projectID, key)
            return ModelPanelGroup(id: key, title: profiles.first { $0.id == key }?.name, models: entry?.models ?? [],
                                   isCurrent: key == effectiveProfile, usage: (fresh ? reader.usage(key) : nil) ?? reader.keptUsage(backend, draft.projectID, key),
                                   unavailable: entry.flatMap { $0.available ? nil : $0.reason ?? String(localized: "不可用", bundle: .riffet) },
                                   failure: fresh ? reader.failures[key] : nil)
        }
    }

    private func pickAgent(_ name: String) {
        guard name != backend.name, agents.contains(where: { $0.backendId.name == name && $0.available }) else { return }
        draft.backendName = name
        draft.profileID = nil; draft.model = nil; draft.mode = nil; draft.approval = nil
    }

    private func apply(_ entry: NativeBackendCatalogEntry, profile: String, value: String) {
        guard let projectID = draft.projectID else { return }
        NativeConfigurationSummary.pickNewTaskModel(workbench: workbench, draft: draft, backend: backend, catalog: entry, projectID: projectID,
                                                    profileID: profile.isEmpty ? nil : profile, value: value, remember: !assistant)
    }
}

// MARK: - Conversation

/// A conversation's model chip: its provider and the ones it can continue on, the model and its
/// parameters. A pick is sent at once; a failure is reported as a toast, since the panel has closed.
struct SessionModelPanel: View {
    let workbench: Workbench
    let session: Session
    /// What the page has already read, shown until this panel's own read answers.
    var catalog: NativeBackendCatalogEntry?
    let more: () -> AnyView
    let close: () -> Void
    @State private var loaded: NativeBackendCatalogEntry?
    @State private var error: String?
    @State private var loading = true
    @State private var pending = false
    /// The quota last read for this provider, so its line is there from the first frame instead of arriving late.
    @State private var usage: NativeBackendUsage?

    init(workbench: Workbench, session: Session, catalog: NativeBackendCatalogEntry? = nil, more: @escaping () -> AnyView, close: @escaping () -> Void) {
        self.workbench = workbench; self.session = session; self.catalog = catalog; self.more = more; self.close = close
        _usage = State(initialValue: ModelUsageStore(preferences: createAppPreferences()).load(scope: Self.usageKey(session)))
    }

    /// Shared with the new-conversation panel: the same provider in the same project.
    private static func usageKey(_ session: Session) -> String {
        "\((session.backendId ?? .cursor).name)|\(session.projectId)|\(session.backendProfileId ?? "")"
    }

    private var current: Session { workbench.selected?.id == session.id ? workbench.selected ?? session : workbench.listedSession(session.id) ?? session }
    private var shown: NativeBackendCatalogEntry? { loaded ?? catalog }
    private var selection: String? { current.model ?? shown?.defaultModel }
    private var archived: Bool { current.archivedAt != nil }

    var body: some View {
        ModelPanel(groups: groups, selection: selection, loading: loading, error: shown == nil ? error : nil, retry: { Task { await load() } },
                   note: note, caption: current.state.isActive && note == nil ? String(localized: "修改将在 Agent 下次空闲时应用。", bundle: .riffet) : nil,
                   enabled: !pending && !archived,
                   pick: { group, model in
                       let value = pickedSelection(catalog: group.models, model: model.value, currentSelection: group.isCurrent ? selection : nil, remembered: nil)
                       let id = session.id
                       if group.isCurrent { send { api in try await api.nativeSetModel(id: id, model: value) } }
                       else { send { api in try await api.nativeSwitchProfile(id: id, backendProfileId: group.id, model: value) } }
                       close()
                   },
                   parameters: note == nil ? shown?.models : nil,
                   choose: { value in let id = session.id; send { api in try await api.nativeSetModel(id: id, model: value) } },
                   more: more)
            .accessibilityElement(children: .contain).accessibilityIdentifier("sessionModelPanel")
            .task { await load() }
            .task(id: current.backendProfileId) { await loadUsage() }
    }

    private var note: String? {
        guard let shown else { return nil }
        return shown.capabilities.supportsModelSelection ? nil : String(localized: "此 Agent 不支持在客户端切换模型。", bundle: .riffet)
    }

    /// The current provider plus the ones the conversation can continue on, in catalog order.
    private var groups: [ModelPanelGroup] {
        guard let shown, note == nil else { return [] }
        let currentID = current.backendProfileId ?? shown.profiles.first { $0.isDefault?.boolValue == true }?.id ?? ""
        func name(_ id: String, _ fallback: String) -> String { shown.profiles.first { $0.id == id }?.name ?? fallback }
        var all = [ModelPanelGroup(id: currentID, title: name(currentID, currentID), models: shown.models, isCurrent: true, usage: usage)]
        for item in shown.continuations where item.profile.id != currentID {
            all.append(ModelPanelGroup(id: item.profile.id, title: name(item.profile.id, item.profile.name), models: item.models, isCurrent: false))
        }
        let order = shown.profiles.map(\.id)
        return all.enumerated().sorted { a, b in
            let l = order.firstIndex(of: a.element.id) ?? Int.max, r = order.firstIndex(of: b.element.id) ?? Int.max
            return l == r ? a.offset < b.offset : l < r
        }.map(\.element)
    }

    @MainActor private func load() async {
        loading = true; error = nil
        defer { if !Task.isCancelled { loading = false } }
        do {
            guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
            let value = try await api.sessionCatalog(id: session.id)
            try Task.checkCancellation()
            loaded = value
        } catch is CancellationError { return }
        catch { self.error = error.riffetMessage }
    }

    @MainActor private func loadUsage() async {
        guard let api = workbench.api else { return }
        do {
            let value = try await api.backendUsage(backendId: current.backendId ?? .cursor, projectId: nil, profileId: nil, sessionId: current.id, global: false)
            try Task.checkCancellation()
            usage = value
            ModelUsageStore(preferences: createAppPreferences()).save(scope: Self.usageKey(current), usage: value)
        } catch { /* Unknown quota does not prevent choosing a model. */ }
    }

    /// One change at a time; the store takes the answer, the toast the refusal.
    private func send(_ action: @escaping (RiffetApi) async throws -> Session) {
        guard !pending, !archived else { return }
        pending = true
        let id = session.id
        Task { @MainActor in
            defer { pending = false }
            do {
                guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
                let updated = try await action(api)
                guard updated.id == id else { throw ClientFailure(String(localized: "服务器返回了其他会话，配置未确认", bundle: .riffet)) }
                workbench.store.applySession(session: updated)
            } catch { RiffetToastCenter.shared.error(error.riffetMessage) }
        }
    }
}

// MARK: - Catalogs per provider

/// Each provider's catalog and quota for one agent and project, read one provider after another with
/// the selected one first. The last quota read shows at once and is replaced by the fresh one.
@MainActor @Observable final class ProfileCatalogs {
    var catalogs: [String: NativeBackendCatalogEntry] = [:]
    var failures: [String: String] = [:]
    var loading = true
    /// Bumped by a retry, so the reading task restarts.
    var retries = 0
    /// What the catalogs and failures were read for.
    private(set) var scope: ModelUsageScope?
    private var usages: (scope: ModelUsageScope, values: [String: NativeBackendUsage])?
    /// The model lists this device kept (`ModelCatalogStore`), decoded once per panel: a switched-to agent
    /// or provider paints from them at once while its fresh read runs.
    @ObservationIgnored private var keptLists: [String: NativeBackendCatalogEntry]?
    @ObservationIgnored private let catalogStore = ModelCatalogStore(preferences: createAppPreferences())

    func usage(_ key: String) -> NativeBackendUsage? { usages?.values[key] }
    /// The quota this device last read for a provider, looked up once: shown with a kept list in the
    /// same frame, before the reading task has seeded this scope's figures.
    @ObservationIgnored private var keptUsages: [String: NativeBackendUsage?] = [:]
    func keptUsage(_ backend: NativeBackendId, _ projectID: String?, _ key: String) -> NativeBackendUsage? {
        guard let projectID else { return nil }
        let storeKey = Self.storeKey(backend, projectID, key)
        if let known = keptUsages[storeKey] { return known }
        let value = ModelUsageStore(preferences: createAppPreferences()).load(scope: storeKey)
        keptUsages[storeKey] = value
        return value
    }

    static func storeKey(_ backend: NativeBackendId, _ projectID: String, _ key: String) -> String { "\(backend.name)|\(projectID)|\(key)" }
    func kept(_ backend: NativeBackendId, _ projectID: String?, _ key: String) -> NativeBackendCatalogEntry? {
        guard let projectID else { return nil }
        if keptLists == nil { keptLists = catalogStore.loadAll() }
        return keptLists?[Self.storeKey(backend, projectID, key)]
    }

    func load(workbench: Workbench, backend: NativeBackendId, projectID: String, keys: [String], first: String, scope: ModelUsageScope) async {
        loading = true; failures = [:]; catalogs = [:]
        self.scope = scope
        defer { if !Task.isCancelled { loading = false } }
        // The last quota read shows with the first models, not a moment after them.
        seedUsage(backend: backend, projectID: projectID, keys: keys, scope: scope)
        guard let api = workbench.api else { for key in keys { failures[key] = String(localized: "未连接服务器", bundle: .riffet) }; return }
        let ordered = keys.contains(first) ? [first] + keys.filter { $0 != first } : keys
        for key in ordered {
            do {
                let entry = try await api.backendCatalog(backendId: backend, profileId: key.isEmpty ? nil : key, projectId: projectID, allModels: false, global: false)
                try Task.checkCancellation()
                catalogs[key] = entry
                catalogStore.save(scope: Self.storeKey(backend, projectID, key), catalog: entry)
                if entry.available, !entry.models.isEmpty { keptLists?[Self.storeKey(backend, projectID, key)] = entry }
            } catch is CancellationError { return }
            catch {
                if Task.isCancelled { return }
                failures[key] = error.riffetMessage
            }
        }
        await loadUsage(workbench: workbench, backend: backend, projectID: projectID, keys: ordered, scope: scope)
    }

    private func seedUsage(backend: NativeBackendId, projectID: String, keys: [String], scope: ModelUsageScope) {
        guard usages?.scope != scope else { return }
        let store = ModelUsageStore(preferences: createAppPreferences())
        usages = (scope, Dictionary(uniqueKeysWithValues: keys.compactMap { key in store.load(scope: "\(backend.name)|\(projectID)|\(key)").map { (key, $0) } }))
    }

    private func loadUsage(workbench: Workbench, backend: NativeBackendId, projectID: String, keys: [String], scope: ModelUsageScope) async {
        let store = ModelUsageStore(preferences: createAppPreferences())
        func storeKey(_ key: String) -> String { "\(backend.name)|\(projectID)|\(key)" }
        seedUsage(backend: backend, projectID: projectID, keys: keys, scope: scope)
        guard let api = workbench.api else { return }
        for key in keys {
            do {
                let value = try await api.backendUsage(backendId: backend, projectId: projectID, profileId: key.isEmpty ? nil : key, sessionId: nil, global: false)
                try Task.checkCancellation()
                guard usages?.scope == scope else { return }
                usages?.values[key] = value
                store.save(scope: storeKey(key), usage: value)
                keptUsages[storeKey(key)] = value
            } catch is CancellationError { return }
            catch { if Task.isCancelled { return } }
        }
    }
}
