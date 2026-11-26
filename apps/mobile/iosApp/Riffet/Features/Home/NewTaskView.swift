import SwiftUI
import RiffetKit

struct NewTaskView: View {
    let workbench: Workbench
    let onStart: (Session) -> Void
    /// Opens an existing session (one referenced from this page) in the same stack.
    var onOpenSession: (String) -> Void = { _ in }
    /// Set for the assistant's page: its project, its own draft and choice of agent, and its setup cards in place of the terminal tools.
    var assistant: AssistantSetup? = nil
    /// Set with `assistant` for a team member's page: its project, Agents, remembered choice and draft.
    var member: AgentMember? = nil
    /// A fresh member's conversations above the composer, which then sits at the bottom of the page.
    var pageContent: AnyView? = nil
    @State private var assistantPage: AssistantPage?
    @State private var projects = false
    @State private var browsing = false
    @State private var directories = false
    /// 跳过 on the setup card's project step: the composer returns without a project.
    @State private var setupSkipped = false
    /// The model chip's picker panel.
    @State private var modelPanel = false
    @State private var files = false
    @State private var photos = false
    /// The `/` or `@` token being typed: its menu docks above the card, as in a conversation.
    @State private var menu: ComposerMenuToken?
    @State private var importing = false
    @State private var loadedCatalog: NativeBackendCatalogEntry?
    @State private var loadingCatalog = false
    @State private var catalogError: String?
    @State private var sending = false
    @State private var discardPending = false
    @State private var toolDevices = ToolDevices()
    @State private var remembered: [String]?
    /// MCP servers and Skills switched off for this task only; a new one starts with everything on.
    @State private var extensionsOff: [String] = []
    /// A warm CLI held for this page's choice while it is open; a send hands it to the new conversation.
    @State private var prewarm = PrewarmLease()
    @FocusState private var writing: Bool
    @State private var voice = ComposerVoice()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.palette) private var palette
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSize
    private var compact: Bool { verticalSize == .compact }
    /// A short landscape window, or the composer at the bottom of a member's page: the input starts at two lines.
    private var tight: Bool { compact || pageContent != nil }
    private var markHidden: Bool { writing || compact }
    /// The quick-chat project, whose sessions are not tasks: a pending creation in it is not this page's.
    /// The assistant keeps its own draft, apart from the task's.
    private var draft: MessageDraft { workbench.drafts.draft(member.map { "member." + $0.id } ?? (assistant != nil ? "assistant" : "new")) }
    /// The settings the composer's defaults come from: the assistant's own choice stands in for the agent's.
    private var settings: AppSettings? {
        if let member { return workbench.memberSettings(member) }
        return assistant != nil ? AssistantKt.assistantSettings(settings: workbench.settings, backends: workbench.backends) : workbench.settings
    }
    private var catalog: NativeBackendCatalogEntry? { loadedCatalog.flatMap { $0.backendId == backend ? $0 : nil } }
    private var backend: NativeBackendId {
        // The assistant runs only on the agents that isolate it; a draft's other agent gives way to its own.
        let restricted = assistant != nil
        return workbench.backends.first { $0.backendId.name == draft.backendName && (!restricted || AssistantKt.isAssistantBackend(id: $0.backendId)) }?.backendId ?? settings?.defaultBackendId ?? workbench.backends.first(where: { $0.available })?.backendId ?? .claude
    }
    private var project: Project? {
        if let member { return workbench.project(member.projectId) }
        return assistant != nil ? workbench.assistantProject : workbench.projects.first { $0.id == draft.projectID }
    }
    /// What a warm CLI is held for: only an Agent that keeps one (Cursor) asks for it.
    private var prewarmBody: PrewarmBody? {
        guard let project, let catalog, catalog.capabilities.supportsPrewarm?.boolValue == true else { return nil }
        let choice = NativeConfigurationSummary.choice(catalog: catalog, draft: draft, settings: settings)
        return PrewarmBody(projectId: project.id, backendId: backend, backendProfileId: draft.profileID, model: draft.model,
                           mode: choice.mode, approval: choice.approval, agentId: nil, claimId: nil)
    }
    private var toolsKey: String { "riffet.ios.\(workbench.baseURL.absoluteString).tool-groups" }
    /// The last pick on this device; only the phones online now are shown and sent.
    private var rememberedTools: [String] { remembered ?? ToolGroups.shared.decode(raw: UserDefaults.standard.string(forKey: toolsKey)) }
    private var pickedTools: [String] { ToolsPick.offeredPicks(devices: toolDevices.devices, value: rememberedTools, plugins: toolDevices.plugins) }
    private var phonesShown: Bool {
        catalog?.capabilities.supportsRiffetTools == true && ToolsPick.offered(devices: toolDevices.devices, value: [], plugins: toolDevices.plugins)
    }
    private var extensions: ExtensionsPick? {
        ExtensionsPick.make(workbench: workbench, allowed: true, capabilities: catalog?.capabilities, backendId: backend,
                            profileId: draft.profileID, projectId: draft.projectID, off: extensionsOff,
                            onChange: { extensionsOff = ExtensionsOff.shared.clean(value: $0) })
    }
    private var extensionsKey: String { "\(backend.name)|\(draft.profileID ?? "")|\(draft.projectID ?? "")" }
    private func pickTools(_ groups: [String]) {
        remembered = ToolGroups.shared.picks(groups: groups)
        UserDefaults.standard.set(ToolGroups.shared.encode(groups: groups), forKey: toolsKey)
    }
    private var contextKey: String { "\(backend.name)|\(draft.profileID ?? "")|\(draft.projectID ?? "")|\(workbench.list.backendRevision)" }
    var body: some View {
        @Bindable var draft = draft
        pageBody.riffetTypeBoundary()
        .navigationTitle(member != nil ? "" : assistant != nil ? String(localized: "个人助理", bundle: .riffet) : String(localized: "新会话", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if assistant == nil, let project {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    NavigationLink { ProjectFilesView(workbench: workbench, project: project).modifier(PushedPageTabBar()) } label: { Image(systemName: "doc") }
                        .accessibilityLabel(String(localized: "文件", bundle: .riffet))
                    NavigationLink { ProjectChangesView(workbench: workbench, project: project).modifier(PushedPageTabBar()) } label: { Image(systemName: "arrow.triangle.branch") }
                        .accessibilityLabel(String(localized: "变更", bundle: .riffet))
                }
            }
        }
        .sheet(isPresented: $projects, onDismiss: { if browsing { browsing = false; directories = true } }) {
            ProjectSheet(workbench: workbench, selection: draft.projectID, onBrowse: { browsing = true }) { if let picked = $0 { draft.projectID = picked.id } }
        }
        .sheet(item: $assistantPage) { page in
            if let assistant {
                NavigationStack {
                    page.destination(workbench: workbench, setup: assistant)
                        .toolbar { if page != .rules { ToolbarItem(placement: .confirmationAction) { Button("完成") { assistantPage = nil } } } }
                }
            }
        }
        .sheet(isPresented: $directories) { ProjectPicker(workbench: workbench, selection: $draft.projectID) }
        .sheet(isPresented: $importing) { ExternalSessionPicker(workbench: workbench, projectID: draft.projectID, open: onOpenSession) }
        .riffetPanelSheet(isPresented: $modelPanel) {
            NewTaskModelPanel(workbench: workbench, draft: draft, catalog: catalog, backend: backend, loading: loadingCatalog, error: catalogError,
                              retry: { Task { await loadCatalog(reload: true) } }, assistant: assistant != nil,
                              more: { AnyView(NewTaskOptions(workbench: workbench, draft: draft, catalog: catalog, backend: backend,
                                  loading: loadingCatalog, error: catalogError, retry: { Task { await loadCatalog(reload: true) } },
                                  toolDevices: toolDevices.devices, toolPlugins: toolDevices.plugins, toolGroups: pickedTools, onPickTools: pickTools, extensions: extensions)) },
                              close: { modelPanel = false })
        }
        .sheet(isPresented: $files) { DocumentAttachmentPicker { picked($0); files = false } }
        .sheet(isPresented: $photos) { PhotoAttachmentPicker { picked($0); photos = false } }
        .attachmentDrop(enabled: project != nil && !sending && !draft.uploading && draft.pendingCreationID == nil, picked)
        .confirmationDialog("停止跟踪这次提交？", isPresented: $discardPending, titleVisibility: .visible) {
            Button("停止跟踪", role: .destructive) {
                do { if let id = draft.pendingCreationID { try workbench.store.discardPreparedCreation(id: id) }; draft.pendingCreationID = nil }
                catch { draft.error = error.riffetMessage }
            }
        } message: { Text("任务可能已创建，请先查看会话列表") }
        .task {
            // The task draft tracks its unconfirmed submission; a quick chat left by an earlier version is not a task's.
            let task = workbench.drafts.draft("new")
            do {
                if let id = task.pendingCreationID, try workbench.store.pendingCreation(id: id) == nil { task.pendingCreationID = nil }
                if task.pendingCreationID == nil, let open = try workbench.store.pendingCreations().first(where: { $0.body.backendId != .chat }) {
                    task.pendingCreationID = open.id
                }
            } catch { draft.error = error.riffetMessage }
            if draft.backendName == nil { draft.backendName = backend.name }
            // Project and model are choices the user makes before opening the keyboard.
        }
        .task(id: contextKey) { await loadCatalog() }
        .onAppear { prewarm.hold(api: workbench.api, body: prewarmBody); draft.dropBlankText() }
        .onChange(of: prewarmBody) { _, body in prewarm.hold(api: workbench.api, body: body) }
        .onDisappear { prewarm.close(); voice.teardown() }
        .onChange(of: writing) { _, now in
            if now, voice.mode { voice.setMode(false) }
            if !now { draft.dropBlankText() }
        }
        .onChange(of: voice.mode) { _, on in if on { writing = false } }
        .onChange(of: scenePhase) { _, phase in voice.scenePhaseChanged(phase) }
        .onChange(of: project?.id, initial: true) { _, id in
            if assistant != nil, let id, draft.projectID != id { draft.projectID = id }
        }
        .onChange(of: extensionsKey) { _, _ in extensionsOff = [] }
        .readsToolDevices(toolDevices, workbench: workbench, enabled: catalog?.capabilities.supportsRiffetTools == true)
    }
    /// The page's content: the centred composer under the brand mark, or a fresh member's conversations above a bottom composer.
    @ViewBuilder private var pageBody: some View {
        if let pageContent {
            pageContent
                .onTapGesture { writing = false }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        menuDock.riffetTypeBoundary()
                        cardSlot.riffetTypeBoundary()
                        notes.riffetTypeBoundary()
                    }
                    .padding(.horizontal, RiffetMetrics.pageInset).padding(.bottom, RiffetMetrics.floatingGap)
                }
        } else {
            ZStack {
                palette.bg.ignoresSafeArea().onTapGesture { writing = false }
                GeometryReader { viewport in
                ScrollView {
                    // The composer block sits at the page's vertical centre; the room above it holds the mark.
                    NewTaskLayout(minHeight: viewport.size.height, markShown: !markHidden) {
                        // Folded away while the keyboard is up or the screen is short, where the form needs the room.
                        LiveBrandMark(front: palette.fg, back: palette.accent)
                            .opacity(markHidden ? 0 : 1)
                            .allowsHitTesting(!markHidden)
                        VStack(alignment: .leading, spacing: 0) {
                            slot.riffetTypeBoundary()
                            menuDock.riffetTypeBoundary()
                            cardSlot.riffetTypeBoundary()
                        }
                        .padding(.horizontal, RiffetMetrics.pageInset).padding(.top, compact ? 4 : 8)
                        VStack(alignment: .leading, spacing: 0) {
                            notes.riffetTypeBoundary()
                            (assistant != nil ? AnyView(assistantCards) : AnyView(toolCards)).padding(.top, 12).riffetTypeBoundary()
                        }
                        .padding(.horizontal, RiffetMetrics.pageInset).padding(.bottom, 24)
                    }
                    .riffetAnimation(RiffetMotion.spatial, value: markHidden)
                    .frame(maxWidth: .infinity)
                    .background { Color.clear.contentShape(Rectangle()).onTapGesture { writing = false } }
                }
                .scrollDismissesKeyboard(.interactively)
                }
            }
        }
    }
    private var voiceInput: Bool { workbench.settings?.voiceInput?.recognizer != nil }
    private var voiceActive: Bool { voice.mode && voiceInput }
    private var holdInFooter: Bool { voiceActive && !voice.textEmpty(draft) }
    private var locked: Bool { sending || draft.pendingCreationID != nil }
    private var hasAttachments: Bool { !draft.attachments.isEmpty || !draft.pendingFiles.isEmpty || !draft.references.isEmpty }
    private var canStart: Bool {
        !sending && (draft.pendingCreationID != nil || (draft.canSend && project != nil && !loadingCatalog && catalog?.available == true))
    }
    private func openModelPanel() {
        guard !sending, draft.pendingCreationID == nil else { return }
        writing = false
        // Publish the text field's focus teardown before requesting another UIKit presentation,
        // without inserting a wall-clock delay into the interaction.
        Task { @MainActor in
            await Task.yield()
            guard !sending, draft.pendingCreationID == nil else { return }
            modelPanel = true
        }
    }

    /// The setup card stands in the composer's place while there is no Agent or no project (patterns.md §1.5).
    private var setupShown: Bool { assistant == nil && ConnectedSetupCard.needed(workbench, skipped: setupSkipped) }
    @ViewBuilder private var cardSlot: some View {
        if setupShown {
            ConnectedSetupCard(workbench: workbench, pickProject: { writing = false; if workbench.projects.isEmpty { directories = true } else { projects = true } },
                               skip: { withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { setupSkipped = true } })
        } else {
            card
        }
    }

    /// Input, attachments and the send row in one card.
    private var card: some View {
        @Bindable var draft = draft
        return VStack(alignment: .leading, spacing: 0) {
            if voiceActive && voice.textEmpty(draft) && !voice.handsFree {
                // Where the text field would be, its height: the top inset equals the gap above the send button, the
                // left edge is the text's and the right edge the send button's.
                holdBar(height: holdBarHeight).padding(.leading, RiffetMetrics.groupInset).padding(.trailing, Self.sendEdge)
                    .padding(.top, Self.holdTop).padding(.bottom, Self.holdTop - Self.sendInset).disabled(locked)
            } else {
            ComposerFieldLayout(key: writing ? nil : [AnyHashable(draft.text), AnyHashable(textSize), AnyHashable(compact)]) {
                TextField(assistant != nil ? LocalizedStringKey("发送消息…") : LocalizedStringKey("描述任务"), text: $draft.text, selection: voice.selectionBinding(draft), axis: .vertical)
                    .riffetFont(.body).lineLimit(tight ? 2...6 : 4...14).focused($writing)
            }
                .frame(minHeight: tight ? 44 : 112, alignment: .topLeading)
                .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 6)
                .accessibilityLabel("任务内容").accessibilityIdentifier("newTaskText").disabled(locked || voice.dictating)
                .onChange(of: draft.text) { _, value in updateMenu(value) }
            }
            if hasAttachments { attachmentChips.padding(.bottom, 4) }
            HStack(spacing: 0) {
                // Hands-free, the footer is the recording bar: it has its own cancel and done.
                if let dictation = voice.dictation, voice.handsFree {
                    DictationBar(state: dictation, cancel: { voice.cancel() }, finish: { voice.finish() }, retry: { voice.retry() })
                } else {
                plusMenu
                if voiceInput { ComposerVoiceToggle(voice: voice, keyboard: { Task { writing = true } }) { name in
                    Image(systemName: name).riffetFont(.barTitle, weight: .regular).foregroundStyle(palette.fg)
                        .frame(width: Self.toolWidth, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
                }.disabled(locked) }
                if holdInFooter {
                    holdBar(height: RiffetMetrics.sendButton).padding(.horizontal, RiffetMetrics.floatingGap).disabled(locked)
                } else {
                // The settings follow the attach button, as on Android; the send button keeps the far edge.
                RiffetModelLabel(title: NativeConfigurationSummary.shortModel(catalog: catalog, selection: draft.model),
                                 icon: .agent(backend.name), loading: loadingCatalog, failed: catalogError != nil) { openModelPanel() }
                    .disabled(locked).accessibilityIdentifier("newTaskModel")
                    .accessibilityLabel(String(localized: "模型：\(NativeConfigurationSummary.configuration(catalog: catalog, profileID: draft.profileID, selection: draft.model))", bundle: .riffet))
                    .accessibilityValue(catalogStatus)
                Spacer(minLength: 4)
                }
                if draft.uploading { ProgressView().controlSize(.small).padding(.trailing, 4) }
                RiffetSendButton(enabled: canStart && !voice.dictating) { Task { await start() } }
                    .accessibilityLabel(sending ? "正在开始" : draft.pendingCreationID == nil ? "开始任务" : "重试创建")
                    .accessibilityIdentifier("startTask")
                }
            }.padding(.leading, Self.toolsLeading).padding(.trailing, Self.toolsTrailing).padding(.bottom, 6)
        }
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.composerRadius, style: .continuous))
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { voice.hold.composerFrame = $0 }
    }
    /// The text field's room (`minHeight` plus its 16 above and 6 below) less the bar's insets.
    private var holdBarHeight: CGFloat { (tight ? 44 : 112) + 22 - Self.holdTop - (Self.holdTop - Self.sendInset) }
    /// The footer starts so the plus glyph (17pt, centred in its 40pt slot) sits on the text's left edge; the send
    /// button's circle sits `sendInset` inside its 44pt slot, and the row ends `toolsTrailing` in.
    private static let toolWidth: CGFloat = 40
    private static let toolsLeading: CGFloat = RiffetMetrics.groupInset - (toolWidth - 17) / 2
    private static let toolsTrailing: CGFloat = 4
    private static let sendInset: CGFloat = (RiffetMetrics.hitTarget - RiffetMetrics.sendButton) / 2
    private static let sendEdge: CGFloat = toolsTrailing + sendInset
    private static let holdTop: CGFloat = 12
    private func holdBar(height: CGFloat) -> some View {
        ComposerHoldBar(voice: voice, draft: draft, host: workbench.host, hasContent: !draft.text.isEmpty || hasAttachments,
                        height: height, unfocus: { writing = false })
    }
    /// One line above the card: the directory.
    private var slot: some View {
        ZStack(alignment: .leading) {
            if assistant == nil, !setupShown { projectLine.transition(.opacity) }
        }
        .frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget, alignment: .leading)
    }
    private var projectLine: some View {
        HStack(spacing: 0) {
            Button { writing = false; projects = true } label: {
                HStack(spacing: 6) {
                    Image(systemName: "folder").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg2)
                    Text(project?.name ?? String(localized: "选择项目", bundle: .riffet)).riffetFont(.headline).foregroundStyle(palette.fg).lineLimit(1).layoutPriority(1)
                }
                .padding(.horizontal, 4).frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
            }
            .buttonStyle(RiffetDimPressStyle())
            .disabled(hasAttachments || locked).accessibilityLabel("项目").accessibilityIdentifier("newTaskProject")
            Spacer(minLength: 8)
        }.buttonStyle(RiffetDimPressStyle())
    }
    private var citesFiles: Bool { assistant == nil && backend != .chat }
    private var citesSessions: Bool { catalog?.capabilities.supportsSessionReferences == true }
    /// A quick chat has no project files to cite and no commands or skills; it can still cite sessions.
    private func updateMenu(_ value: String) {
        guard draft.projectID != nil, let token = ComposerMenuToken.detect(in: value),
              token.kind == .slash ? backend != .chat : (citesFiles || citesSessions) else {
            if menu != nil { menu = nil }
            return
        }
        if menu != token { menu = token }
    }
    /// The plus menu's entries put the sigil in the draft, which opens the docked menu.
    private func insertTrigger(_ sigil: String) {
        if let last = draft.text.last, !last.isWhitespace { draft.text += " " }
        draft.text += sigil
        writing = true
    }
    @ViewBuilder private var menuDock: some View {
        if let menu, let projectID = draft.projectID, !setupShown {
            let backend = backend, profileID = draft.profileID
            ComposerMenuDock(workbench: workbench,
                             source: ComposerMenuSource(key: "\(backend.name)|\(projectID)|\(profileID ?? "")", projectID: projectID) {
                                 guard let api = workbench.api else { throw ClientFailure(String(localized: "未连接服务器", bundle: .riffet)) }
                                 return try await api.slashCatalog(backendId: backend, projectId: projectID, profileId: profileID, sessionId: nil, global: false).items
                             },
                             draft: draft, token: menu, allowsFiles: citesFiles, allowsSessions: citesSessions, picked: { writing = true })
                .padding(.bottom, 8).transition(.opacity)
        }
    }
    private var plusMenu: some View {
        Menu {
            Button("照片", systemImage: "photo") { photos = true }
            Button("文件", systemImage: "doc") { files = true }
            if citesFiles { Button("引用项目文件", systemImage: "at") { insertTrigger("@") } }
            if citesSessions {
                Button("引用会话", systemImage: "text.bubble") { insertTrigger("@") }
            }
            if backend != .chat { Button("命令与技能", systemImage: "slash.circle") { insertTrigger("/") } }
        } label: {
            Image(systemName: "plus").riffetFont(.barTitle, weight: .regular).foregroundStyle(palette.fg)
                .frame(width: Self.toolWidth, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
        }
        .disabled(project == nil || sending || draft.uploading || draft.pendingCreationID != nil).accessibilityLabel("添加")
    }
    private var attachmentChips: some View {
        @Bindable var draft = draft
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(draft.attachments, id: \.id) { attachment in
                    chip { Text(attachment.name).lineLimit(1) } remove: { draft.attachments.removeAll { $0.id == attachment.id } }
                }
                ForEach(draft.pendingFiles) { file in
                    Menu {
                        Button("重试上传") { if let project { Task { await draft.retry(workbench: workbench, projectID: project.id) } } }
                        Button("移除", role: .destructive) { draft.removePending(file.id) }
                    } label: {
                        Text(file.name).lineLimit(1).riffetFont(.caption).foregroundStyle(palette.danger).padding(.horizontal, 10)
                            .frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
                            .background { Capsule().fill(palette.press).frame(height: RiffetMetrics.chipHeight - 4) }
                    }
                }
                ForEach(Array(draft.references.enumerated()), id: \.offset) { _, reference in
                    chip {
                        if reference.kind == "session", let id = reference.sessionId {
                            Button { draft.save(); onOpenSession(id) } label: {
                                Label(reference.title ?? id, systemImage: "text.bubble").lineLimit(1)
                                    .frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        } else { Text("@\(reference.path)").lineLimit(1) }
                    } remove: { draft.references.removeAll { $0 == reference } }
                }
            }.padding(.horizontal, 12)
        }.disabled(locked)
    }
    private func chip<Content: View>(@ViewBuilder _ content: () -> Content, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 0) {
            content().padding(.leading, 10)
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(palette.fg3)
                    .frame(minWidth: RiffetMetrics.hitTarget, minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
            }
            .accessibilityLabel("移除")
        }
        .riffetFont(.caption).foregroundStyle(palette.fg2)
        .frame(minHeight: RiffetMetrics.hitTarget)
        .background { Capsule().fill(palette.press).frame(height: RiffetMetrics.chipHeight - 4) }
    }
    /// Catalog, draft and recovery notes sit under the card.
    @ViewBuilder private var notes: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let reason = catalog?.reason, catalog?.available == false { RiffetNotice(kind: .warning, message: reason, boxed: true) }
            if let error = draft.error { RiffetNotice(kind: .error, message: error, boxed: true) }
            if draft.pendingCreationID != nil {
                RiffetNotice(kind: .info, message: String(localized: "上次提交尚未取得确认。重试会使用同一个请求，不会重新创建任务。", bundle: .riffet),
                             actionTitle: String(localized: "停止跟踪这次提交", bundle: .riffet), action: { if !sending { discardPending = true } }, boxed: true)
            }
        }
        .padding(.top, 8)
    }
    /// Terminal tools under the card, as on web: two equal cards, or the import alone without a project.
    private var toolCards: some View {
        HStack(spacing: 10) {
            if let project {
                NavigationLink { TerminalPage(workbench: workbench, projectID: project.id).modifier(PushedPageTabBar()) } label: { toolCard("终端", symbol: "terminal") }
            }
            Button { writing = false; importing = true } label: { toolCard("继续终端会话", symbol: "clock.arrow.circlepath") }.disabled(locked)
        }.buttonStyle(RiffetDimPressStyle())
    }
    /// 记忆, 规则 and 能力 under the composer, before the assistant has a conversation.
    private var assistantCards: some View {
        HStack(spacing: 10) {
            ForEach([AssistantPage.memory, .rules, .abilities]) { page in
                Button { writing = false; assistantPage = page } label: { toolCard(LocalizedStringKey(page.title), symbol: page.symbol) }
            }
        }.buttonStyle(RiffetDimPressStyle())
    }
    private func toolCard(_ title: LocalizedStringKey, symbol: String) -> some View {
        let shape = RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous)
        return HStack(spacing: 12) {
            SettingsIcon(symbol: symbol)
            Text(title).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, RiffetMetrics.groupInset).frame(maxWidth: .infinity, minHeight: RiffetMetrics.settingsRowHeight, alignment: .leading)
        .background(palette.bgSubtle, in: shape)
        .contentShape(shape)
    }
    private var catalogStatus: String { loadingCatalog ? String(localized: "正在加载", bundle: .riffet) : catalogError ?? "" }
    private func loadCatalog(reload: Bool = false) async {
        guard let projectID = draft.projectID, !projectID.isEmpty else {
            loadedCatalog = nil; catalogError = nil; loadingCatalog = false
            return
        }
        if draft.profileID == nil, draft.model == nil,
           let savedProfile = settings?.nativeBackendDefaults?[backend]?.profileId,
           workbench.backends.first(where: { $0.backendId == backend })?.profiles.contains(where: { $0.id == savedProfile }) == true {
            draft.profileID = savedProfile
            return // The context-key task restarts for the saved provider before loading its catalog.
        }
        let key = contextKey
        // A cached answer replaces the previous context's at once; only a real read shows loading.
        if !reload, let cached = workbench.cachedCatalog(backend, profileID: draft.profileID, projectID: projectID) {
            if loadedCatalog !== cached { loadedCatalog = cached }
            loadingCatalog = false; catalogError = nil
        } else {
            loadingCatalog = true; catalogError = nil
        }
        do {
            guard let loaded = try await workbench.loadCatalog(backend, profileID: draft.profileID, projectID: projectID, reload: reload) else {
                throw ClientFailure(String(localized: "Mac 未返回此 Agent 的模型与配置，请重试读取。", bundle: .riffet))
            }
            guard contextKey == key else { return }
            if draft.profileID == nil, draft.model == nil,
               let savedProfile = settings?.nativeBackendDefaults?[backend]?.profileId,
               loaded.profiles.contains(where: { $0.id == savedProfile }) {
                draft.profileID = savedProfile; loadingCatalog = false
                return
            }
            loadedCatalog = loaded; loadingCatalog = false
            // Picks the catalog still offers stay; the rest follow the defaults.
            let choice = NativeConfigurationSummary.choice(catalog: loaded, draft: draft, settings: settings)
            if draft.model != choice.model { draft.model = choice.model }
            if draft.mode != choice.mode { draft.mode = choice.mode }
            if draft.approval != choice.approval { draft.approval = choice.approval }
        } catch is CancellationError {
            if contextKey == key { loadingCatalog = false }
        } catch {
            guard contextKey == key else { return }
            catalogError = error.riffetMessage; loadedCatalog = nil; loadingCatalog = false
        }
    }
    private func picked(_ result: Result<[ImportedAttachment], Error>) {
        switch result {
        case let .success(files): if let project { Task { await draft.add(files: files, workbench: workbench, projectID: project.id) } }
        case let .failure(error): draft.error = error.riffetMessage
        }
    }
    private func start() async {
        guard !sending else { return }
        sending = true; draft.error = nil
        defer { sending = false }
        do {
            let request: PendingSessionCreation
            if let id = draft.pendingCreationID, let saved = try workbench.store.pendingCreation(id: id) {
                request = saved
            } else {
                guard let project, draft.canSend, let catalog, catalog.available else { return }
                let choice = NativeConfigurationSummary.choice(catalog: catalog, draft: draft, settings: settings)
                request = try workbench.store.prepareMemberCreation(agentMemberId: member?.id, projectId: project.id, prompt: draft.text, attachments: draft.attachments,
                    backendId: backend, backendProfileId: draft.profileID, model: draft.model,
                    mode: choice.mode, approval: choice.approval, context: draft.references, agentId: nil,
                    toolGroups: phonesShown ? pickedTools : nil,
                    extensionsOff: extensions != nil && !extensionsOff.isEmpty ? extensionsOff : nil)
                draft.pendingCreationID = request.id
            }
            prewarm.sent()
            let session: Session
            do { session = try await workbench.store.createPreparedSession(request: request) }
            catch { prewarm.sendFailed(); throw error }
            let input = request.body.initialMessage
            let ids = Set(input?.attachments?.map(\.id) ?? [])
            draft.clear(sentText: input?.text ?? "", sentAttachments: draft.attachments.filter { ids.contains($0.id) }, sentReferences: draft.references)
            draft.save()
            try workbench.store.acknowledgePreparedCreation(id: request.id)
            draft.pendingCreationID = nil
            writing = false
            // Every device opens the assistant's composer on what this one started with.
            if let member, let api = workbench.api {
                if let saved = try? await api.rememberMemberTarget(id: member.id, backendId: backend.name.lowercased(), profileId: draft.profileID, model: draft.model) {
                    workbench.store.applyTeamMember(member: saved)
                }
            } else if assistant != nil, let api = workbench.api {
                if let saved = try? await api.rememberAssistant(backendId: backend, profileId: draft.profileID, model: draft.model) {
                    workbench.store.applySavedSettings(settings: saved)
                }
            }
            onStart(session)
        } catch { draft.error = error.riffetMessage }
    }
}


/// The mark, the line with the card, and what hangs below, in a page at least one viewport tall. The
/// line and the card are centred on their own, so what is below them never moves them; the room
/// above holds the mark, up to 104pt, hidden when under 56pt or while folded away.
struct NewTaskLayout: Layout {
    var minHeight: CGFloat
    var markShown: Bool
    private func heights(_ width: CGFloat, _ subviews: Subviews) -> (anchor: CGFloat, below: CGFloat) {
        let proposal = ProposedViewSize(width: width, height: nil)
        return (subviews[1].sizeThatFits(proposal).height, subviews[2].sizeThatFits(proposal).height)
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        let (anchor, below) = heights(width, subviews)
        let top = max(0, (minHeight - anchor) / 2)
        return CGSize(width: width, height: max(minHeight, top + anchor + below))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (anchor, below) = heights(bounds.width, subviews)
        let top = max(0, (minHeight - anchor) / 2)
        let room = top - 24
        let side = markShown && room >= 56 ? min(104, room) : 0
        subviews[0].place(at: CGPoint(x: bounds.midX, y: bounds.minY + (top - side) / 2), anchor: .top,
                          proposal: ProposedViewSize(width: side, height: side))
        subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.minY + top), anchor: .topLeading,
                          proposal: ProposedViewSize(width: bounds.width, height: anchor))
        subviews[2].place(at: CGPoint(x: bounds.minX, y: bounds.minY + top + anchor), anchor: .topLeading,
                          proposal: ProposedViewSize(width: bounds.width, height: below))
    }
}
