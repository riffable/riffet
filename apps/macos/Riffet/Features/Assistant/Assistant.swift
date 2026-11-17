import AppKit
import SwiftUI
import RiffetKit

/// The 个人助理 (docs/ASSISTANT.md §3): a sidebar destination that opens its one standing conversation,
/// or an empty page while there is none. The conversation is an ordinary one in the assistant's
/// project; what differs on its page is `Workbench.assistantContext` and `isAssistantMain`.
extension Workbench {
    /// The assistant's own project, which is never listed as a project.
    var assistantProject: Project? { projectList.first { $0.isAssistant && $0.archivedAt == nil } }

    /// The standing conversation, when the project names one that is still in the list and not archived.
    var assistantMain: Session? {
        guard let project = assistantProject, let id = assistant.mainSessionId else { return nil }
        return list.sessions.first { $0.id == id && $0.projectId == project.id && $0.archivedAt == nil }
    }

    func isAssistantSession(_ session: Session) -> Bool { project(session.projectId)?.isAssistant == true }

    func isAssistantMain(_ session: Session) -> Bool {
        session.id == assistant.mainSessionId && isAssistantSession(session)
    }

    /// A conversation of the assistant's directory is on screen: nothing about project code applies to it.
    var assistantContext: Bool {
        guard !showingHome, page == nil, let selected else { return false }
        return isAssistantSession(selected)
    }

    /// The assistant page is open: its empty state, or its main conversation.
    var onAssistantPage: Bool {
        if page == .assistant { return true }
        guard page == nil, !showingHome, let selected else { return false }
        return isAssistantMain(selected)
    }

    /// The side panel has nothing to show: a quick chat, or an assistant conversation without plugin views.
    var inspectorUnavailable: Bool { quickChatContext || (assistantContext && inspectorViews.isEmpty) }

    /// Opens the main conversation, or the empty page while there is none. [excluding] is a
    /// conversation just left for good (archived), which the list may still show as open.
    func openAssistant(excluding: String? = nil) {
        if role == .window {
            showInMain { $0.openAssistant(excluding: excluding) }
            return
        }
        if let main = assistantMain, main.id != excluding {
            open(main)
            Task { await assistant.refresh() }
            return
        }
        page = .assistant
        Task {
            await assistant.refresh()
            if page == .assistant, let main = assistantMain, main.id != excluding { open(main) }
        }
    }

    /// Opens [destination], which for the assistant is its conversation rather than a page.
    func show(_ destination: WorkbenchPage) {
        if destination == .assistant { openAssistant() } else { page = destination }
    }
}

/// The status mark at the end of the 个人助理 row: what a session row shows for its conversation.
struct AssistantStatusMark: View {
    let workbench: Workbench
    @Environment(\.palette) private var palette

    var body: some View {
        let main = workbench.assistantMain
        let sessionIds = workbench.list.sessions.filter { $0.projectId == workbench.assistantProject?.id }.map(\.id)
        Group {
            if let main {
                if SessionStatePill.shows(main.state) {
                    SessionStatePill(state: main.state)
                } else if SessionStatePill.running(main.state) {
                    Spinner(size: .mini).help("运行中").accessibilityLabel("运行中")
                } else if UnreadStore.shared.isUnread(main) {
                    Circle().fill(palette.fg).frame(width: 6, height: 6).accessibilityLabel("未读")
                }
            }
        }
        // A conversation made on another device, or archived here, changes which one the project names.
        .task(id: sessionIds) { await workbench.assistant.refresh() }
    }
}

// MARK: Empty state

/// The 个人助理 page while there is no main conversation: its composer, then 记忆, 规则 and 能力
/// (`AssistantSetup.tsx`). The first message creates the conversation in the assistant's project,
/// where the server makes it the main one.
struct AssistantPage: View {
    @Bindable var workbench: Workbench
    @Environment(\.palette) private var palette
    private var composer: ComposerModel { workbench.pageModels.composers.model(for: "assistant") }
    @State private var backend = ""
    @State private var profileId: String?
    @State private var model: String?
    @State private var approval: String?
    @State private var catalog: NativeBackendCatalogEntry?
    @State private var loadedKey: String?
    @State private var catalogError: String?
    @State private var creating = false
    @State private var error: String?
    @State private var setup = AssistantSetup()

    private var project: Project? { workbench.assistantProject }
    private var catalogKey: String { "\(backend)|\(profileId ?? "")|\(project?.id ?? "")|\(workbench.backendRevision)|\(workbench.catalogs.connectionRevision)" }
    private var currentCatalog: NativeBackendCatalogEntry? {
        loadedKey == catalogKey ? catalog : workbench.catalogs.cached(backend, profileId: profileId, projectId: project?.id)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(spacing: Space.lg) {
                    LiveBrandMark(front: palette.fg, back: palette.fg4).frame(width: 52, height: 52)
                    Text("个人助理")
                        .font(RiffetFont.text(RiffetTextSize.x2xl, weight: .medium))
                        .foregroundStyle(palette.fg)
                        .frame(minHeight: Space.xxl)
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, Space.xl)
                composerSection
                cards.padding(.top, Space.xxl)
            }
            .frame(maxWidth: 720)
            .padding(.horizontal, Column.gutter)
            .padding(.top, Space.xxl * 2)
            .padding(.bottom, Space.xxl)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .navigationTitle(WorkbenchPage.assistant.title)
        .pageChrome(.assistant, workbench: workbench)
        .onAppear { applyChoice(); Task { await setup.load(workbench) } }
        .onChange(of: workbench.backends.map(\.agent)) { _, _ in if backend.isEmpty { applyChoice() } }
        .onChange(of: workbench.assistant.saved) { _, _ in if backend.isEmpty { applyChoice() } }
        .task(id: catalogKey) { await loadCatalog() }
        .onDisappear { composer.flushDraft() }
        .assistantSetupSheets(setup, workbench: workbench)
    }

    // MARK: Composer

    private var composerSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            AssistantEntries(workbench: workbench, composer: composer)
                .padding(.bottom, Space.sm)
            ComposerView(
                model: composer,
                placeholder: String(localized: "发送消息…"),
                working: false,
                sendState: nil,
                minLines: 3,
                features: ComposerFeatures(enterSends: workbench.settings?.composerEnterBehavior == "send", menuBelow: true),
                sendEnabled: !creating && project != nil && currentCatalog?.available != false,
                busy: creating,
                onSend: { _ in send() },
                onStop: nil,
                upload: { file in try await workbench.upload(file, projectId: project?.id) }
            ) {
                if let catalog = currentCatalog ?? catalog,
                   catalog.capabilities.supportsPermissionSelection, !catalog.capabilities.permissions.isEmpty {
                    OptionMenu(title: String(localized: "审批"), options: catalog.capabilities.permissions, selection: approval ?? catalog.capabilities.permissions.first?.id ?? "") { approval = $0 }
                        .equatable()
                }
            } trailing: {
                agentMenu
                if let catalog = currentCatalog ?? catalog, catalog.capabilities.supportsModelSelection {
                    ModelControls(
                        catalog: catalog.models,
                        selection: effectiveModel,
                        loading: currentCatalog == nil,
                        scope: catalogKey,
                        refresh: { await loadCatalog(reload: true) }
                    ) { value in
                        model = value
                        saveChoice()
                    }
                    .id(catalogKey)
                }
            }
            status
                .font(RiffetFont.caption)
                .padding(.top, Space.sm)
                .padding(.leading, Space.xs)
        }
    }

    @ViewBuilder
    private var status: some View {
        if let catalog = currentCatalog, !catalog.available {
            Label(catalog.reason ?? String(localized: "\(catalog.label) 当前不可用"), icon: "exclamationmark.triangle").foregroundStyle(palette.danger)
        } else if let error {
            Label(error, icon: "xmark.octagon").foregroundStyle(palette.danger)
        } else if let catalogError {
            HStack(spacing: Space.sm) {
                Text("模型列表加载失败：\(catalogError)").foregroundStyle(palette.danger).lineLimit(3)
                Button("重试") { Task { await loadCatalog(reload: true) } }.buttonStyle(ChipButtonStyle())
            }
        }
    }

    /// The agent and, when it has several, its provider: the choice the assistant is started with.
    @ViewBuilder
    private var agentMenu: some View {
        let entries = workbench.backends.filter { assistantAgents.contains($0.agent) }
        NativeChipMenu(text: entries.first { $0.agent == backend }?.label ?? backendLabel(backend), symbol: "sparkle") {
            [.header("Agent")] + entries.map { entry in
                .item(entry.label, subtitle: entry.available ? nil : entry.reason, checked: entry.agent == backend, enabled: entry.available) {
                    select(entry.agent, profile: nil, model: nil)
                    saveChoice()
                }
            }
        }
        let profiles = entries.first { $0.agent == backend }?.profiles ?? []
        if profiles.count > 1 {
            NativeChipMenu(text: profiles.first { $0.id == profileId }?.name ?? profiles.first { $0.isDefault?.boolValue == true }?.name ?? profiles[0].name, symbol: "slider.horizontal.3") {
                [.header(String(localized: "配置"))] + profiles.map { profile in
                    .item(profile.name, checked: profile.id == profileId) {
                        profileId = profile.id
                        model = nil
                        saveChoice()
                    }
                }
            }
        }
    }

    // MARK: Cards

    private var cards: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: Space.sm)], spacing: Space.sm) {
            QuickAction(symbol: "brain", title: String(localized: "记忆"), detail: setup.memoryNote) { setup.showsMemory = true }
            QuickAction(symbol: "checkmark.shield", title: String(localized: "规则"), detail: setup.instructionsNote) { Task { await setup.openRules(workbench) } }
            QuickAction(symbol: "sparkles", title: String(localized: "能力"), detail: "") { setup.openAbilities(workbench) }
        }
    }

    // MARK: Choice

    /// The saved agent and model while that agent is still offered and one the assistant runs on; else the first
    /// of `assistantAgents` that can run (`assistantChoice` in `packages/contracts/src/assistant-choice.ts`).
    private func applyChoice() {
        guard backend.isEmpty else { return }
        let saved = workbench.assistant.saved
        guard let entry = workbench.backends.assistantEntry(saved: saved.backendId) else { return }
        // A saved provider and model belong to the saved agent only.
        guard entry.agent == saved.backendId else { return select(entry.agent, profile: nil, model: nil) }
        let profileKept = saved.profileId.map { id in entry.profiles.contains { $0.id == id } } ?? false
        select(entry.agent, profile: profileKept ? saved.profileId : nil, model: profileKept || saved.profileId == nil ? saved.model : nil)
    }

    private func select(_ agent: String, profile: String?, model: String?) {
        backend = agent
        profileId = profile
        self.model = model.flatMap { $0.isEmpty ? nil : $0 }
        approval = workbench.settings?.defaultsFor(agent: agent)?.approval.flatMap { $0.isEmpty ? nil : $0 }
        catalog = nil
        loadedKey = nil
    }

    private func saveChoice() {
        workbench.assistant.save(.init(backendId: backend, profileId: profileId, model: model))
    }

    private var effectiveModel: String? {
        let candidate = model ?? currentCatalog?.defaultModel
        guard let candidate, !candidate.isEmpty else { return nil }
        guard let models = currentCatalog?.models, !models.isEmpty else { return candidate }
        let resolved = resolveModelSelection(catalog: models, selection: candidate)
        return models.contains { $0.value == resolved.model }
            ? catalogSelection(catalog: models, model: resolved.model, overrides: resolved.params, preferredParam: nil)
            : nil
    }

    private var effectiveMode: String {
        guard let modes = currentCatalog?.capabilities.modes else { return "agent" }
        return modes.first { $0.id == "agent" }?.id ?? modes.first?.id ?? "agent"
    }

    private func loadCatalog(reload: Bool = false) async {
        guard !backend.isEmpty, let project else { return }
        let key = catalogKey
        do {
            let loaded = try await workbench.catalogs.loadCatalog(backend, profileId: profileId, projectId: project.id, reload: reload)
            guard key == catalogKey else { return }
            catalog = loaded
            loadedKey = key
            catalogError = nil
        } catch {
            guard key == catalogKey else { return }
            catalogError = error.riffetMessage
        }
    }

    // MARK: Send

    private func send() {
        guard !creating, composer.canSend, let project, currentCatalog?.available != false else { return }
        creating = true
        error = nil
        let intent = workbench.creationNavigationIntent
        let submission = composer.submission()
        let agent = backend, profile = profileId, selected = effectiveModel, mode = effectiveMode, permission = approval
        Task {
            var prepared: PendingSessionCreation?
            do {
                let request = try workbench.store.prepareCreation(
                    projectId: project.id, prompt: submission.text, attachments: submission.attachments,
                    backendId: nil, backendProfileId: profile, model: selected, mode: mode,
                    approval: permission, context: [], agentId: agent, toolGroups: nil, extensionsOff: nil
                )
                prepared = request
                _ = try await workbench.createPreparedSession(request, intent: intent, rememberSelection: false)
                composer.clear(sent: submission)
                composer.flushDraft()
                try? workbench.store.acknowledgePreparedCreation(id: request.id)
                await workbench.assistant.refresh()
            } catch {
                if ((error as NSError).userInfo["KotlinException"] as? RiffetHttpException)?.creationRejectedBeforeAcceptance == true, let prepared {
                    try? workbench.store.discardPreparedCreation(id: prepared.id)
                }
                self.error = error.riffetMessage
            }
            creating = false
        }
    }
}

// MARK: Memory, rules and abilities

/// What the 个人助理 is made of, read for the page's cards and the conversation's 会话信息.
@MainActor @Observable
final class AssistantSetup {
    private(set) var instructions: AssistantModel.Instructions?
    private(set) var memory: AssistantModel.Memory?
    private(set) var memoryFailed = false
    var showsMemory = false
    var showsRules = false

    /// The memory is read again each time it opens: the assistant writes it while it works.
    func load(_ workbench: Workbench) async {
        async let rules = try? workbench.assistant.instructions()
        async let notes = try? workbench.assistant.memory()
        if let rules = await rules { instructions = rules }
        if let notes = await notes { memory = notes; memoryFailed = false } else if memory == nil { memoryFailed = true }
    }

    /// The rules are read when the page opens; one that failed then is read again, and a second failure says nothing opens.
    func openRules(_ workbench: Workbench) async {
        if instructions == nil { await reloadRules(workbench) }
        if instructions != nil { showsRules = true }
    }

    func openAbilities(_ workbench: Workbench) {
        workbench.assistant.focusesExtensions = true
        workbench.page = .extensions
    }

    var instructionsNote: String {
        guard let instructions else { return "" }
        return instructions.custom ? String(localized: "已修改") : String(localized: "默认")
    }

    /// When it last wrote something down; nothing while it remembers nothing.
    var memoryNote: String {
        guard let memory, !memory.entries.isEmpty || !AssistantText.written(memory.profile).isEmpty || !AssistantText.written(memory.index).isEmpty else { return "" }
        return ServerTime.relative(memory.updatedAt) ?? ""
    }

    func reloadMemory(_ workbench: Workbench) async {
        do { memory = try await workbench.assistant.memory(); memoryFailed = false } catch { memoryFailed = memory == nil }
    }

    func reloadRules(_ workbench: Workbench) async {
        if let rules = try? await workbench.assistant.instructions() { instructions = rules }
    }

    func store(_ value: AssistantModel.Instructions) { instructions = value }
}

enum AssistantText {
    /// A memory file's own words: without the title and comment Riffet seeds it with.
    static func written(_ text: String) -> String {
        var result = text.replacingOccurrences(of: "<!--[\\s\\S]*?-->", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if result.hasPrefix("# ") {
            result = result.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).dropFirst().joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return result
    }

    /// A topic file's front matter names it; without one its first heading does, else the file name.
    static func describe(_ entry: AssistantModel.MemoryEntry) -> (title: String, body: String) {
        var text = entry.text
        var name = ""
        if text.hasPrefix("---\n"), let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 4)..<text.endIndex) {
            let front = text[text.index(text.startIndex, offsetBy: 4)..<end.lowerBound]
            for line in front.split(separator: "\n") where line.hasPrefix("name:") {
                name = line.dropFirst(5).trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"'")))
            }
            text = String(text[end.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        var heading = ""
        if text.hasPrefix("# ") {
            let parts = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
            heading = parts[0].dropFirst(2).trimmingCharacters(in: .whitespaces)
            text = parts.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let file = entry.name.hasSuffix(".md") ? String(entry.name.dropLast(3)) : entry.name
        return (name.isEmpty ? (heading.isEmpty ? file : heading) : name, text)
    }
}

extension View {
    /// The sheets 记忆 and 规则 open; attached outside anything that closes on navigation.
    func assistantSetupSheets(_ setup: AssistantSetup, workbench: Workbench) -> some View {
        modifier(AssistantSetupSheets(setup: setup, workbench: workbench))
    }
}

private struct AssistantSetupSheets: ViewModifier {
    @Bindable var setup: AssistantSetup
    let workbench: Workbench

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $setup.showsMemory) { AssistantMemorySheet(setup: setup, workbench: workbench) }
            .sheet(isPresented: $setup.showsRules) {
                if let instructions = setup.instructions {
                    AssistantRulesSheet(workbench: workbench, value: instructions) { setup.store($0) }
                }
            }
    }
}

/// What the assistant remembers, read-only: its profile of the owner, then one row per thing it wrote down.
private struct AssistantMemorySheet: View {
    let setup: AssistantSetup
    let workbench: Workbench
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var expanded: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack {
                Text("记忆").font(RiffetFont.text(RiffetTextSize.lg, weight: .medium))
                Spacer()
                Button { dismiss() } label: { Image(icon: "xmark") }
                    .buttonStyle(IconButtonStyle(size: 24))
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("关闭")
            }
            content
        }
        .padding(Space.xl)
        .frame(width: 520, height: 520)
        .task { await setup.reloadMemory(workbench) }
    }

    @ViewBuilder
    private var content: some View {
        if let memory = setup.memory {
            let profile = AssistantText.written(memory.profile)
            let entries = memory.entries.map { ($0, AssistantText.describe($0)) }
            let index = entries.isEmpty ? AssistantText.written(memory.index) : ""
            if profile.isEmpty, entries.isEmpty, index.isEmpty {
                placeholder(String(localized: "还没有记忆"))
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.xl) {
                        if !profile.isEmpty {
                            section(String(localized: "关于你")) { MarkdownView(source: profile) }
                        }
                        if !entries.isEmpty || !index.isEmpty {
                            section(String(localized: "记下的事")) {
                                if !index.isEmpty { MarkdownView(source: index) }
                                ForEach(entries, id: \.0.id) { entry, shown in row(entry, title: shown.title, body: shown.body) }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } else if setup.memoryFailed {
            placeholder(String(localized: "无法读取记忆"))
        } else {
            Spinner(size: .small).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text).font(RiffetFont.label).foregroundStyle(palette.fg3).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func section<Body: View>(_ title: String, @ViewBuilder _ body: () -> Body) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title).font(RiffetFont.text(RiffetTextSize.xs, weight: .medium)).foregroundStyle(palette.fg3).padding(.horizontal, Space.sm)
            body().padding(.horizontal, Space.sm)
        }
    }

    private func row(_ entry: AssistantModel.MemoryEntry, title: String, body: String) -> some View {
        let open = expanded == entry.id
        return VStack(alignment: .leading, spacing: 0) {
            Button { expanded = open ? nil : entry.id } label: {
                HStack(spacing: Space.sm) {
                    Image(icon: "chevron.right")
                        .font(RiffetFont.text(RiffetTextSize.x2xs, weight: .medium))
                        .foregroundStyle(palette.fg4)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .frame(width: 12)
                    Text(title).font(RiffetFont.label).foregroundStyle(palette.fg).lineLimit(1)
                    Spacer(minLength: Space.sm)
                    if let time = ServerTime.relative(entry.modifiedAt) {
                        Text(time).font(RiffetFont.text(RiffetTextSize.x2xs)).foregroundStyle(palette.fg4)
                    }
                }
                .frame(height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(HoverRowStyle(radius: Radius.control))
            .accessibilityAddTraits(open ? .isSelected : [])
            if open {
                MarkdownView(source: body).padding(.leading, Space.xl).padding(.vertical, Space.xs)
            }
        }
    }
}

/// The assistant's AGENTS.md: saved for the next launch; a changed one can be put back to Riffet's own.
private struct AssistantRulesSheet: View {
    let workbench: Workbench
    let value: AssistantModel.Instructions
    let saved: (AssistantModel.Instructions) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text("规则").font(RiffetFont.text(RiffetTextSize.lg, weight: .medium))
            TextEditor(text: $text)
                .font(RiffetFont.code)
                .scrollContentBackground(.hidden)
                .disabled(busy)
                .padding(Space.sm)
                .background(palette.formFill(palette.bgSubtle), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("AGENTS.md")
            SettingsErrorText(message: error)
            HStack {
                if value.custom {
                    Button("恢复默认") { save(nil) }.buttonStyle(SolidButtonStyle(kind: .secondary)).disabled(busy)
                }
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(SolidButtonStyle(kind: .secondary))
                Button("保存") { save(text) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .disabled(busy || text == value.text)
            }
        }
        .padding(Space.xl)
        .frame(width: 620, height: 520)
        .onAppear { text = value.text }
    }

    private func save(_ next: String?) {
        busy = true
        error = nil
        Task {
            do {
                saved(try await workbench.assistant.saveInstructions(next))
                dismiss()
            } catch {
                self.error = error.riffetMessage
            }
            busy = false
        }
    }
}
