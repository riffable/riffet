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
    let onSent: () -> Void
    @State private var files = false
    @State private var photos = false
    @State private var commands = false
    @State private var references = false
    @State private var sessionReferences = false
    @State private var configuration: SessionOptionFocus?
    @State private var expandedEditor = false
    @FocusState private var focused: Bool
    @Environment(\.palette) private var palette
    private var archived: Bool { session.archivedAt != nil }
    private var quickChat: Bool { session.backendId == .chat }
    private var busy: Bool { workbench.sendState.sending || workbench.sendState.interrupting }
    private var defaultSendSteers: Bool { workbench.store.prefersSteerWhileRunning() }
    private var sendLabel: String { defaultSendSteers ? String(localized: "补充到当前任务", bundle: .riffet) : workbench.working ? String(localized: "加入发送队列", bundle: .riffet) : String(localized: "发送消息", bundle: .riffet) }
    private var modelName: String { NativeConfigurationSummary.shortModel(catalog: catalog, selection: session.model) }
    private var approval: String? {
        NativeConfigurationSummary.approval(status: workbench.selected?.id == session.id ? workbench.status : nil, backend: session.backendId ?? .cursor, sessionApproval: session.approval)
    }
    private var hasContent: Bool { !draft.text.isEmpty || !draft.attachments.isEmpty || !draft.references.isEmpty || !draft.pendingFiles.isEmpty }
    /// Focused or holding a draft the card grows its footer; otherwise it stays one line.
    private var expanded: Bool { focused || hasContent }
    private var showsStop: Bool {
        supportsInterrupt && (workbench.sendState.interrupting || (workbench.working || workbench.backgroundSubagents > 0) && !draft.canSend)
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
                    .riffetFont(.label).padding(.horizontal, 16).frame(minHeight: RiffetMetrics.hitTarget + 8).riffetComposerSurface()
            } else if session.terminalHold != nil {
                TerminalHoldBar(workbench: workbench, sessionID: session.id)
            } else {
                card
            }
        }.padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 6)
        .animation(RiffetMotion.spatial, value: expanded)
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
        .sheet(isPresented: $commands) { ConversationSlashPicker(workbench: workbench, session: session) { item in
            if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.text == "/" { draft.text = "/" + item.name + " " }
            else if item.isSkill { draft.text += " /" + item.name + " " }
            else { draft.text = "/" + item.name + " " + draft.text }
            commands = false; focused = true
        } }
        .sheet(isPresented: $references) { ConversationReferencePicker(workbench: workbench, projectID: session.projectId) { file in
            if draft.text == "@" { draft.text = "" }
            if !draft.references.contains(where: { $0.path == file.path && $0.line == nil }) { draft.references.append(PromptContextReference(path: file.path, line: nil, kind: nil, sessionId: nil, fromRunId: nil, title: nil)) }
            references = false; focused = true
        } }
        .sheet(isPresented: $sessionReferences) {
            ConversationSessionReferencePicker(workbench: workbench, currentSessionID: session.id, projectID: session.projectId) { selected in
                guard draft.references.filter({ $0.kind == "session" }).count < 5 else {
                    draft.error = String(localized: "最多引用 5 个会话", bundle: .riffet); return
                }
                if !draft.references.contains(where: { $0.sessionId == selected.id }) {
                    draft.references.append(sessionReference(session: selected))
                }
                if let range = draft.text.range(of: #"(?:^|\s)@[^\s@]*$"#, options: .regularExpression) {
                    let token = draft.text[range]
                    let leading = token.prefix { $0 != "@" }
                    draft.text.replaceSubrange(range, with: String(leading))
                }
                sessionReferences = false; focused = true
            }
        }
        .sheet(isPresented: $expandedEditor) {
            NavigationStack {
                TextEditor(text: $draft.text).font(.body).padding(12).scrollContentBackground(.hidden)
                    .accessibilityIdentifier("expandedMessageComposer")
                    .navigationTitle(String(localized: "编辑消息", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("收起") { draft.save(); expandedEditor = false } }
                        ToolbarItem(placement: .confirmationAction) { Button(defaultSendSteers ? "补充到当前任务" : workbench.working ? "加入队列" : "发送") { send(interrupt: false) }.disabled(!draft.canSend || busy).accessibilityLabel(sendLabel) }
                    }
            }.presentationDetents([.large])
        }
        .onChange(of: draft.text) { old, value in
            if old.isEmpty && value == "/" && !quickChat { commands = true }
            if catalog?.capabilities.supportsSessionReferences == true,
               value.range(of: #"(?:^|\s)@[^\s@]*$"#, options: .regularExpression) != nil { sessionReferences = true }
            else if old.isEmpty && value == "@" && !quickChat { references = true }
        }
    }
    /// One floating card. The input keeps a single call site; focus and content only add the footer.
    private var card: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 0) {
                if !expanded { plusMenu }
                TextField(placeholder, text: $draft.text, axis: .vertical)
                    .riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1...6).focused($focused)
                    .onChange(of: focusRequest) { _, _ in focused = true }
                    .padding(.leading, expanded ? 16 : 0).padding(.vertical, expanded ? 14 : 0)
                    .frame(minHeight: RiffetMetrics.hitTarget)
                    .accessibilityIdentifier("messageComposer")
                if focused {
                    Button { expandedEditor = true } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 13)).foregroundStyle(palette.fg4)
                            .frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
                    }.buttonStyle(RiffetDimPressStyle()).accessibilityLabel("展开编辑器").accessibilityIdentifier("expandComposer")
                } else if !expanded && showsStop {
                    stopButton
                }
            }
            if expanded { footer.transition(.opacity) }
        }
        .riffetComposerSurface()
    }
    private var footer: some View {
        HStack(spacing: 0) {
            plusMenu
            Spacer(minLength: 8)
            RiffetModelLabel(title: modelName, icon: .approval(approval), loading: catalogLoading, failed: catalogError != nil) { configuration = .model }
                .accessibilityLabel(String(localized: "模型：\(modelName)", bundle: .riffet))
                .accessibilityValue(catalogLoading ? String(localized: "正在加载", bundle: .riffet) : catalogError ?? "")
                .accessibilityHint("查看模型、参数、模式与权限").accessibilityIdentifier("modelPicker")
                .layoutPriority(1)
            if draft.uploading { ProgressView().frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
            else if showsStop { stopButton }
            else {
                RiffetSendButton(enabled: draft.canSend && !busy) { send(interrupt: false) }
                    .accessibilityLabel(sendLabel).accessibilityIdentifier("sendMessage")
                    .contextMenu {
                        if defaultSendSteers { Button("加入队列") { send(interrupt: false, enqueue: true) }.disabled(!draft.canSend || busy) }
                        if workbench.working && supportsInterrupt {
                            Button("停止当前任务") { Task { await workbench.perform { _ = try await workbench.store.interrupt() } } }.disabled(busy)
                            Button("停止并发送") { send(interrupt: true) }.disabled(!draft.canSend || busy)
                        }
                    }
            }
        }.padding(.horizontal, 4).padding(.bottom, 2)
    }
    private var stopButton: some View {
        Group {
            if workbench.sendState.interrupting { ProgressView().frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget) }
            else {
                RiffetSendButton(enabled: false, stop: true) { Task { await workbench.perform { _ = try await workbench.store.interrupt() } } }
                    .disabled(busy)
            }
        }
        .accessibilityLabel(workbench.sendState.interrupting ? "停止中" : workbench.working ? "停止当前任务" : "停止后台任务").accessibilityIdentifier("stopTask")
    }
    private var plusMenu: some View {
        Menu {
            Button("选择照片", systemImage: "photo") { photos = true }
            Button("选择文件", systemImage: "doc") { files = true }
            // A quick chat has no project files to cite and no commands or skills.
            if !quickChat { Button("引用项目文件", systemImage: "at") { references = true } }
            if catalog?.capabilities.supportsSessionReferences == true {
                Button("引用会话", systemImage: "text.bubble") { sessionReferences = true }
            }
            if !quickChat { Button("命令与技能", systemImage: "slash.circle") { commands = true } }
        } label: {
            Image(systemName: "plus").font(.system(size: 20)).foregroundStyle(palette.fg)
                .frame(width: RiffetMetrics.hitTarget, height: RiffetMetrics.hitTarget).contentShape(Rectangle())
        }.disabled(draft.uploading).accessibilityLabel("添加附件、引用或命令")
    }
    @ViewBuilder private var feedback: some View {
        if let error = draft.error ?? workbench.sendState.error { Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        // Uncertain delivery is owned by ConversationRunDocks and clears with the receipt.
    }
    @ViewBuilder private var attachmentChips: some View {
        if !draft.pendingFiles.isEmpty || !draft.references.isEmpty || !draft.attachments.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(draft.pendingFiles) { file in
                        Menu { Button("重试上传") { Task { await draft.retry(workbench: workbench, projectID: session.projectId) } }; Button("移除", role: .destructive) { draft.removePending(file.id) } } label: { Label(file.name, systemImage: draft.uploading ? "arrow.up.doc" : "exclamationmark.circle").lineLimit(1).font(.caption).padding(8).background(.quaternary, in: Capsule()) }
                    }
                    ForEach(Array(draft.references.enumerated()), id: \.offset) { _, reference in
                        HStack(spacing: 4) {
                            if reference.kind == "session", let id = reference.sessionId {
                                Button { draft.save(); Task { await workbench.open(sessionID: id) } } label: {
                                    Label(reference.title ?? id, systemImage: "text.bubble").lineLimit(1)
                                }.buttonStyle(.plain)
                            } else { Label((reference.path as NSString).lastPathComponent, systemImage: "at").lineLimit(1) }
                            Button("移除引用", systemImage: "xmark.circle.fill") { draft.references.removeAll { $0 == reference } }
                                .labelStyle(.iconOnly).frame(width: 30, height: 32)
                        }.font(.caption).padding(.leading, 10).background(.quaternary, in: Capsule())
                    }
                    ForEach(draft.attachments, id: \.id) { attachment in
                        if attachment.mimeType.hasPrefix("image/") && attachment.mimeType != "image/svg+xml" {
                            ComposerThumbnail(workbench: workbench, attachmentID: attachment.id, name: attachment.name) { draft.attachments.removeAll { $0.id == attachment.id } }
                        } else {
                            HStack(spacing: 4) { Label(attachment.name, systemImage: "doc").lineLimit(1); Button("移除附件", systemImage: "xmark.circle.fill") { draft.attachments.removeAll { $0.id == attachment.id } }.labelStyle(.iconOnly).frame(width: 30, height: 32) }.font(.caption).padding(.leading, 10).background(.quaternary, in: Capsule())
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
        let text = draft.text, attachments = draft.attachments, references = draft.references, revision = draft.textRevision
        draft.save()
        Task {
            _ = await workbench.send(text, attachments: attachments, interrupt: interrupt, context: references, enqueue: enqueue, onStored: {
                draft.clear(sentText: text, sentAttachments: attachments, sentReferences: references, sentRevision: revision)
                if draft.text.isEmpty && draft.attachments.isEmpty && draft.references.isEmpty && draft.pendingFiles.isEmpty {
                    focused = false; expandedEditor = false
                }
                onSent()
            })
        }
    }
}

struct ConversationRunDocks: View {
    let workbench: Workbench
    let draft: MessageDraft
    var supportsSteer = false
    var supportsTargetedStop = false
    @Environment(\.palette) private var palette
    private var canSteer: Bool { workbench.isConnected && workbench.status?.phase == .busy && workbench.interaction == nil && workbench.uncertain.isEmpty && !workbench.sendState.sending && !workbench.sendState.interrupting }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let goal = workbench.goal {
                DisclosureGroup { VStack(alignment: .leading, spacing: 6) { Text(goal.objective); if let reason = goal.blockedReason { Text(reason).foregroundStyle(.orange) } }.font(.subheadline).padding(.top, 8) } label: { Label("目标 · \(goalStatusLabel(action: goal.action))", systemImage: "target").font(.subheadline) }
            }
            if !workbench.todos.isEmpty {
                DisclosureGroup { ConversationTodoList(entries: workbench.todos).padding(.top, 8) } label: { Label(todoProgress(entries: workbench.todos), systemImage: "checklist").font(.subheadline) }
            }
            ForEach(workbench.queued, id: \.id) { run in
                VStack(alignment: .leading, spacing: 8) {
                    Label("等待发送", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                    Text(run.prompt).font(.subheadline).lineLimit(3)
                    HStack(spacing: 0) {
                        let showsSteer = supportsSteer && workbench.status?.activeTurn != nil
                        let usesSteer = showsSteer && canSteer
                        if usesSteer {
                            Button { guard let target = workbench.status?.activeTurn?.target() else { return }; Task { await workbench.perform { _ = try await workbench.store.steerQueued(run: run, target: target) } } } label: { Image(systemName: "arrow.turn.up.right").frame(width: 44, height: 44) }
                                .disabled(!canSteer).help("补充到当前任务").accessibilityLabel("补充到当前任务")
                        } else if supportsTargetedStop {
                            Button { Task { await workbench.perform { _ = try await workbench.store.sendQueuedNow(run: run) } } } label: { Image(systemName: "arrow.up").frame(width: 44, height: 44) }
                                .accessibilityLabel("停止并发送")
                        }
                        Menu {
                            if usesSteer && supportsTargetedStop {
                                Button("停止并发送", systemImage: "arrow.up") { Task { await workbench.perform { _ = try await workbench.store.sendQueuedNow(run: run) } } }
                            } else if showsSteer {
                                Button("补充到当前任务", systemImage: "arrow.turn.up.right") { guard let target = workbench.status?.activeTurn?.target() else { return }; Task { await workbench.perform { _ = try await workbench.store.steerQueued(run: run, target: target) } } }
                                    .disabled(!canSteer)
                            }
                            Button("移回输入框", systemImage: "square.and.pencil") { Task { await workbench.perform {
                                if let taken = try await workbench.store.takeBackQueued(run: run) {
                                    if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft.text = taken.text } else { draft.text += "\n\n" + taken.text }
                                    let ids = Set(draft.attachments.map(\.id)); draft.attachments.append(contentsOf: taken.attachments.filter { !ids.contains($0.id) })
                                    draft.references = mergeRestoredReferences(current: draft.references, restored: taken.context)
                                }
                            } } }
                            Button("取消", systemImage: "trash", role: .destructive) { Task { await workbench.perform { _ = try await workbench.store.cancelRun(run: run) } } }
                        } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                            .accessibilityLabel("更多操作")
                    }.font(.caption).disabled(workbench.sendState.pendingRunIds.contains(run.id) || !SendPhaseKt.inQueue(run: run))
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            }
            if !workbench.queued.isEmpty && workbench.status?.queue?.held?.reason == .unconfirmed {
                Text("等待上一条消息确认").riffetFont(.caption).foregroundStyle(palette.fg3).padding(.leading, 6)
            }
        }
    }
}

/// The model control's trailing glyph, in a fixed slot: progress while its catalog loads, a warning
/// once reading it failed (the sheet it opens says why and retries), the picker chevron otherwise.
struct CatalogStatusSlot: View {
    let loading: Bool
    let failed: Bool
    var body: some View {
        Group {
            if loading { ProgressView().controlSize(.mini) }
            else if failed { Image(systemName: "exclamationmark.triangle.fill").font(.caption2).foregroundStyle(.orange) }
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
    private var key: String { "thumbnail:" + attachmentID }
    var body: some View {
        let shown = image ?? ConversationLayoutMemo.shared.image(key)
        ZStack {
            if let shown { Image(uiImage: shown).resizable().scaledToFill() }
            else { Image(systemName: "photo").foregroundStyle(.secondary) }
        }
        .frame(width: 44, height: 44)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .topTrailing) {
            Button("移除附件", systemImage: "xmark.circle.fill", action: remove)
                .labelStyle(.iconOnly).font(.system(size: 16)).symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.55))
                .frame(width: 30, height: 30, alignment: .topTrailing).offset(x: 6, y: -6)
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
            Image(systemName: "apple.terminal").font(.system(size: 15)).foregroundStyle(palette.fg3)
            Text(error ?? String(localized: "在终端中", bundle: .riffet)).foregroundStyle(error == nil ? palette.fg2 : palette.danger).lineLimit(2)
            Spacer(minLength: 8)
            Button("收回") { release(force: false) }.tint(palette.accent).disabled(releasing)
        }
        .riffetFont(.label).padding(.horizontal, 16).frame(minHeight: RiffetMetrics.hitTarget + 8).riffetComposerSurface()
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
