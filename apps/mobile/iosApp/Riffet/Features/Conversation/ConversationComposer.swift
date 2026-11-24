import SwiftUI
import RiffetKit

struct ConversationComposer: View {
    let workbench: Workbench
    let session: Session
    @Bindable var draft: MessageDraft
    var supportsInterrupt = true
    var catalog: NativeBackendCatalogEntry? = nil
    var catalogLoading = false
    var catalogError: String? = nil
    /// The model sheet closed; it may have read the catalog the page could not.
    var onOptionsClosed: () -> Void = {}
    /// Incremented by the page to put the cursor in the input (after quoting a message).
    var focusRequest = 0
    /// The `/` or `@` token being typed; the page docks its menu above this composer.
    @Binding var menu: ComposerMenuToken?
    let onSent: () -> Void
    @State private var files = false
    @State private var photos = false
    /// The token Escape closed; it stays closed as that token is typed on.
    @State private var dismissedMenu: ComposerMenuToken.Key?
    @State private var configuration: SessionOptionFocus?
    @State private var expandedEditor = false
    @FocusState private var focused: Bool
    @State private var voice = ComposerVoice()
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var textSize
    private var voiceInput: Bool { workbench.settings?.voiceInput?.recognizer != nil }
    private var dictating: Bool { voice.dictating }
    private var voiceActive: Bool { voice.mode && voiceInput }
    private var textEmpty: Bool { voice.textEmpty(draft) }
    private var handsFree: Bool { voice.handsFree }
    private var holdInFooter: Bool { voiceActive && !textEmpty }
    private var archived: Bool { session.archivedAt != nil }
    private var quickChat: Bool { session.backendId == .chat }
    private var busy: Bool { workbench.sendState.sending || workbench.sendState.interrupting }
    private var defaultSendSteers: Bool { workbench.store.prefersSteerWhileRunning() }
    private var sendLabel: String { defaultSendSteers ? String(localized: "补充到当前任务", bundle: .riffet) : workbench.working ? String(localized: "加入发送队列", bundle: .riffet) : String(localized: "发送消息", bundle: .riffet) }
    private var modelName: String { NativeConfigurationSummary.shortModel(catalog: catalog, selection: session.model) }
    /// How full the context window is, once the agent has reported it for this session.
    private var contextRatio: Double? {
        guard workbench.selected?.id == session.id, let context = workbench.context, context.size > 0, context.used >= 0 else { return nil }
        return Double(context.used) / Double(context.size)
    }
    private var acceptsMessages: Bool {
        catalog?.capabilities.requiresLiveTerminal?.boolValue != true ||
            nativeConversationLive(session: session, status: workbench.status, requiresLiveTerminal: true)
    }
    private var hasContent: Bool { !draft.text.isEmpty || !draft.attachments.isEmpty || !draft.references.isEmpty || !draft.pendingFiles.isEmpty }
    /// Focused or holding a draft the card grows its footer; otherwise it stays one line.
    private var expanded: Bool { focused || voice.hasContent(hasContent) || handsFree }
    /// A control snapshot is the only stop permission. Without one, the catalog and a live background task still offer it.
    private var canStopTurn: Bool {
        if let control = workbench.control { return workbench.isConnected && control.activeTurn?.canStop == true }
        return supportsInterrupt
    }
    private var showsStop: Bool {
        if workbench.control != nil {
            let canStopBackground = supportsInterrupt && workbench.backgroundSubagents > 0
            return workbench.sendState.interrupting || ((canStopTurn || canStopBackground) && !draft.canSend)
        }
        return supportsInterrupt && (workbench.sendState.interrupting || (workbench.working || workbench.backgroundSubagents > 0) && !draft.canSend)
    }
    private var placeholder: LocalizedStringKey {
        draft.text.isEmpty && !draft.attachments.isEmpty ? "为附件补充说明…" : defaultSendSteers ? "补充当前任务…" : workbench.working ? "输入下一条消息…" : session.backendId == .chat ? "发送消息…" : "给 Agent 发送消息"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            feedback
            attachmentChips
            if archived {
                HStack { Text("会话已归档").foregroundStyle(palette.fg3); Spacer(); Button("恢复会话") { Task { await workbench.update(session, archived: false) } }.tint(palette.accent) }
                    .riffetFont(.label).padding(.horizontal, 16).frame(minHeight: ConversationComposer.barHeight).riffetComposerSurface()
            } else if session.terminalHold != nil {
                TerminalHoldBar(workbench: workbench, sessionID: session.id)
            } else {
                card
            }
        }.padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 6)
        .riffetAnimation(RiffetMotion.spatial, value: expanded)
        // No 完成 bar over the keyboard: dragging the transcript down puts it away (`keyboardDismissMode`).
        .sheet(isPresented: $files) { DocumentAttachmentPicker { picked($0); files = false } }
        .sheet(isPresented: $photos) { PhotoAttachmentPicker { picked($0); photos = false } }
        .attachmentDrop(enabled: !archived && !draft.uploading, picked)
        .sheet(item: $configuration, onDismiss: onOptionsClosed) { focus in
            NavigationStack {
                SessionOptionsView(workbench: workbench, session: session, focus: focus)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { configuration = nil } } }
            }.presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $expandedEditor) {
            NavigationStack {
                TextEditor(text: $draft.text).riffetFont(.body).padding(12).scrollContentBackground(.hidden)
                    .accessibilityIdentifier("expandedMessageComposer")
                    .navigationTitle(String(localized: "编辑消息", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("收起") { draft.save(); expandedEditor = false } }
                        ToolbarItem(placement: .confirmationAction) { Button(defaultSendSteers ? "补充到当前任务" : workbench.working ? "加入队列" : "发送") { send(interrupt: false) }.disabled(!acceptsMessages || !draft.canSend || busy || voice.dictating).accessibilityLabel(sendLabel) }
                    }
            }.presentationDetents([.large])
        }
        .onChange(of: draft.text) { _, value in updateMenu(value) }
        .onChange(of: focused) { _, now in if now, voice.mode { voice.setMode(false) }
        }
        .onChange(of: voice.mode) { _, on in if on { focused = false } }
        .onChange(of: focusRequest) { _, _ in
            voice.setMode(false)
            Task { focused = true }
        }
        .onChange(of: scenePhase) { _, phase in
            voice.scenePhaseChanged(phase)
        }
        .onDisappear { voice.teardown() }
    }
    private var voiceToggle: some View {
        ComposerVoiceToggle(voice: voice, keyboard: { Task { focused = true } }) { toolGlyph($0) }
    }
    private func holdBar(height: CGFloat) -> some View {
        ComposerHoldBar(voice: voice, draft: draft, host: workbench.host, hasContent: hasContent, height: height, unfocus: { focused = false })
    }
    private var supportsSessionReferences: Bool { catalog?.capabilities.supportsSessionReferences == true }
    /// A quick chat has no project files to cite and no commands or skills; it can still cite sessions.
    private func updateMenu(_ value: String) {
        guard let token = ComposerMenuToken.detect(in: value), token.kind == .slash ? !quickChat : (!quickChat || supportsSessionReferences) else {
            dismissedMenu = nil
            if menu != nil { menu = nil }
            return
        }
        if dismissedMenu == token.key { if menu != nil { menu = nil }; return }
        if menu != token { menu = token }
    }
    /// The plus menu's entries put the sigil in the draft, which opens the docked menu.
    private func insertTrigger(_ sigil: String) {
        if let last = draft.text.last, !last.isWhitespace { draft.text += " " }
        draft.text += sigil
        focused = true
    }
    /// One floating card. The input keeps a single call site; focus and content only add the footer.
    private var card: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 0) {
                if !expanded { plusMenu; if voiceInput { voiceToggle } }
                if voiceActive && textEmpty && !handsFree {
                    // Where the draft's text would be: the same left edge, and the right edge the send button keeps. Open,
                    // the bar's top inset equals its gap above the send button, and the card keeps its height.
                    holdBar(height: expanded ? RiffetMetrics.hitTarget : RiffetMetrics.sendButton)
                        .padding(.leading, expanded ? RiffetMetrics.groupInset : 0).padding(.trailing, Self.sendEdge)
                        .padding(.top, expanded ? RiffetMetrics.groupInset : 0).padding(.bottom, expanded ? RiffetMetrics.groupInset - Self.sendInset : 0)
                } else {
                ComposerFieldLayout(key: focused ? nil : [AnyHashable(draft.text), AnyHashable(textSize)]) {
                    TextField(placeholder, text: $draft.text, selection: voice.selectionBinding(draft), axis: .vertical)
                        .riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1...6).focused($focused)
                }
                    .padding(.leading, expanded ? 16 : 0).padding(.vertical, expanded ? 14 : 0)
                    .frame(minHeight: RiffetMetrics.hitTarget)
                    .accessibilityIdentifier("messageComposer")
                    .allowsHitTesting(!dictating)
                    .onKeyPress(.escape) {
                        guard let token = menu else { return .ignored }
                        dismissedMenu = token.key; menu = nil
                        return .handled
                    }
                }
                if focused {
                    Button { expandedEditor = true } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right").riffetFont(.caption).foregroundStyle(palette.fg4)
                            .frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
                    }.buttonStyle(RiffetDimPressStyle()).accessibilityLabel("展开编辑器").accessibilityIdentifier("expandComposer")
                } else if !expanded && showsStop {
                    stopButton
                }
            }
            // One line, the send button as far from the card's top and bottom as from its right edge.
            .frame(minHeight: expanded ? nil : ConversationComposer.barHeight)
            .padding(.leading, expanded ? 0 : Self.toolsLeading).padding(.trailing, expanded ? 0 : Self.toolsTrailing)
            if expanded { footer.transition(.opacity) }
        }
        .riffetComposerSurface()
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { voice.hold.composerFrame = $0 }
    }
    private var footer: some View {
        Group {
            if let dictation = voice.dictation, dictating, !voice.hold.session {
                DictationBar(state: dictation, cancel: { voice.cancel() }, finish: { voice.finish() }, retry: { voice.retry() })
            } else { tools }
        }.padding(.leading, Self.toolsLeading).padding(.trailing, Self.toolsTrailing).padding(.bottom, 2)
    }
    /// The card's rows line up on the draft's left edge (`groupInset`): the plus glyph is centred in its 40pt slot, so the
    /// row starts this far in. The send button's circle sits `sendInset` inside its 44pt slot; the row ends `toolsTrailing`
    /// in, so its right edge is `sendEdge` from the card, and the hold bar ends on the same line.
    private static let toolsLeading: CGFloat = RiffetMetrics.groupInset - (toolWidth - glyphSize) / 2
    private static let toolsTrailing: CGFloat = 4
    private static let sendInset: CGFloat = (RiffetMetrics.hitTarget - RiffetMetrics.sendButton) / 2
    private static let sendEdge: CGFloat = toolsTrailing + sendInset
    /// The one-line forms: the empty, unfocused input and the bars that stand in for it. The send button is as far
    /// from the card's top and bottom as from its right edge.
    static let barHeight: CGFloat = RiffetMetrics.sendButton + 2 * sendEdge
    private static let toolWidth: CGFloat = 40
    private static let glyphSize: CGFloat = 20
    private var tools: some View {
        HStack(spacing: 0) {
            plusMenu
            if voiceInput { voiceToggle }
            if holdInFooter { holdBar(height: RiffetMetrics.sendButton).padding(.horizontal, RiffetMetrics.floatingGap) } else { Spacer(minLength: 8) }
            if !holdInFooter { RiffetModelLabel(title: modelName, context: contextRatio, loading: catalogLoading, failed: catalogError != nil) { configuration = .model }
                .accessibilityLabel(String(localized: "模型：\(modelName)", bundle: .riffet))
                .accessibilityValue(catalogLoading ? String(localized: "正在加载", bundle: .riffet) : catalogError ?? contextRatio.map { String(localized: "上下文已用 \($0.formatted(.percent.precision(.fractionLength(0))))", bundle: .riffet) } ?? "")
                .accessibilityHint("查看模型、参数、模式与权限").accessibilityIdentifier("modelPicker")
                .layoutPriority(1) }
            if draft.uploading { ProgressView().frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
            else if showsStop { stopButton }
            else {
                RiffetSendButton(enabled: acceptsMessages && draft.canSend && !busy && !voice.dictating) { send(interrupt: false) }
                    .accessibilityLabel(sendLabel).accessibilityIdentifier("sendMessage")
                    .contextMenu {
                        if defaultSendSteers { Button("加入队列") { send(interrupt: false, enqueue: true) }.disabled(!acceptsMessages || !draft.canSend || busy || voice.dictating) }
                        if workbench.working && canStopTurn {
                            Button("停止当前任务") { workbench.interrupt(sessionID: session.id) }.disabled(busy)
                            Button("停止并发送") { send(interrupt: true) }.disabled(!acceptsMessages || !draft.canSend || busy || voice.dictating)
                        }
                    }
            }
        }
    }
    private var stopButton: some View {
        Group {
            if workbench.sendState.interrupting { ProgressView().frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
            else {
                RiffetSendButton(enabled: false, stop: true) { workbench.interrupt(sessionID: session.id) }
                    .disabled(busy)
            }
        }
        .accessibilityLabel(workbench.sendState.interrupting ? "停止中" : workbench.working ? "停止当前任务" : "停止后台任务").accessibilityIdentifier("stopTask")
    }
    /// A footer tool's symbol: the plus and the mic.
    private func toolGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: Self.glyphSize)).foregroundStyle(palette.fg)
            .frame(width: Self.toolWidth, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
    }
    private var plusMenu: some View {
        Menu {
            Button("选择照片", systemImage: "photo") { photos = true }
            Button("选择文件", systemImage: "doc") { files = true }
            // A quick chat has no project files to cite and no commands or skills.
            if !quickChat { Button("引用项目文件", systemImage: "at") { insertTrigger("@") } }
            if catalog?.capabilities.supportsSessionReferences == true {
                Button("引用会话", systemImage: "text.bubble") { insertTrigger("@") }
            }
            if !quickChat { Button("命令与技能", systemImage: "slash.circle") { insertTrigger("/") } }
        } label: {
            toolGlyph("plus")
        }.disabled(draft.uploading).accessibilityLabel("添加附件、引用或命令")
    }
    @ViewBuilder private var feedback: some View {
        if let error = draft.error ?? workbench.sendState.error { RiffetNotice(kind: .error, message: error, boxed: true) }
        // Uncertain delivery clears with the receipt.
    }
    @ViewBuilder private var attachmentChips: some View {
        if !draft.pendingFiles.isEmpty || !draft.references.isEmpty || !draft.attachments.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(draft.pendingFiles) { file in
                        Menu { Button("重试上传") { Task { await draft.retry(workbench: workbench, projectID: session.projectId) } }; Button("移除", role: .destructive) { draft.removePending(file.id) } } label: { Label(file.name, systemImage: draft.uploading ? "arrow.up.doc" : "exclamationmark.circle").lineLimit(1).riffetFont(.caption).padding(8).background(palette.press, in: Capsule()) }
                    }
                    ForEach(Array(draft.references.enumerated()), id: \.offset) { _, reference in
                        HStack(spacing: 4) {
                            if reference.kind == "session", let id = reference.sessionId {
                                Button { draft.save(); Task { await workbench.open(sessionID: id) } } label: {
                                    Label(reference.title ?? id, systemImage: "text.bubble").lineLimit(1)
                                }.buttonStyle(.plain)
                            } else { Label((reference.path as NSString).lastPathComponent, systemImage: "at").lineLimit(1) }
                            Button("移除引用", systemImage: "xmark.circle.fill") { draft.references.removeAll { $0 == reference } }
                                .labelStyle(.iconOnly).frame(width: 30, height: 32).contentShape(Rectangle().inset(by: -7))
                        }.riffetFont(.caption).padding(.leading, 10).background(palette.press, in: Capsule())
                    }
                    ForEach(draft.attachments, id: \.id) { attachment in
                        if attachment.mimeType.hasPrefix("image/") && attachment.mimeType != "image/svg+xml" {
                            ComposerThumbnail(workbench: workbench, attachmentID: attachment.id, name: attachment.name) { draft.attachments.removeAll { $0.id == attachment.id } }
                        } else {
                            HStack(spacing: 4) { Label(attachment.name, systemImage: "doc").lineLimit(1); Button("移除附件", systemImage: "xmark.circle.fill") { draft.attachments.removeAll { $0.id == attachment.id } }.labelStyle(.iconOnly).frame(width: 30, height: 32).contentShape(Rectangle().inset(by: -7)) }.riffetFont(.caption).padding(.leading, 10).background(palette.press, in: Capsule())
                        }
                    }
                }
            }.scrollIndicators(.hidden)
        }
    }
    private func picked(_ result: Result<[ImportedAttachment], Error>) {
        switch result {
        case let .success(files): Task { await draft.add(files: files, workbench: workbench, projectID: session.projectId) }
        case let .failure(error): draft.error = error.riffetMessage
        }
    }
    private func send(interrupt: Bool, enqueue: Bool = false) {
        let shown = interrupt ? workbench.stopSnapshot(sessionID: session.id) : nil
        guard acceptsMessages, !interrupt || shown != nil else { return }
        let text = draft.text, attachments = draft.attachments, references = draft.references, revision = draft.textRevision
        draft.save()
        Task {
            _ = await workbench.send(text, attachments: attachments, interrupt: interrupt, context: references, enqueue: enqueue, stopSnapshot: shown, onStored: {
                draft.clear(sentText: text, sentAttachments: attachments, sentReferences: references, sentRevision: revision)
                if draft.text.isEmpty && draft.attachments.isEmpty && draft.references.isEmpty && draft.pendingFiles.isEmpty {
                    focused = false; expandedEditor = false
                }
                onSent()
            })
        }
    }
}

/// Around a growing text field (the composer, the new-task field): fills the width it is offered and
/// asks the field for its height at that width only. The stacks around the field also probe it at zero
/// and unbounded widths to learn how flexible it is, and the field lays out its whole text for each
/// probe, the unbounded one as a single line: a long draft cost every keystroke tens of milliseconds
/// (docs/guide/ios-performance.md §2.1).
struct ComposerFieldLayout: Layout {
    /// What else the field's height depends on (text, type size, line limits). The composer is laid out
    /// again on every transcript update, and measuring a long draft each time costs milliseconds. Nil
    /// while editing: marked text from an input method is not in the binding yet but changes the height.
    var key: AnyHashable?
    struct Cache { var width: CGFloat?; var height: CGFloat?; var key: AnyHashable? }
    func makeCache(subviews: Subviews) -> Cache { Cache() }
    func updateCache(_ cache: inout Cache, subviews: Subviews) {}
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        guard let field = subviews.first else { return .zero }
        guard let width = proposal.width, width.isFinite, width > 0 else {
            // A flexibility probe: as narrow or as wide as offered, at the height last measured.
            let height = cache.height ?? field.sizeThatFits(ProposedViewSize(width: cache.width ?? 320, height: nil)).height
            return CGSize(width: proposal.width ?? cache.width ?? 0, height: height)
        }
        if let key, let height = cache.height, cache.width == width, cache.key == key { return CGSize(width: width, height: height) }
        let height = field.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        cache = Cache(width: width, height: height, key: key)
        return CGSize(width: width, height: height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// The model control's trailing glyph, in a fixed slot: progress while its catalog loads, a warning
/// once reading it failed (the sheet it opens says why and retries), the picker chevron otherwise.
struct CatalogStatusSlot: View {
    let loading: Bool
    let failed: Bool
    @Environment(\.palette) private var palette
    var body: some View {
        Group {
            if loading { ProgressView().controlSize(.mini) }
            else if failed { Image(systemName: "exclamationmark.triangle.fill").riffetFont(.caption).foregroundStyle(palette.warning) }
            else { Image(systemName: "chevron.down") }
        }.frame(width: 12, height: 12)
    }
}

/// A picked image as a small preview, with its remove control on the corner.
private struct ComposerThumbnail: View {
    let workbench: Workbench
    let attachmentID: String
    let name: String
    let remove: () -> Void
    @State private var image: UIImage?
    @Environment(\.palette) private var palette
    private var key: String { "thumbnail:" + attachmentID }
    var body: some View {
        let shown = image ?? ConversationLayoutMemo.shared.image(key)
        ZStack {
            if let shown { Image(uiImage: shown).resizable().scaledToFill() }
            else { Image(systemName: "photo").foregroundStyle(palette.fg3) }
        }
        .frame(width: 44, height: 44)
        .background(palette.press)
        .clipShape(RoundedRectangle(cornerRadius: RiffetMetrics.rowRadius))
        .overlay(alignment: .topTrailing) {
            Button("移除附件", systemImage: "xmark.circle.fill", action: remove)
                .labelStyle(.iconOnly).riffetFont(.body).symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.55))
                .frame(width: 30, height: 30, alignment: .topTrailing).contentShape(Rectangle().inset(by: -7)).offset(x: 6, y: -6)
        }
        .padding(.top, 6).padding(.trailing, 6)
        .accessibilityElement(children: .contain).accessibilityLabel(name)
        .task(id: attachmentID) {
            guard shown == nil, let url = workbench.resources.attachmentURL(attachmentID),
                  let data = try? await workbench.resources.data(for: url) else { return }
            let decoded = await Task.detached(priority: .userInitiated) { ConversationImageDecoder.decode(data, maximumPixelSize: 160) }.value
            if let decoded { ConversationLayoutMemo.shared.store(decoded, for: key); image = decoded }
        }
    }
}

/// Stands where the input card is while a terminal holds the conversation: that CLI is its only writer.
/// Taking it back while the terminal's CLI still runs is refused (409), and the reader then confirms ending it.
private struct TerminalHoldBar: View {
    let workbench: Workbench
    let sessionID: String
    @Environment(\.palette) private var palette
    @State private var releasing = false
    @State private var confirming = false
    @State private var error: String?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "apple.terminal").riffetFont(.label).foregroundStyle(palette.fg3)
            Text(error ?? String(localized: "在终端中", bundle: .riffet)).foregroundStyle(error == nil ? palette.fg2 : palette.danger).lineLimit(2)
            Spacer(minLength: 8)
            Button("收回") { release(force: false) }.tint(palette.accent).disabled(releasing)
        }
        .riffetFont(.label).padding(.horizontal, 16).frame(minHeight: ConversationComposer.barHeight).riffetComposerSurface()
        .confirmationDialog("结束终端中的进程？", isPresented: $confirming, titleVisibility: .visible) {
            Button("结束并收回", role: .destructive) { release(force: true) }
        }
    }

    private func release(force: Bool) {
        guard !releasing else { return }
        releasing = true; error = nil
        Task {
            defer { releasing = false }
            do { _ = try await workbench.store.releaseTerminalHold(id: sessionID, force: force) }
            catch is CancellationError {}
            catch {
                if !force, let http = ((error as NSError).userInfo["KotlinException"] as? RiffetHttpException), http.code == "TERMINAL_STILL_RUNNING" { confirming = true }
                else { self.error = error.riffetMessage }
            }
        }
    }
}
