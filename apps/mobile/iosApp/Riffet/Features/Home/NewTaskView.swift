import SwiftUI
import RiffetKit

/// The new-session page's two launch targets; the pick is remembered across launches.
enum NewSessionTab: String {
    case task, chat
    static let storageKey = "riffet.ios.new-session-tab"
}

struct NewTaskView: View {
    let workbench: Workbench
    let onStart: (Session) -> Void
    /// Opens an existing session (one referenced from this page) in the same stack.
    var onOpenSession: (String) -> Void = { _ in }
    /// Set for the assistant's page: its project, its own draft and choice of agent, and its setup cards in place of the terminal tools.
    var assistant: AssistantSetup? = nil
    @State private var assistantPage: AssistantPage?
    @State private var projects = false
    @State private var browsing = false
    @State private var directories = false
    @AppStorage(NewSessionTab.storageKey) private var tabRaw = NewSessionTab.task.rawValue
    @State private var promptExpanded = false
    @State private var options: SessionOptionFocus?
    @State private var files = false
    @State private var photos = false
    @State private var references = false
    @State private var sessionReferences = false
    @State private var commands = false
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
    @Environment(\.palette) private var palette
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSize
    private var compact: Bool { verticalSize == .compact }
    private var markHidden: Bool { writing || compact }
    /// The server's quick-chat project; the switch only exists while there is one.
    private var chatProject: Project? { workbench.list.projects.first { $0.isQuickChat && $0.archivedAt == nil } }
    private var chat: Bool { assistant == nil && tabRaw == NewSessionTab.chat.rawValue && chatProject != nil }
    /// Quick chat and the assistant each keep their own draft, apart from the task's.
    private var draft: MessageDraft { workbench.drafts.draft(assistant != nil ? "assistant" : chat ? "chat" : "new") }
    /// The settings the composer's defaults come from: the assistant's own choice stands in for the agent's.
    private var settings: AppSettings? {
        assistant != nil ? AssistantKt.assistantSettings(settings: workbench.settings, backends: workbench.backends) : workbench.settings
    }
    private var catalog: NativeBackendCatalogEntry? { loadedCatalog.flatMap { $0.backendId == backend ? $0 : nil } }
    private var backend: NativeBackendId {
        if chat { return .chat }
        // The assistant runs only on the agents that isolate it; a draft's other agent gives way to its own.
        return workbench.backends.first { $0.backendId.name == draft.backendName && (assistant == nil || AssistantKt.isAssistantBackend(id: $0.backendId)) }?.backendId ?? settings?.defaultBackendId ?? .cursor
    }
    private var project: Project? {
        assistant != nil ? workbench.assistantProject : workbench.projects.first { $0.id == draft.projectID }
    }
    /// What a warm CLI is held for: only an Agent that keeps one (Cursor) asks for it.
    private var prewarmBody: PrewarmBody? {
        guard !chat, let project, let catalog, catalog.capabilities.supportsPrewarm?.boolValue == true else { return nil }
        let choice = NativeConfigurationSummary.choice(catalog: catalog, draft: draft, settings: settings)
        return PrewarmBody(projectId: project.id, backendId: backend, backendProfileId: draft.profileID, model: draft.model,
                           mode: choice.mode, approval: choice.approval, agentId: nil, claimId: nil)
    }
    private var toolsKey: String { "riffet.ios.\(workbench.baseURL.absoluteString).tool-groups" }
    /// The last pick on this device; only the phones online now are shown and sent.
    private var rememberedTools: [String] { remembered ?? ToolGroups.shared.decode(raw: UserDefaults.standard.string(forKey: toolsKey)) }
    private var pickedTools: [String] { ToolsPick.offeredPicks(devices: toolDevices.devices, value: rememberedTools, plugins: toolDevices.plugins) }
    private var phonesShown: Bool {
        catalog?.capabilities.supportsRiffetTools == true && backend != .chat && ToolsPick.offered(devices: toolDevices.devices, value: [], plugins: toolDevices.plugins)
    }
    private var extensions: ExtensionsPick? {
        ExtensionsPick.make(workbench: workbench, allowed: backend != .chat, capabilities: catalog?.capabilities, backendId: backend,
                            profileId: draft.profileID, projectId: draft.projectID, off: extensionsOff,
                            onChange: { extensionsOff = ExtensionsOff.shared.clean(value: $0) })
    }
    private var extensionsKey: String { "\(backend.name)|\(draft.profileID ?? "")|\(draft.projectID ?? "")" }
    /// 对话 and the server's presets; a server that predates presets lists the chat catalog's modes.
    private var chatModes: [(id: String, label: String, prompt: String?)] {
        if let presets = workbench.settings?.quickChat?.presets {
            return [("agent", String(localized: "对话", bundle: .riffet), nil)] + presets.map { ("preset:" + $0.id, $0.name, $0.prompt) }
        }
        return (catalog?.capabilities.modes ?? []).map { ($0.id, $0.label, $0.description_) }
    }
    private var chatMode: String { chatModes.contains { $0.id == draft.mode } ? draft.mode ?? "agent" : "agent" }
    /// The model of the most recently active quick chat, offered when no default is saved.
    private var recentChatModel: String? {
        guard let id = chatProject?.id else { return nil }
        func activity(_ session: Session) -> Date { ServerTime.date(session.lastActivityAt ?? session.createdAt) ?? .distantPast }
        return workbench.list.sessions.filter { $0.projectId == id && $0.backendId == .chat && !($0.model ?? "").isEmpty }
            .max { activity($0) < activity($1) }?.model
    }
    /// What the next quick chat starts with: a pick the catalog still offers, else the saved model, the latest chat's, the default.
    private var chatChoice: NewSessionChoice? {
        guard chat, let catalog else { return nil }
        let recent = draft.model == nil && workbench.settings?.auxiliaryModels?.chat == nil ? recentChatModel : nil
        return NewSessionDraft(profileId: nil, model: draft.model ?? recent, mode: draft.mode, approval: nil)
            .resolve(catalog: catalog, saved: workbench.settings?.nativeBackendDefaults?[catalog.backendId], cursorModel: workbench.settings?.defaultModel, listed: nil)
    }
    private var shownModel: String? { chat ? chatChoice?.model : draft.model }
    private func pickTools(_ groups: [String]) {
        remembered = ToolGroups.shared.picks(groups: groups)
        UserDefaults.standard.set(ToolGroups.shared.encode(groups: groups), forKey: toolsKey)
    }
    private var contextKey: String { "\(backend.name)|\(draft.profileID ?? "")|\(draft.projectID ?? "")|\(workbench.list.backendRevision)" }
    var body: some View {
        @Bindable var draft = draft
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
                        // The line and the card are what stays put across 新建任务 and 快速对话; what differs hangs below.
                        VStack(alignment: .leading, spacing: 0) {
                            slot.riffetTypeBoundary()
                            if let assistant {
                                AssistantPackEntries(packs: assistant.packs) { entry in
                                    draft.text = AssistantPackEntries.draft(entry, typed: draft.text)
                                    writing = true
                                }
                                .padding(.horizontal, -RiffetMetrics.pageInset)
                            }
                            card.riffetTypeBoundary()
                        }
                        .padding(.horizontal, RiffetMetrics.pageInset).padding(.top, compact ? 4 : 8)
                        VStack(alignment: .leading, spacing: 0) {
                            if chat { presetPrompt.riffetTypeBoundary() }
                            notes.riffetTypeBoundary()
                            if !chat { (assistant != nil ? AnyView(assistantCards) : AnyView(toolCards)).padding(.top, 12).riffetTypeBoundary() }
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
        .navigationTitle(assistant != nil ? String(localized: "个人助理", bundle: .riffet) : String(localized: "新会话", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The switch is the page's heading, as Android keeps its tabs in the top bar: one header, not two.
            if chatProject != nil, assistant == nil { ToolbarItem(placement: .principal) { tabSwitch } }
            if !chat, assistant == nil, let project {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    NavigationLink { ProjectFilesView(workbench: workbench, project: project) } label: { Image(systemName: "doc") }
                        .accessibilityLabel(String(localized: "文件", bundle: .riffet))
                    NavigationLink { ProjectChangesView(workbench: workbench, project: project) } label: { Image(systemName: "arrow.triangle.branch") }
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
        .sheet(item: $options) { focus in
            NavigationStack { NewTaskOptions(workbench: workbench, draft: draft, catalog: catalog, backend: backend,
                loading: loadingCatalog, error: catalogError, retry: { Task { await loadCatalog(reload: true) } }, focus: focus,
                toolDevices: toolDevices.devices, toolPlugins: toolDevices.plugins, toolGroups: pickedTools, onPickTools: pickTools, extensions: extensions,
                quickChat: chat, selectedModel: chatChoice?.model, assistant: assistant != nil).toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { options = nil } }
            } }
        }
        .sheet(isPresented: $files) { DocumentAttachmentPicker { picked($0); files = false } }
        .sheet(isPresented: $photos) { PhotoAttachmentPicker { picked($0); photos = false } }
        .attachmentDrop(enabled: project != nil && !sending && !draft.uploading && draft.pendingCreationID == nil, picked)
        .sheet(isPresented: $references) { if let project { ConversationReferencePicker(workbench: workbench, projectID: project.id) { entry in
            if !draft.references.contains(where: { $0.path == entry.path }) { draft.references.append(PromptContextReference(path: entry.path, line: nil, kind: nil, sessionId: nil, fromRunId: nil, title: nil)) }
            references = false
        } } }
        .sheet(isPresented: $sessionReferences) {
            ConversationSessionReferencePicker(workbench: workbench, currentSessionID: nil, projectID: draft.projectID) { selected in
                guard draft.references.filter({ $0.kind == "session" }).count < 5 else { draft.error = String(localized: "最多引用 5 个会话", bundle: .riffet); return }
                if !draft.references.contains(where: { $0.sessionId == selected.id }) { draft.references.append(sessionReference(session: selected)) }
                if let range = draft.text.range(of: #"(?:^|\s)@[^\s@]*$"#, options: .regularExpression) {
                    let leading = draft.text[range].prefix { $0 != "@" }
                    draft.text.replaceSubrange(range, with: String(leading))
                }
                sessionReferences = false
            }
        }
        .sheet(isPresented: $commands) { NewTaskSlashPicker(workbench: workbench, backend: backend, projectID: draft.projectID, profileID: draft.profileID) { item in
            draft.text = "/\(item.name) " + draft.text; commands = false
        } }
        .confirmationDialog("停止跟踪这次提交？", isPresented: $discardPending, titleVisibility: .visible) {
            Button("停止跟踪", role: .destructive) {
                do { if let id = draft.pendingCreationID { try workbench.store.discardPreparedCreation(id: id) }; draft.pendingCreationID = nil }
                catch { draft.error = error.riffetMessage }
            }
        } message: { Text("任务可能已创建，请先查看会话列表") }
        .task {
            // Each draft tracks its own unconfirmed submission; one that belongs to the quick-chat project goes to the chat draft.
            let task = workbench.drafts.draft("new"), quick = workbench.drafts.draft("chat")
            do {
                for entry in [task, quick] {
                    if let id = entry.pendingCreationID, try workbench.store.pendingCreation(id: id) == nil { entry.pendingCreationID = nil }
                }
                let claimed = Set([task, quick].compactMap(\.pendingCreationID))
                if let open = try workbench.store.pendingCreations().first(where: { !claimed.contains($0.id) }) {
                    let target = open.body.projectId != nil && open.body.projectId == chatProject?.id ? quick : task
                    if target.pendingCreationID == nil { target.pendingCreationID = open.id }
                }
            } catch { draft.error = error.riffetMessage }
            if draft.backendName == nil { draft.backendName = backend.name }
            // Project and model are choices the user makes before opening the keyboard.
        }
        .task(id: contextKey) { await loadCatalog() }
        .onAppear { prewarm.hold(api: workbench.api, body: prewarmBody) }
        .onChange(of: prewarmBody) { _, body in prewarm.hold(api: workbench.api, body: body) }
        .onDisappear { prewarm.close() }
        .onChange(of: project?.id, initial: true) { _, id in
            if assistant != nil, let id, draft.projectID != id { draft.projectID = id }
        }
        .onChange(of: chatProject?.id, initial: true) { _, id in
            let quick = workbench.drafts.draft("chat")
            if quick.projectID != id { quick.projectID = id }
            if id != nil, quick.backendName != NativeBackendId.chat.name { quick.backendName = NativeBackendId.chat.name }
        }
        .onChange(of: chatMode) { _, _ in promptExpanded = false }
        .onChange(of: extensionsKey) { _, _ in extensionsOff = [] }
        .readsToolDevices(toolDevices, workbench: workbench, enabled: catalog?.capabilities.supportsRiffetTools == true)
    }
    private var locked: Bool { sending || draft.pendingCreationID != nil }
    private var hasAttachments: Bool { !draft.attachments.isEmpty || !draft.pendingFiles.isEmpty || !draft.references.isEmpty }
    private var canStart: Bool {
        !sending && (draft.pendingCreationID != nil || (draft.canSend && project != nil && !loadingCatalog && catalog?.available == true))
    }
    private func openOptions(_ focus: SessionOptionFocus) {
        guard !sending, draft.pendingCreationID == nil else { return }
        writing = false
        // Publish the TextEditor focus teardown before requesting another UIKit
        // presentation, without inserting a wall-clock delay into the interaction.
        Task { @MainActor in
            await Task.yield()
            guard !sending, draft.pendingCreationID == nil else { return }
            options = focus
        }
    }

    /// Input, attachments and the send row in one card.
    private var card: some View {
        @Bindable var draft = draft
        return VStack(alignment: .leading, spacing: 0) {
            TextField(chat || assistant != nil ? LocalizedStringKey("发送消息…") : LocalizedStringKey("描述任务"), text: $draft.text, axis: .vertical)
                .riffetFont(.body).lineLimit(compact ? 2...6 : 4...14).focused($writing)
                .frame(minHeight: compact ? 44 : 112, alignment: .topLeading)
                .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 6)
                .accessibilityLabel("任务内容").accessibilityIdentifier("newTaskText").disabled(locked)
                .onChange(of: draft.text) { _, value in
                    if catalog?.capabilities.supportsSessionReferences == true,
                       value.range(of: #"(?:^|\s)@[^\s@]*$"#, options: .regularExpression) != nil { sessionReferences = true }
                }
            if hasAttachments { attachmentChips.padding(.bottom, 4) }
            HStack(spacing: 0) {
                plusMenu
                // The settings follow the attach button, as on Android; the send button keeps the far edge.
                RiffetModelLabel(title: NativeConfigurationSummary.shortModel(catalog: catalog, selection: shownModel),
                                 icon: chat ? .symbol("bubble.left") : .agent(backend.name), loading: loadingCatalog, failed: catalogError != nil) { openOptions(chat ? .model : .all) }
                    .disabled(locked).accessibilityIdentifier("newTaskModel")
                    .accessibilityLabel(String(localized: "模型：\(NativeConfigurationSummary.configuration(catalog: catalog, profileID: draft.profileID, selection: shownModel))", bundle: .riffet))
                    .accessibilityValue(catalogStatus)
                Spacer(minLength: 4)
                if draft.uploading { ProgressView().controlSize(.small).padding(.trailing, 4) }
                RiffetSendButton(enabled: canStart) { Task { await start() } }
                    .accessibilityLabel(sending ? "正在开始" : draft.pendingCreationID == nil ? "开始任务" : "重试创建")
                    .accessibilityIdentifier("startTask")
            }.padding(.horizontal, 8).padding(.bottom, 6)
        }
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.composerRadius, style: .continuous))
    }
    /// 新建任务 / 快速对话 in the navigation bar, where the page title would be.
    private var tabSwitch: some View {
        Picker("", selection: Binding(get: { chat ? NewSessionTab.chat : .task },
                                      set: { value in withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { tabRaw = value.rawValue } })) {
            Text("新建任务").tag(NewSessionTab.task)
            Text("快速对话").tag(NewSessionTab.chat)
        }
        .pickerStyle(.segmented).frame(width: 220)
        .disabled(locked)
    }
    /// One line above the card, the same height for both targets: the directory, or the chat modes.
    private var slot: some View {
        ZStack(alignment: .leading) {
            if chat {
                if chatModes.count > 1 {
                    RiffetChipBar(items: chatModes.map { .init(value: $0.id, title: $0.label) },
                                  selection: Binding(get: { chatMode }, set: { draft.mode = $0 }))
                        .padding(.horizontal, -RiffetMetrics.pageInset).disabled(locked).transition(.opacity)
                }
            } else if assistant == nil {
                projectLine.transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, minHeight: RiffetMetrics.hitTarget, alignment: .leading)
        .riffetAnimation(RiffetMotion.spatial, value: chat)
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
    /// The selected preset's prompt, quiet under the card; a tap shows all of it.
    @ViewBuilder private var presetPrompt: some View {
        if let prompt = chatModes.first(where: { $0.id == chatMode && $0.id != "agent" })?.prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(prompt).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(promptExpanded ? nil : 2)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4).padding(.top, 8)
                .contentShape(Rectangle()).onTapGesture { withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { promptExpanded.toggle() } }
        }
    }
    private var plusMenu: some View {
        Menu {
            Button("照片", systemImage: "photo") { photos = true }
            Button("文件", systemImage: "doc") { files = true }
            if !chat {
                if assistant == nil { Button("引用项目文件", systemImage: "at") { references = true } }
                if catalog?.capabilities.supportsSessionReferences == true {
                    Button("引用会话", systemImage: "text.bubble") { sessionReferences = true }
                }
                Button("命令与技能", systemImage: "slash.circle") { commands = true }
            }
        } label: {
            Image(systemName: "plus").riffetFont(.barTitle, weight: .regular).foregroundStyle(palette.fg)
                .frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
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
                NavigationLink { TerminalPage(workbench: workbench, projectID: project.id) } label: { toolCard("终端", symbol: "terminal") }
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
            // Quick chat resolves its picks on read (`chatChoice`), so the latest chat's model is not frozen into the draft.
            if chat { return }
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
                if chat {
                    let model = chatChoice?.model
                    request = try workbench.store.prepareCreation(projectId: project.id, prompt: draft.text, attachments: draft.attachments,
                        backendId: .chat, backendProfileId: nil, model: model?.isEmpty == false ? model : nil,
                        mode: chatMode, approval: nil, context: [], agentId: nil, toolGroups: nil, extensionsOff: nil)
                } else {
                    let choice = NativeConfigurationSummary.choice(catalog: catalog, draft: draft, settings: settings)
                    request = try workbench.store.prepareCreation(projectId: project.id, prompt: draft.text, attachments: draft.attachments,
                        backendId: backend, backendProfileId: draft.profileID, model: draft.model,
                        mode: choice.mode, approval: choice.approval, context: draft.references, agentId: nil,
                        toolGroups: phonesShown ? pickedTools : nil,
                        extensionsOff: extensions != nil && !extensionsOff.isEmpty ? extensionsOff : nil)
                }
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
            if assistant != nil, let api = workbench.api {
                if let saved = try? await api.rememberAssistant(backendId: backend, profileId: draft.profileID, model: draft.model) {
                    workbench.store.applySavedSettings(settings: saved)
                }
            }
            onStart(session)
        } catch { draft.error = error.riffetMessage }
    }
}

private struct NewTaskSlashPicker: View {
    let workbench: Workbench
    let backend: NativeBackendId
    let projectID: String?, profileID: String?
    let choose: (NativeSlashItem) -> Void
    @State private var items: [NativeSlashItem] = []
    @State private var error: String?
    @State private var loading = true
    @Environment(\.palette) private var palette
    var body: some View {
        NavigationStack {
            List {
                if loading { ProgressView() }
                RiffetNotice.section(.error, error)
                ForEach(items, id: \.name) { item in Button { choose(item) } label: { VStack(alignment: .leading) { Text("/\(item.name)").riffetFont(.body).foregroundStyle(palette.fg); if let text = item.description_ { Text(text).riffetFont(.caption).foregroundStyle(palette.fg3) } } } }
            }.navigationTitle(String(localized: "命令与技能", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            .task {
                defer { loading = false }
                do { items = try await workbench.api?.slashCatalog(backendId: backend, projectId: projectID, profileId: profileID, sessionId: nil, global: false).items ?? [] }
                catch { self.error = error.riffetMessage }
            }
        }
    }
}

/// The mark, the line with the card, and what hangs below, in a page at least one viewport tall. The
/// line and the card are centred on their own, so what is below them never moves them; the room
/// above holds the mark, up to 104pt, hidden when under 56pt or while folded away.
private struct NewTaskLayout: Layout {
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
