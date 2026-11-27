import SwiftUI
import RiffetKit

/// One editor and draft for task and quick-chat tabs. Target-specific choices stay independent.
struct HomeView: View {
    @Bindable var workbench: Workbench
    @Environment(\.palette) private var palette
    @Environment(AppModel.self) private var app
    private var composer: ComposerModel { workbench.pageModels.composers.model(for: workbench.homeDraftKey) }
    /// The wire id of the Agent a new task starts on; empty until the defaults are applied.
    @State private var taskBackend = ""
    @State private var taskProfileId: String?
    @State private var taskModel: String?
    @State private var chatModel: String?
    @State private var approval: String?
    @State private var mode: String?
    @State private var tools = ToolsPickerModel()
    @State private var catalog: NativeBackendCatalogEntry?
    @State private var loadedCatalogKey: String?
    @State private var catalogError: String?
    @State private var catalogLoading = false
    /// Catalogs for the agent's other providers, keyed by profile id: the model menu lists
    /// providers beside their models, and a switch can seed the composer without a blank frame.
    @State private var otherCatalogs: [String: NativeBackendCatalogEntry] = [:]
    @State private var otherCatalogIssues: [String: String] = [:]
    /// The context (agent, project, backend revision) each of [otherCatalogs] was read for. An entry
    /// read for another one still lists in the menu but is not taken as the composer's catalog.
    @State private var otherCatalogContexts: [String: String] = [:]
    @State private var slash: NativeSlashCatalog?
    /// The context [slash] was read for: a reconnect keeps the menu, another agent or project drops it.
    @State private var slashContextKey: String?
    private var creating: Bool {
        get { workbench.creatingHomeSession }
        nonmutating set { workbench.creatingHomeSession = newValue }
    }
    private var pendingCreation: PendingSessionCreation? {
        get { workbench.pendingHomeCreation }
        nonmutating set { workbench.pendingHomeCreation = newValue }
    }
    private var pendingKey: String { "riffet.creation|\(workbench.homeDraftKey)" }
    private var projectless: Bool { !quickChat && project == nil && workbench.supportsProjectlessTasks }
    @State private var isolating = false
    @State private var worktreeSource: Project?
    @State private var worktreeName = ""
    @State private var error: String?
    @State private var browsing = false
    /// The host's favorite folders, offered in the directory menu; kept by the workbench.
    private var favorites: FolderFavoritesModel { workbench.pageModels.homeFavorites }
    @State private var defaultsApplied = false
    @State private var attempting = false
    /// The warm CLI held for this page's choice (`PrewarmWatcher`).
    @State private var prewarm = PrewarmLease()

    private var quickChat: Bool { workbench.homeIsQuickChat }
    private var toolsScope: String { "\(backend)|\(resolvedProfileId ?? "")|\(project?.id ?? "")" }
    private var taskProject: Project? { workbench.project(workbench.homeTaskProjectId) }
    private var taskGit: GitStatusModel? { taskProject.map { GitStatusModel.model(for: $0.id) } }
    private var project: Project? { quickChat ? workbench.quickChatProject : taskProject }
    private var backend: String { quickChat ? AgentDirectory.quickChat : taskBackend }
    private var profileId: String? {
        get { quickChat ? nil : taskProfileId }
        nonmutating set { taskProfileId = newValue }
    }
    private var model: String? {
        get { quickChat ? chatModel : taskModel }
        nonmutating set {
            if quickChat { chatModel = newValue } else { taskModel = newValue }
        }
    }
    private var legacyTaskDraftKey: String {
        "home.\(taskProject?.id ?? "").\(builtinBackend(taskBackend)?.name ?? taskBackend).\(taskProfileId ?? "default")"
    }

    private func chooseProject(_ id: String?) {
        workbench.selectHomeProject(id)
    }
    private var catalogContextKey: String { catalogContextKey(project) }
    private func catalogContextKey(_ project: Project?) -> String { "\(backend)|\(profileId ?? "")|\(project?.id ?? "")" }
    /// The connection revision already moves when the stream becomes live, so the open
    /// conversation's reconnects do not reload the home page's catalog.
    private var catalogKey: String { catalogKey(project) }
    private func catalogKey(_ project: Project?) -> String {
        "\(catalogContextKey(project))|\(workbench.backendRevision)|\(workbench.catalogs.connectionRevision)"
    }
    /// This context's catalog already in memory: the page's own last answer or the workbench cache.
    /// Read in `body`, so a project switch shows it in the same frame, not after `seedCatalog`.
    private var cachedCatalog: NativeBackendCatalogEntry? {
        workbench.pageModels.homeCatalog(catalogKey) ?? workbench.catalogs.cached(backend, profileId: profileId, projectId: project?.id)
    }
    /// The catalog belongs to the agent, provider and project on screen. With nothing cached for a
    /// switch the previous one stays, its controls disabled, until the new one lands: the
    /// composer's chips and the line under it do not blink out and back.
    private var catalogCurrent: Bool { loadedCatalogKey == catalogContextKey || cachedCatalog != nil }
    /// This context's catalog; what is sent and offered is read from this one.
    private var currentCatalog: NativeBackendCatalogEntry? { loadedCatalogKey == catalogContextKey ? catalog : cachedCatalog }
    /// What the controls draw: this context's catalog, else the previous one standing in.
    private var shownCatalog: NativeBackendCatalogEntry? { currentCatalog ?? catalog }
    /// The profiles of the agent being started: the backend list answers before any catalog does.
    private var providerProfiles: [NativeBackendProfile] {
        guard !quickChat else { return [] }
        let listed = workbench.backends.first { $0.agent == backend }?.profiles ?? []
        return listed.isEmpty ? (currentCatalog?.profiles ?? []) : listed
    }
    /// The profile a nil choice resolves to, so the menu's "current" matches the loaded catalog.
    private var resolvedProfileId: String? {
        profileId ?? providerProfiles.first { $0.isDefault?.boolValue == true }?.id ?? providerProfiles.first?.id
    }
    private var otherCatalogContext: String { "\(backend)|\(project?.id ?? "")|\(workbench.backendRevision)" }
    private var profileCatalogsKey: String {
        // The active profile is part of the key: switching it makes the previous one a provider
        // whose models this menu still has to know.
        "\(backend)|\(project?.id ?? "")|\(resolvedProfileId ?? "")|\(providerProfiles.map(\.id).joined(separator: ","))|\(workbench.backendRevision)|\(workbench.catalogs.connectionRevision)"
    }
    /// Every provider with the models it offers: the active one from the loaded catalog, the rest
    /// from their own reads. Empty while the agent has a single provider (no column to draw).
    private var providerModels: [ProviderModels] {
        let profiles = providerProfiles
        guard profiles.count > 1, let catalog = currentCatalog, catalog.capabilities.supportsModelSelection else { return [] }
        let active = resolvedProfileId
        return profiles.map { profile in
            profile.id == active
                ? ProviderModels(profile: profile, models: catalog.models)
                : ProviderModels(profile: profile, models: otherCatalogs[profile.id]?.models, issue: otherCatalogIssues[profile.id])
        }
    }

    var body: some View {
        let project = self.project
        let currentCatalogKey = catalogKey(project)
        page(project)
            .background { PrewarmWatcher(lease: prewarm, api: workbench.host.api, request: prewarmRequest(project)) }
            .onAppear {
                applyDefaults()
                seedCatalog()
                composer.migrateDrafts(from: [legacyTaskDraftKey, "quick-chat"])
                applyPrefill()
                restorePendingCreation()
            }
            .onChange(of: workbench.settings) { previous, _ in
                let hadDefaults = defaultsApplied
                applyDefaults(previous: previous)
                if !hadDefaults { composer.migrateDrafts(from: [legacyTaskDraftKey]) }
            }
            .onChange(of: workbench.backends.map(\.agent)) { _, _ in
                guard !defaultsApplied else { return }
                applyDefaults()
                if defaultsApplied { composer.migrateDrafts(from: [legacyTaskDraftKey]) }
            }
            .task(id: currentCatalogKey) {
                guard !Task.isCancelled else { return }
                // Keep the same context usable while reconnecting. Another profile's catalog stays
                // only as a disabled placeholder (`catalogCurrent`) until this one's lands.
                if loadedCatalogKey != catalogContextKey { seedCatalog() }
                await loadCatalog(reload: false)
            }
            .task(id: profileCatalogsKey) {
                await loadProfileCatalogs()
            }
            .task(id: currentCatalogKey) {
                guard !Task.isCancelled else { return }
                let request = RequestContext { catalogKey }
                let context = catalogContextKey
                // The menu read for this context stays while it is read again.
                if slashContextKey != context, slash != nil { slash = nil }
                guard !quickChat, !backend.isEmpty else { return }
                let loaded = await workbench.catalogs.slashCatalog(agent: backend, profileId: profileId, projectId: project?.id)
                guard request.isCurrent else { return }
                if loaded !== slash { slash = loaded }
                slashContextKey = context
            }
            .onDisappear { composer.flushDraft() }
            .onChange(of: workbench.quickChatPrefillToken) { _, _ in applyPrefill() }
            .onChange(of: quickChat) { _, _ in error = nil; catalogError = nil }
            .sheet(isPresented: $browsing) {
                DirectoryBrowser(workbench: workbench) { path in
                    Task { if let opened = try? await workbench.openDirectory(path) { chooseProject(opened.id) } }
                }
            }
            .task { await favorites.load(workbench.host.api, maxAge: 10) }
            .task(id: taskProject?.id) { await taskGit?.load(workbench.host.api, maxAge: 10) }
            // Read again after the browser closes: it is where favorites are made.
            .onChange(of: browsing) { _, open in if !open { Task { await favorites.load(workbench.host.api) } } }
            .sheet(isPresented: $attempting) {
                if let project {
                    AttemptsSheet(workbench: workbench, projectId: project.id, initial: LaunchChoice(agent: backend, profileId: profileId, model: nonEmpty(model)))
                }
            }
            .alert("新建 Worktree", isPresented: Binding(get: { worktreeSource != nil }, set: { if !$0 { worktreeSource = nil } }), presenting: worktreeSource) { source in
                TextField("名称", text: $worktreeName, prompt: Text("留空自动生成"))
                Button("取消", role: .cancel) {}
                Button("创建") {
                    let name = worktreeName.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task { await isolate(project: source, name: name.isEmpty ? nil : name) }
                }
            }
    }

    /// The project menu's data and actions, for the chip above the composer.
    private func directoryChoices(_ project: Project?) -> DirectoryChoices {
        let projects = workbench.projectsByRecentUse
        let projectPaths = Set(projects.map(\.cwd))
        return DirectoryChoices(
            projects: projects, selected: taskProject, allowsProjectless: workbench.supportsProjectlessTasks,
            allowsWorktree: taskGit?.status != nil && taskGit?.error == nil, isolating: isolating,
            favorites: favorites.byRecentUse.filter { !projectPaths.contains($0.path) },
            select: chooseProject, isolate: {
                guard !isolating else { return }
                worktreeName = ""
                worktreeSource = project
            }, chooseOther: chooseDirectory,
            openFavorite: openFavorite
        )
    }

    /// The pickers, the composer and what it is waiting for.
    /// While a server, an Agent or a project is missing, the setup card stands where the composer will be.
    private var setup: SetupProgress { SetupProgress(model: app, workbench: workbench) }
    private var setupIncomplete: Bool { !quickChat && !setup.complete }

    @ViewBuilder
    private func composerSection(_ project: Project?, choices: DirectoryChoices) -> some View {
        if setupIncomplete {
            SetupCard(workbench: workbench, progress: setup).transition(.opacity)
        } else {
            composerBlock(project, choices: choices).transition(.opacity)
        }
    }

    private func composerBlock(_ project: Project?, choices: DirectoryChoices) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.xxs) {
                DirectoryMenu(choices: choices)
                Spacer(minLength: 0)
            }
            .opacity(quickChat ? 0 : 1)
            .allowsHitTesting(!quickChat)
            .accessibilityHidden(quickChat)
            .padding(.leading, -Space.sm)
            .padding(.bottom, Space.sm)

            ComposerView(
                model: composer,
                placeholder: quickChat ? String(localized: "发送消息…") : String(localized: "描述任务，@ 引用文件，/ 使用命令或 Skill"),
                working: false,
                sendState: nil,
                minLines: 3,
                features: features(project),
                sendEnabled: !creating && (pendingCreation != nil || (project != nil || projectless) && catalogCurrent && currentCatalog?.available != false),
                busy: creating,
                onSend: { _ in create() },
                onStop: nil,
                upload: { file in
                    guard self.project != nil || projectless else { throw LocalPairing.Failure(message: String(localized: "先选择项目")) }
                    return try await workbench.upload(file, projectId: self.project?.id)
                }
            ) {
                if !quickChat, let catalog = shownCatalog {
                    if catalog.capabilities.supportsPermissionSelection, !catalog.capabilities.permissions.isEmpty {
                        let modes = catalog.capabilities.supportsModeSelection ? catalog.capabilities.modes : []
                        OptionMenu(
                            title: String(localized: "审批"), options: catalog.capabilities.permissions,
                            selection: approval ?? catalog.capabilities.permissions.first?.id ?? "",
                            modes: modes, modeSelection: effectiveMode, chooseMode: { mode = $0 }
                        ) { approval = $0 }
                            .equatable()
                            .disabled(!catalogCurrent)
                    }
                    ToolsPicker(
                        model: tools, api: workbench.host.api, capabilities: catalog.capabilities, agent: backend, profileId: resolvedProfileId, projectId: project?.id,
                        groups: tools.groups, off: tools.offItems(scope: toolsScope),
                        setGroups: { tools.setGroups($0) }, setOff: { tools.setOff($0, scope: toolsScope) }
                    )
                }
            } trailing: {
                // A backend that cannot list models still needs a way to switch provider.
                if !quickChat {
                    if let catalog = shownCatalog, catalog.profiles.count > 1, !catalog.capabilities.supportsModelSelection { profileMenu(catalog).disabled(!catalogCurrent) }
                    BackendMenu(backends: workbench.backends.filter(\.isPickable), selected: backend, select: chooseBackend)
                }
                if let catalog = shownCatalog, catalog.capabilities.supportsModelSelection {
                    ModelControls(
                        catalog: catalog.models,
                        selection: effectiveModel,
                        usage: {
                            guard !quickChat else { return nil }
                            return try? await workbench.host.api?.agentUsage(agentId: backend, projectId: self.project?.id, profileId: resolvedProfileId, sessionId: nil, global: projectless)
                        },
                        reserveAccountUsage: backend == "codex",
                        loading: catalogLoading,
                        providers: providerModels,
                        activeProviderId: resolvedProfileId,
                        chooseInProvider: { provider, value in chooseModel(value, inProvider: provider) },
                        retryProvider: { provider in Task { await loadProfileCatalog(provider, reload: true) } },
                        scope: "\(backend)|\(resolvedProfileId ?? "")|\(project?.id ?? "")|\(workbench.catalogs.connectionRevision)",
                        usageStoreKey: "\(workbench.baseURL.absoluteString)|\(backend)|\(resolvedProfileId ?? "")|\(project?.id ?? "")",
                        remembered: workbench.settings?.defaultsFor(agent: backend)?.profileModels ?? [:],
                        refresh: { await loadCatalog(reload: true, quietly: true); await loadProfileCatalogs() },
                        // Below, as the agent menu beside it opens.
                        popupEdge: .below
                    ) { value in
                        chooseModel(value, inProvider: resolvedProfileId)
                    }
                    .disabled(!catalogCurrent)
                    .id("\(backend)|\(profileId ?? "")")
                } else if catalogLoading, shownCatalog == nil {
                    ModelControls(catalog: [], selection: effectiveModel, loading: true) { _ in }
                }
            }

            status
                .font(.riffet(size: S(12)))
                .padding(.top, Space.sm)
                .padding(.leading, Space.xs)
        }
    }

    /// The heading, the composer, what follows it.
    private func page(_ project: Project?) -> some View {
        let choices = directoryChoices(project)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                heading
                composerSection(project, choices: choices)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .animation(Motion.expressive, value: setupIncomplete)
                    // The composer's menu opens below it, over the quick actions that follow.
                    .zIndex(1)
                tail(project)
            }
            .frame(maxWidth: 720)
            .padding(.horizontal, Column.gutter)
            .padding(.top, 64)
            .padding(.bottom, Space.xxl)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    /// The mark and greeting.
    private var heading: some View {
        VStack(spacing: Space.lg) {
            LiveBrandMark(front: palette.fg, back: palette.fg4)
                .frame(width: 52, height: 52)
            Text(taskProject.map { "要在 \($0.name) 做什么？" } ?? "要做点什么？")
                .font(.riffet(size: S(22), weight: .semibold))
                .foregroundStyle(palette.fg)
                .frame(minHeight: S(27))
                .multilineTextAlignment(.center)
                .opacity(setupIncomplete ? 0 : 1)
        }
        .frame(maxWidth: .infinity)
        .opacity(quickChat ? 0 : 1)
        .accessibilityHidden(quickChat)
        .padding(.bottom, Space.xl)
    }

    /// What follows the composer: quick actions and attempts, or a quick chat's history.
    private func tail(_ project: Project?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !setupIncomplete {
                if quickChat {
                    QuickChatHistory(workbench: workbench)
                } else {
                    quickActions(project).padding(.top, Space.xxl)
                    if let project {
                        AttemptsHistorySection(workbench: workbench, projectId: project.id)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// What to warm up for the current choice; nil when the backend does not warm up.
    private func prewarmRequest(_ project: Project?) -> PrewarmWatcher.Request? {
        guard !quickChat, let project, currentCatalog?.capabilities.supportsPrewarm?.boolValue == true else { return nil }
        return PrewarmWatcher.Request(projectId: project.id, backend: backend, profileId: profileId, model: effectiveModel, mode: effectiveMode, approval: approval)
    }

    private func features(_ project: Project?) -> ComposerFeatures {
        ComposerFeatures(
            slash: quickChat ? nil : slash,
            unknownCommandHint: String(localized: "发送给 \(currentCatalog?.label ?? backendLabel(backend))"),
            searchFiles: (quickChat ? nil : project).map { project in { query in (try? await workbench.host.api?.find(projectId: project.id, query: query)) ?? [] } },
            references: quickChat ? [] : workbench.references(for: project?.id),
            addReference: { workbench.addReference(path: $0) },
            removeReference: { workbench.removeReference($0) },
            sessionCandidates: currentCatalog?.capabilities.supportsSessionReferences == true ? workbench.list.sessions : [],
            sessionProjects: workbench.list.projects,
            projectId: project?.id,
            addSessionReference: currentCatalog?.capabilities.supportsSessionReferences == true ? { workbench.addSessionReference($0) } : nil,
            openSessionReference: { workbench.open(sessionId: $0) },
            enterSends: workbench.settings?.composerEnterBehavior != "newline",
            menuBelow: true
        )
    }

    @ViewBuilder
    private var status: some View {
        if let catalog = currentCatalog, !catalog.available {
            HStack(spacing: Space.sm) {
                Label(catalog.reason ?? String(localized: "\(catalog.label) 当前不可用"), icon: "exclamationmark.triangle").foregroundStyle(palette.danger)
                Button("重新检测") { Task { await loadCatalog(reload: true) } }.buttonStyle(ChipButtonStyle())
            }
        } else if let error = error ?? workbench.homeCreationError {
            HStack(spacing: Space.sm) {
                Label(error, icon: "xmark.octagon").foregroundStyle(palette.danger)
                if pendingCreation != nil { Button("重试") { create() }.buttonStyle(ChipButtonStyle()).disabled(creating) }
            }
        } else if let catalogError {
            HStack(spacing: Space.sm) {
                Text("模型列表加载失败：\(catalogError)").foregroundStyle(palette.danger).lineLimit(3)
                Button("重试") { Task { await loadCatalog(reload: true) } }.buttonStyle(ChipButtonStyle())
            }
        } else if let catalog = currentCatalog, catalog.capabilities.supportsModelSelection, catalog.models.isEmpty {
            HStack(spacing: Space.sm) {
                Text("没有可用模型").foregroundStyle(palette.fg3)
                Button("重试") { Task { await loadCatalog(reload: true) } }.buttonStyle(ChipButtonStyle())
            }
        }
    }

    @ViewBuilder
    private func quickActions(_ project: Project?) -> some View {
        if project != nil {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: Space.sm)], spacing: Space.sm) {
                QuickAction(symbol: "terminal", title: String(localized: "Shell 终端"), detail: "") { Task { await openShell() } }
                QuickAction(symbol: "square.split.2x1", title: String(localized: "并行尝试"), detail: String(localized: "各自在独立 Worktree")) { attempting = true }
                    .disabled(creating || project?.isTaskWorkspace == true)
                QuickAction(symbol: "arrow.down.circle", title: String(localized: "继续终端会话"), detail: "") {
                    workbench.sidebar.importRequested = .init(projectId: project?.id)
                }
            }
        }
    }

    private func profileMenu(_ catalog: NativeBackendCatalogEntry) -> some View {
        let current = profileId ?? catalog.profiles.first?.id
        return NativeChipMenu(text: catalog.profiles.first { $0.id == current }?.name ?? String(localized: "默认配置"), symbol: "slider.horizontal.3") {
            [.header(String(localized: "配置"))] + catalog.profiles.map { profile in
                .item(profile.name, checked: current == profile.id) {
                    guard profileId != profile.id else { return }
                    profileId = profile.id
                    model = nil
                    mode = nil
                    approval = nonEmpty(workbench.settings?.defaultsFor(agent: backend)?.approval)
                    let selectedBackend = backend
                    Task { await workbench.rememberDefaults(agent: selectedBackend, profileId: profile.id, model: "") }
                }
            }
        }
    }

    private func applyDefaults(previous: AppSettings? = nil) {
        guard let settings = workbench.settings else { return }
        let saved = settings.defaultAgent.flatMap { $0 == AgentDirectory.quickChat ? nil : $0 }
        let defaultBackend = saved ?? workbench.defaultBackend?.agent ?? ""
        if !defaultsApplied {
            // The Agents are still being read: wait for them rather than start on a guess.
            guard !defaultBackend.isEmpty else { return }
            select(defaultBackend)
            defaultsApplied = true
            return
        }
        guard let previous else { return }
        if defaultBackend != (previous.defaultAgent ?? ""), taskBackend == (previous.defaultAgent ?? "") {
            select(defaultBackend)
            return
        }
        let defaults = settings.defaultsFor(agent: taskBackend)
        let oldDefaults = previous.defaultsFor(agent: taskBackend)
        let nextProfile = nonEmpty(defaults?.profileId)
        if nextProfile != nonEmpty(oldDefaults?.profileId), taskProfileId == nonEmpty(oldDefaults?.profileId) {
            select(taskBackend)
            return
        }
        if defaults?.model != oldDefaults?.model, taskModel == nonEmpty(oldDefaults?.model) { taskModel = nonEmpty(defaults?.model) }
        if defaults?.approval != oldDefaults?.approval, approval == nonEmpty(oldDefaults?.approval) { approval = nonEmpty(defaults?.approval) }
    }

    private func select(_ id: String) {
        guard id != AgentDirectory.quickChat else { return }
        if id != taskBackend {
            otherCatalogs = [:]
            otherCatalogIssues = [:]
            otherCatalogContexts = [:]
        }
        taskBackend = id
        let defaults = workbench.settings?.defaultsFor(agent: id)
        taskProfileId = nonEmpty(defaults?.profileId)
        taskModel = nonEmpty(defaults?.model)
        approval = nonEmpty(defaults?.approval)
        mode = nil
    }

    private func chooseBackend(_ id: String) {
        select(id)
        let selectedProfile = profileId
        Task { await workbench.rememberDefaults(agent: id, profileId: selectedProfile, makeDefault: true) }
    }

    /// Shows the catalog this context last had on the first frame instead of after the read; one
    /// read before the backends last changed still stands in until the new one lands.
    private func seedCatalog() {
        guard loadedCatalogKey != catalogContextKey,
              let cached = workbench.pageModels.homeCatalog(catalogKey)
                ?? workbench.catalogs.cached(backend, profileId: profileId, projectId: project?.id) else { return }
        if catalog !== cached { catalog = cached }
        loadedCatalogKey = catalogContextKey
    }

    /// A catalog on screen, this context's or the previous one standing in, is checked again
    /// without the loading state; [quietly] keeps it off for an explicit re-read too, like the
    /// model menu's as it opens.
    private func loadCatalog(reload: Bool, quietly: Bool = false) async {
        guard !Task.isCancelled, !backend.isEmpty else { return }
        let key = catalogKey
        let request = RequestContext { catalogKey }
        let shows = catalog == nil || (reload && !quietly)
        if shows != catalogLoading { catalogLoading = shows }
        defer { if request.isCurrent, catalogLoading { catalogLoading = false } }
        do {
            let loaded = try await workbench.catalogs.loadCatalog(backend, profileId: profileId, projectId: project?.id, reload: reload)
            guard request.isCurrent else { return }
            workbench.pageModels.rememberHomeCatalog(loaded, key: key)
            if catalog !== loaded { catalog = loaded }
            loadedCatalogKey = catalogContextKey
            if catalogError != nil { catalogError = nil }
            if let loaded, !loaded.models.isEmpty, let current = nonEmpty(model),
               !loaded.models.contains(where: { $0.value == resolveModelSelection(catalog: loaded.models, selection: current).model }) {
                model = nil
                if !quickChat { await workbench.rememberDefaults(agent: backend, profileId: profileId, model: "") }
            }
        } catch {
            guard request.isCurrent else { return }
            catalogError = error.riffetMessage
        }
    }

    /// Reads every other provider's models so the model menu can list them beside the active one.
    /// Each answer lands on its own: a slow gateway must not hold back, or blank, the others.
    /// Entries stay until their replacements land, so an open menu's lists do not blank; only a
    /// provider no longer listed goes at once (another agent's go in `select`).
    private func loadProfileCatalogs() async {
        let profiles = providerProfiles
        let listed = Set(profiles.map(\.id))
        if otherCatalogs.keys.contains(where: { !listed.contains($0) }) { otherCatalogs = otherCatalogs.filter { listed.contains($0.key) } }
        if otherCatalogIssues.keys.contains(where: { !listed.contains($0) }) { otherCatalogIssues = otherCatalogIssues.filter { listed.contains($0.key) } }
        if otherCatalogContexts.keys.contains(where: { !listed.contains($0) }) { otherCatalogContexts = otherCatalogContexts.filter { listed.contains($0.key) } }
        guard profiles.count > 1 else { return }
        for profile in profiles where profile.id != resolvedProfileId {
            await loadProfileCatalog(profile.id, reload: false)
        }
    }

    private func loadProfileCatalog(_ profile: String, reload: Bool) async {
        guard !Task.isCancelled else { return }
        let request = RequestContext { profileCatalogsKey }
        let context = otherCatalogContext
        // A retry shows as loading; a routine re-read keeps the issue until its answer.
        if reload, otherCatalogIssues[profile] != nil { otherCatalogIssues[profile] = nil }
        do {
            let entry = try await workbench.catalogs.loadCatalog(backend, profileId: profile, projectId: self.project?.id, reload: reload)
            guard request.isCurrent else { return }
            // No answer leaves the list showing, but no longer as this context's.
            guard let entry else { otherCatalogContexts[profile] = nil; return }
            otherCatalogs[profile] = entry
            otherCatalogContexts[profile] = context
            otherCatalogIssues[profile] = entry.models.isEmpty ? entry.reason : nil
        } catch is CancellationError {
            return
        } catch {
            guard request.isCurrent else { return }
            otherCatalogContexts[profile] = nil
            otherCatalogIssues[profile] = error.riffetMessage
        }
    }

    /// Picks a model, switching provider when it belongs to another profile. Provider and model
    /// are saved together, so the model is not dropped as a stale override for the old provider.
    private func chooseModel(_ value: String, inProvider provider: String?) {
        if quickChat { chatModel = value; return }
        let target = provider ?? resolvedProfileId
        if let provider, provider != resolvedProfileId {
            // The provider being left keeps its list in the menu without another read.
            if let previous = resolvedProfileId, let current = currentCatalog {
                if otherCatalogs[previous] !== current { otherCatalogs[previous] = current }
                otherCatalogContexts[previous] = otherCatalogContext
            }
            profileId = provider
            // A different provider has different capabilities; restore its permission default.
            approval = nonEmpty(workbench.settings?.defaultsFor(agent: backend)?.approval)
            mode = nil
            // The provider's catalog was read for the menu, so the composer does not go blank
            // while the switch's own request answers. One read for another project or revision
            // is not taken as current: the switch's own read decides.
            if let entry = otherCatalogs[provider], otherCatalogContexts[provider] == otherCatalogContext {
                catalog = entry
                catalogError = nil
                loadedCatalogKey = catalogContextKey
            } else {
                // The previous provider's catalog stands in, disabled, until this one's lands.
                loadedCatalogKey = nil
            }
        }
        model = value
        let selectedBackend = backend
        Task { await workbench.rememberDefaults(agent: selectedBackend, profileId: target, model: value) }
    }

    private func chooseDirectory() {
        if workbench.local {
            // Leave the Menu action before asking AppKit to attach a sheet.
            Task {
                guard let url = await DirectoryPanel.choose(prompt: String(localized: "在此新建会话")) else { return }
                do { chooseProject(try await workbench.openDirectory(url.path).id) } catch { self.error = error.riffetMessage }
            }
        } else {
            browsing = true
        }
    }

    /// A favorite folder becomes the project for the new conversation; the server stamps it as used.
    private func openFavorite(_ path: String) {
        Task {
            do { chooseProject(try await workbench.openDirectory(path).id) } catch { self.error = error.riffetMessage }
            await favorites.load(workbench.host.api)
        }
    }

    /// Cuts a fresh worktree of the project and moves the new conversation into it.
    private func isolate(project: Project, name: String?) async {
        guard !isolating, !project.isTaskWorkspace, let api = workbench.host.api else { return }
        isolating = true
        defer { isolating = false }
        do {
            let created = try await api.createWorktreeProject(projectId: project.id, path: nil, name: name)
            workbench.refresh()
            chooseProject(created.id)
            error = nil
        } catch {
            self.error = String(localized: "无法创建 Worktree：\(error.riffetMessage)")
        }
    }

    private func openShell() async {
        guard let project else { return }
        await workbench.terminalDock.openShell(projectId: project.id, createNew: true)
    }

    private var effectiveMode: String {
        guard !quickChat, let modes = currentCatalog?.capabilities.modes else { return "agent" }
        if let mode, modes.contains(where: { $0.id == mode }) { return mode }
        return modes.first { $0.id == "agent" }?.id ?? modes.first?.id ?? "agent"
    }

    private var defaultModel: String? {
        if quickChat { return workbench.defaultChatModel(currentCatalog) }
        let defaults = workbench.settings?.defaultsFor(agent: backend)
        let defaultProfile = providerProfiles.first { $0.isDefault?.boolValue == true }?.id ?? providerProfiles.first?.id
        let saved = (defaults?.profileId ?? defaultProfile) == resolvedProfileId ? nonEmpty(defaults?.model) : nil
        // A provider switched to starts on what was last picked there, not on its default.
        let models = currentCatalog?.models ?? []
        let remembered = resolvedProfileId.flatMap { nonEmpty(defaults?.profileModels?[$0]) }
            .flatMap { value in models.isEmpty || models.contains { $0.value == resolveModelSelection(catalog: models, selection: value).model } ? value : nil }
        return saved ?? remembered ?? workbench.recentModel(agent: backend, profileId: resolvedProfileId)
            ?? nonEmpty(currentCatalog?.defaultModel)
    }

    /// A saved model that is no longer in the loaded catalog is dropped rather than shown or sent.
    private var effectiveModel: String? {
        let candidate = nonEmpty(model) ?? defaultModel
        guard let candidate else { return nil }
        guard let models = currentCatalog?.models, !models.isEmpty else { return candidate }
        let resolved = resolveModelSelection(catalog: models, selection: candidate)
        if models.contains(where: { $0.value == resolved.model }) {
            return catalogSelection(catalog: models, model: resolved.model, overrides: resolved.params, preferredParam: nil)
        }
        if let fallback = nonEmpty(currentCatalog?.defaultModel),
           models.contains(where: { $0.value == resolveModelSelection(catalog: models, selection: fallback).model }) {
            let resolved = resolveModelSelection(catalog: models, selection: fallback)
            return catalogSelection(catalog: models, model: resolved.model, overrides: resolved.params, preferredParam: nil)
        }
        return nil
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    private func applyPrefill() {
        guard !workbench.quickChatPrefill.isEmpty else { return }
        let text = workbench.quickChatPrefill
        composer.replace(text: text, caret: (text as NSString).length)
        workbench.quickChatPrefill = ""
    }

    private func restorePendingCreation() {
        guard pendingCreation == nil else { return }
        do {
            let savedId = UserDefaults.standard.string(forKey: pendingKey)
            pendingCreation = try savedId.flatMap { try workbench.store.pendingCreation(id: $0) }
                ?? workbench.store.pendingCreations().first
            if let pendingCreation {
                UserDefaults.standard.set(pendingCreation.id, forKey: pendingKey)
                create()
            }
        } catch { self.error = error.riffetMessage }
    }

    private func create() {
        guard !creating, pendingCreation != nil || (composer.canSend && (project != nil || projectless) && catalogCurrent && currentCatalog?.available != false) else { return }
        creating = true
        prewarm.sent()
        workbench.homeCreationError = nil
        error = nil
        let intent = workbench.creationNavigationIntent
        let rememberSelection = pendingCreation == nil
        let submission = composer.submission()
        let selectedProjectId = project?.id
        let selectedBackend = backend
        let selectedProfile = profileId
        let selectedModel = effectiveModel
        let selectedMode = effectiveMode
        let selectedApproval = quickChat ? nil : approval
        let selectedReferences = quickChat ? [] : workbench.references(for: selectedProjectId)
        let selectedTools = quickChat ? (groups: nil, off: nil) : tools.creation(capabilities: currentCatalog?.capabilities, agent: backend, projectId: selectedProjectId, scope: toolsScope)
        Task {
            do {
                let request: PendingSessionCreation
                if let pendingCreation { request = pendingCreation }
                else {
                    request = try workbench.store.prepareCreation(
                        projectId: selectedProjectId, prompt: submission.text, attachments: submission.attachments,
                        backendId: nil, backendProfileId: selectedProfile, model: selectedModel, mode: selectedMode,
                        approval: selectedApproval, context: selectedReferences, agentId: selectedBackend,
                        toolGroups: selectedTools.groups, extensionsOff: selectedTools.off
                    )
                    pendingCreation = request
                    UserDefaults.standard.set(request.id, forKey: pendingKey)
                    composer.flushDraft()
                    guard UserDefaults.standard.synchronize() else { throw SettingsFailure(String(localized: "无法保存任务草稿")) }
                }
                _ = try await workbench.createPreparedSession(request, intent: intent, rememberSelection: rememberSelection)
                if request.body.initialMessage?.text == submission.text,
                   Set(request.body.initialMessage?.attachments?.map(\.id) ?? []) == Set(submission.attachments.map(\.id)) {
                    composer.clear(sent: submission)
                } else if let message = request.body.initialMessage {
                    composer.clearAccepted(text: message.text, attachmentIds: Set(message.attachments?.map(\.id) ?? []))
                }
                composer.flushDraft()
                guard UserDefaults.standard.synchronize() else { throw SettingsFailure(String(localized: "无法保存任务草稿")) }
                UserDefaults.standard.removeObject(forKey: pendingKey)
                guard UserDefaults.standard.synchronize() else { throw SettingsFailure(String(localized: "无法保存任务草稿")) }
                try workbench.store.acknowledgePreparedCreation(id: request.id)
                pendingCreation = nil
            } catch {
                if ((error as NSError).userInfo["KotlinException"] as? RiffetHttpException)?.creationRejectedBeforeAcceptance == true,
                   let request = pendingCreation {
                    do {
                        try workbench.store.discardPreparedCreation(id: request.id)
                        UserDefaults.standard.removeObject(forKey: pendingKey)
                        pendingCreation = nil
                    } catch { /* Keep the request if clearing its durable record fails. */ }
                }
                prewarm.sendFailed()
                workbench.homeCreationError = error.riffetMessage
            }
            creating = false
        }
    }

}

/// Where the conversation runs: projects and worktrees in recent-use order, a fresh
/// isolated checkout, or any other directory (`DirectoryMenu.tsx`).
///
/// An AppKit menu built on click, not a SwiftUI `Menu`: SwiftUI rebuilds an open menu whenever the
/// page re-renders, and AppKit throws mid-tracking rebuilding subtitle rows on screen, which leaves
/// the window's toolbar dead.
private struct DirectoryChoices {
    let projects: [Project]
    let selected: Project?
    let allowsProjectless: Bool
    let allowsWorktree: Bool
    let isolating: Bool
    /// Favorite folders that are not projects yet, most recently used first.
    let favorites: [FolderFavorite]
    let select: (String?) -> Void
    let isolate: () -> Void
    let chooseOther: () -> Void
    let openFavorite: (String) -> Void

    func menu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        if allowsProjectless {
            let none = MenuAction.item(String(localized: "不选择项目")) { select(nil) }
            none.image = NSImage.icon("folder", accessibilityDescription: nil)
            none.state = selected == nil ? .on : .off
            menu.addItem(none)
            menu.addItem(.separator())
        }
        if allowsWorktree, selected != nil {
            let isolateItem = MenuAction.item(isolating ? String(localized: "正在创建 Worktree…") : String(localized: "新建 Worktree"), isolate)
            isolateItem.image = NSImage.icon("arrow.triangle.branch", accessibilityDescription: nil)
            isolateItem.isEnabled = !isolating && selected != nil
            menu.addItem(isolateItem)
        }
        let other = MenuAction.item(String(localized: "选择其他目录…"), chooseOther)
        other.image = NSImage.icon("folder.badge.plus", accessibilityDescription: nil)
        menu.addItem(other)

        if !projects.isEmpty {
            menu.addItem(.separator())
            for item in projects { menu.addItem(row(item)) }
        }

        if !favorites.isEmpty {
            menu.addItem(.separator())
            menu.addItem(.sectionHeader(title: String(localized: "收藏的目录")))
            for favorite in favorites {
                let path = favorite.path
                let item = MenuAction.item(favoriteName(favorite)) { openFavorite(path) }
                item.image = NSImage.icon("star", accessibilityDescription: nil)
                item.subtitle = abbreviateHome(path)
                menu.addItem(item)
            }
        }
        return menu
    }

    private func row(_ item: Project) -> NSMenuItem {
        let id = item.id
        let row = MenuAction.item(item.worktree?.branch ?? item.name) { select(id) }
        row.image = NSImage.icon(item.worktree != nil ? "arrow.triangle.branch" : "folder", accessibilityDescription: nil)
        row.subtitle = abbreviateHome(item.cwd)
        row.state = item.id == selected?.id ? .on : .off
        return row
    }
}

private struct DirectoryMenu: View {
    let choices: DirectoryChoices
    @State private var anchor = MenuAnchor()

    var body: some View {
        let selected = choices.selected
        Button { anchor.popUp(choices.menu()) } label: {
            ChipLabel(text: selected.map { $0.worktree?.branch ?? $0.name } ?? (choices.allowsProjectless ? String(localized: "未关联项目") : String(localized: "选择项目")), symbol: selected?.worktree == nil ? "folder" : "arrow.triangle.branch")
        }
        .buttonStyle(ChipButtonStyle())
        .background(MenuAnchorView(anchor: anchor))
        .fixedSize()
        .help(selected?.cwd ?? String(localized: "选择项目"))
    }
}

/// The agent for the new conversation, with why an unavailable one cannot be picked. Built on
/// click for the same reason as `DirectoryMenu`.
private struct BackendMenu: View {
    let backends: [NativeBackendCatalogEntry]
    let selected: String
    let select: (String) -> Void
    @State private var anchor = MenuAnchor()

    var body: some View {
        Button { anchor.popUp(menu()) } label: {
            ChipLabel(text: backends.first { $0.agent == selected }?.label ?? backendLabel(selected), symbol: "sparkle")
        }
        .buttonStyle(ChipButtonStyle())
        .background(MenuAnchorView(anchor: anchor))
        .fixedSize()
    }

    private func menu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(.sectionHeader(title: "Agent"))
        for entry in backends {
            let id = entry.agent
            let item = MenuAction.item(entry.label) { select(id) }
            if !entry.available, let reason = entry.reason { item.subtitle = reason }
            item.isEnabled = entry.available
            item.state = id == selected ? .on : .off
            menu.addItem(item)
        }
        return menu
    }
}

/// A card on the home page for starting something other than a prompt.
struct QuickAction: View {
    let symbol: String
    let title: String
    let detail: String
    let action: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            // Centred, so a tile without a detail line sits level with one that has it.
            HStack(spacing: Space.md) {
                Image(icon: symbol)
                    .font(.riffet(size: S(14)))
                    .foregroundStyle(palette.fg2)
                    .frame(width: 32, height: 32)
                    .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
                    if !detail.isEmpty {
                        Text(detail).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.md + 2)
            .padding(.vertical, Space.md)
            .background(hovering ? palette.bgSubtle : palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.5)
        .onHover { hovering = $0 }
        .animation(Motion.fast, value: hovering)
    }
}

/// A path with the home directory written as `~`.
func abbreviateHome(_ path: String) -> String {
    let home = NSHomeDirectory()
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}

/// Browses the server's filesystem (`POST /api/browse`) for a remote server, whose folders the
/// system open panel cannot see.
struct DirectoryBrowser: View {
    let workbench: Workbench
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var result: BrowseResult?
    @State private var showHidden = false
    @State private var error: String?
    @State private var favorites = FolderFavoritesModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button { load(result?.parent) } label: { Image(icon: "chevron.up") }.disabled(result?.parent == nil)
                Text(displayPath).font(RiffetFont.codeSmall).lineLimit(1).truncationMode(.head)
                Spacer()
                if let path = result?.path {
                    let starred = favorites.favorite(at: path) != nil
                    Button { Task { await favorites.toggle(path) } } label: {
                        Image(icon: starred ? "star.fill" : "star").foregroundStyle(starred ? palette.warning : palette.fg3)
                    }
                    .buttonStyle(.borderless)
                    .help(starred ? "取消收藏此目录" : "收藏此目录")
                }
                Toggle("隐藏目录", isOn: $showHidden).toggleStyle(.checkbox)
            }
            .padding(12)
            if !favorites.favorites.isEmpty {
                FolderFavoriteStrip(model: favorites, currentPath: result?.path) { load($0.path) }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
            }
            Divider()
            List(entries, id: \.name) { entry in
                let path = ((result?.path ?? "") as NSString).appendingPathComponent(entry.name)
                // The listing marks a symlinked favorite by its target; the model knows the rest.
                let favorite = favorites.favorite(at: path) ?? entry.favoriteId.flatMap { id in favorites.favorites.first { $0.id == id } }
                HStack(spacing: 4) {
                    Button { load(path) } label: {
                        Label(entry.name, icon: "folder").frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button {
                        Task { if let favorite { await favorites.remove(favorite) } else { await favorites.add(path) } }
                    } label: {
                        Image(icon: favorite == nil ? "star" : "star.fill").foregroundStyle(favorite == nil ? palette.fg4 : palette.warning)
                    }
                    .buttonStyle(.borderless)
                    .help(favorite == nil ? "收藏" : "取消收藏")
                }
            }
            if let error { Text(error).foregroundStyle(palette.danger).font(RiffetFont.caption).padding(8) }
            Divider()
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("在此新建会话") {
                    if let path = result?.path { choose(path) }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(result == nil)
            }
            .padding(12)
        }
        .frame(width: 520, height: 480)
        .task {
            load(nil)
            await favorites.load(workbench.host.api)
        }
    }

    private var entries: [BrowseEntry] { (result?.entries ?? []).filter { showHidden || !$0.hidden } }

    private var displayPath: String {
        guard let result else { return "" }
        return result.path.hasPrefix(result.home) ? "~" + result.path.dropFirst(result.home.count) : result.path
    }

    private func load(_ path: String?) {
        Task {
            do {
                result = try await workbench.host.api?.browse(path: path)
                error = nil
            } catch {
                self.error = error.riffetMessage
            }
        }
    }
}
