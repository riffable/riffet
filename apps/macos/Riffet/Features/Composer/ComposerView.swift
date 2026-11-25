import LocalAuthentication
import SwiftUI
import RiffetKit

/// The input card. ⌘↩ sends using the running-task preference, ⇧⌘↩ interrupts and sends now; Return is a
/// newline unless the reader made it send. One action button: send when there is something to send,
/// stop while a turn runs and the input is empty. `/` opens commands and skills, `@` cites a file.
struct ComposerView<Controls: View, Trailing: View>: View {
    @Bindable var model: ComposerModel
    let placeholder: String
    let working: Bool
    /// Background subagents running while the main agent is idle: the stop button shows for them too.
    var background = 0
    let sendState: ComposerSendState?
    var minLines: CGFloat = 1
    var features = ComposerFeatures()
    var sendEnabled = true
    /// The send button waits on its own result (a creation in flight): it shows a spinner.
    var busy = false
    /// Fullscreen editing, owned by the page so it can hide what the editor covers.
    var fullscreen: Binding<Bool>?
    let onSend: (_ interrupt: Bool) -> Void
    let onStop: (() -> Void)?
    let upload: (PickedFile) async throws -> Attachment
    /// How the agent should behave (approval, mode), after the attachment button.
    @ViewBuilder let controls: Controls
    /// What the message runs as (context, model and its parameters), next to the send button.
    @ViewBuilder let trailing: Trailing

    @Environment(\.palette) private var palette
    @Environment(\.workbenchScope) private var scope
    @Environment(\.covered) private var covered
    @Environment(\.composerEscape) private var escape
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var textHeight: CGFloat = 0
    @State private var pickingLater = false
    @State private var laterDate = Date.now
    /// The draft this view last showed: a change of draft (another conversation's) is not animated.
    @State private var shownDraft: ObjectIdentifier?
    @State private var highlight = 0
    @State private var dismissed: (text: String, caret: Int)?
    @State private var files: [FileEntry] = []
    @State private var filesLoading = false
    @State private var cardHeight: CGFloat = 0
    @State private var menuHeight: CGFloat = 0
    /// Unknown (`nil`) until measured; until then the last space of this kind of composer stands in.
    @State private var barSpace: CGFloat?
    @State private var controlsWidth: CGFloat?
    @State private var trailingWidth: CGFloat?
    /// The input method holds text it has not committed yet; `model.text` does not include it.
    @State private var composing = false
    /// Filled by a skills-and-tools picker among the controls: the + button then opens a menu.
    @State private var toolsSlot = ComposerToolsSlot()
    @State private var attachAnchor = MenuAnchor()

    private let lineHeight: CGFloat = 21
    private let fullscreenButtonSize: CGFloat = 26

    private var isFullscreen: Bool { fullscreen?.wrappedValue == true }

    private var editorHeight: CGFloat {
        let minimum = lineHeight * minLines + 4
        return min(max(textHeight, minimum), 260)
    }

    private var hasText: Bool { !model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var showsFullscreenControl: Bool { fullscreen != nil && (hasText || composing || isFullscreen) }

    /// How the card's own size changes animate; nothing while it switches drafts or under Reduce Motion.
    private var motion: Animation? {
        reduceMotion || shownDraft != ObjectIdentifier(model) ? nil : ComposerMotion.resize
    }

    /// What changes the card's height besides the text: the attachment row and the status line.
    private struct LayoutKey: Equatable {
        let items: [UUID]
        let references: [String]
        let status: String?
    }

    // MARK: Menu state

    private var trigger: ComposerTrigger? {
        if let dismissed, dismissed.text == model.text, dismissed.caret == model.caret { return nil }
        guard let trigger = ComposerTrigger.detect(model.text, caret: model.caret) else { return nil }
        switch trigger {
        // A missing catalog still counts once the page can fetch one: typing `/` is what retries it.
        case .slash: return features.slash == nil && features.onSlashOpen == nil ? nil : trigger
        case .mention: return features.searchFiles == nil && features.addSessionReference == nil ? nil : trigger
        }
    }

    private var slashGroups: [(skills: Bool, items: [NativeSlashItem])] {
        guard case let .slash(query, start, leading)? = trigger, let catalog = features.slash else { return [] }
        let slash = SlashTrigger(query: query, start: Int32(start), leading: leading)
        return catalog.groupsFor(trigger: slash).map { (skills: $0.first?.boolValue == true, items: $0.second as? [NativeSlashItem] ?? []) }
    }

    private var slashItems: [NativeSlashItem] { slashGroups.flatMap(\.items) }

    /// A typed leading command the catalog does not list is still sendable as text (`Composer.tsx`).
    private var unknownCommand: String? {
        guard case let .slash(query, _, leading)? = trigger, features.slash != nil, leading, !query.isEmpty, !slashItems.contains(where: { $0.name == query }) else { return nil }
        return query
    }

    private var sessionCandidates: [Session] {
        rankedSessionReferences(sessions: features.sessionCandidates, projects: features.sessionProjects, query: mentionQuery ?? "",
            currentSessionId: features.currentSessionId, projectId: features.projectId)
    }

    private var menuLength: Int {
        switch trigger {
        case .slash?: slashItems.count + (unknownCommand == nil ? 0 : 1)
        case .mention?: files.count + sessionCandidates.count
        case nil: 0
        }
    }

    private var menuOpen: Bool {
        switch trigger {
        case .mention?: true
        case .slash?: menuLength > 0
        case nil: false
        }
    }

    var body: some View {
        box
            .frame(maxHeight: isFullscreen ? .infinity : nil)
            .animation(motion, value: LayoutKey(items: model.items.map(\.id), references: features.references.map { $0.sessionId ?? $0.path }, status: statusMessage))
            // A conversation kept under the home page or a page takes the keyboard only once it is back.
            .onAppear {
                shownDraft = ObjectIdentifier(model)
                if !covered { model.focus() }
            }
            .onChange(of: ObjectIdentifier(model)) { _, draft in shownDraft = draft }
            .onChange(of: covered) { _, covered in if !covered { model.focus() } }
            .onReceive(NotificationCenter.default.publisher(for: .riffetFocusComposer)) { note in
                if note.targets(scope), !covered { model.focus() }
            }
            .onChange(of: trigger) { old, new in
                highlight = 0
                if case .slash? = new, old == nil || { if case .slash? = old { return false } else { return true } }() {
                    features.onSlashOpen?()
                }
            }
            .task(id: mentionQuery) { await searchFiles() }
            .zIndex(menuOpen ? 10 : 0)
    }

    /// The input surface: attachments, the text view, the status line and the toolbar.
    private var box: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !model.items.isEmpty || !features.references.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.sm) {
                        ForEach(features.references, id: \.self) { reference in
                            ReferenceChip(reference: reference, remove: { features.removeReference?(reference) }, open: reference.sessionId.map { id in { features.openSessionReference?(id) } })
                                .transition(.opacity)
                        }
                        ForEach(model.items) { item in
                            AttachmentChip(item: item) { model.remove(item.id) }
                                .transition(.opacity)
                        }
                    }
                    .padding(.horizontal, Space.md)
                    .padding(.top, 6)
                }
                .padding(.top, Space.sm)
                .transition(.opacity)
            }
            ZStack(alignment: .topLeading) {
                if model.text.isEmpty && !composing {
                    Text(placeholder)
                        .font(.riffet(size: S(14)))
                        .foregroundStyle(palette.fg4)
                        .padding(.top, 2)
                        .allowsHitTesting(false)
                }
                ComposerTextView(
                    text: $model.text,
                    height: $textHeight,
                    caret: $model.caret,
                    focusToken: model.focusToken,
                    caretRequest: model.caretRequest,
                    enterSends: features.enterSends,
                    fontSize: S(14),
                    resize: motion,
                    onSubmit: { interrupt in if sendEnabled && !model.schedulingLater { onSend(interrupt) } },
                    onPasteFiles: { _ in model.paste(upload: upload) },
                    onKey: handle,
                    onComposing: { composing = $0 }
                )
                .frame(height: isFullscreen ? nil : editorHeight)
                .frame(maxHeight: isFullscreen ? .infinity : nil)
            }
            .padding(.horizontal, Space.lg)
            .padding(.top, Space.md + 2)
            .contentShape(Rectangle())
            .onTapGesture { model.focus() }

            FeedbackRegion(value: statusMessage.map { StatusFeedback(text: $0, error: statusError != nil) }) { message, live in
                HStack {
                    Text(message.text)
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(live && message.error ? palette.danger : palette.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.xs)
                .transition(.opacity)
            }
            .id(ObjectIdentifier(model))
            HStack(spacing: Space.xxs) {
                attachButton
                sendLaterButton
                barView
                actionButton.padding(.leading, Space.xs)
            }
            .padding(.horizontal, Space.sm)
            .padding(.top, Space.xs)
            .padding(.bottom, Space.sm)
        }
        .frame(maxHeight: isFullscreen ? .infinity : nil)
        // The user bubble's radius: what is typed and what was sent share one shape.
        .background(
            RoundedRectangle(cornerRadius: Radius.floating, style: .continuous)
                .fill(palette.bgElevated)
                .elevation(.float)
        )
        .overlay(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { cardHeight = $0 }
        .overlay(alignment: .topLeading) {
            if menuOpen, let trigger {
                ComposerMenuView(
                    trigger: trigger, groups: slashGroups, unknownCommand: unknownCommand,
                    unknownHint: features.unknownCommandHint ?? String(localized: "将作为普通消息原样发送"),
                    files: files, filesLoading: filesLoading, supportsFiles: features.searchFiles != nil, sessions: sessionCandidates, projects: features.sessionProjects, highlight: highlight,
                    choose: choose, hover: { highlight = $0 }
                )
                .frame(maxWidth: 420)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { menuHeight = $0 }
                .offset(y: features.menuBelow ? cardHeight + 8 : -(menuHeight + 8))
                .transition(.opacity)
            }
        }
        .animation(Motion.fast, value: menuOpen)
    }

    /// The clock beside the attach button: the draft, with its attachments and references, goes to this conversation at a later time.
    @ViewBuilder
    private var sendLaterButton: some View {
        if let sendLater = features.sendLater {
            NativeMenuButton(entries: {
                var entries: [NativeMenuEntry] = TimePreset.moments.compactMap { preset in
                    preset.date().map { date in .item(preset.label) { sendLater(date) } }
                }
                entries.append(.separator)
                entries.append(.item(String(localized: "自定义时间…")) { laterDate = Date.now.addingTimeInterval(3600); pickingLater = true })
                return entries
            }) {
                Image(icon: "clock")
            }
            .buttonStyle(IconButtonStyle(size: 26))
            .disabled(!sendEnabled || !model.canSend || model.schedulingLater)
            .help("稍后发送")
            .accessibilityLabel("稍后发送")
            .stylePopover(isPresented: $pickingLater, arrowEdge: .top) {
                VStack(alignment: .trailing, spacing: Space.md) {
                    DatePicker("", selection: $laterDate, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                        .labelsHidden()
                        .datePickerStyle(.graphical)
                    Button("安排") { pickingLater = false; sendLater(laterDate) }
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                }
                .padding(Space.md)
            }
        }
    }

    private var attachButton: some View {
        Button {
            // As on the web: files, then a session reference (an @ the mention menu picks up), then the tools.
            var entries: [NativeMenuEntry] = [.item(String(localized: "添加图片或文件"), symbol: "paperclip") { model.pickFiles(upload: upload) }]
            if features.addSessionReference != nil {
                entries.append(.item(String(localized: "引用会话"), symbol: "at") { insertMention() })
            }
            toolsSlot.refresh?()
            if let tools = toolsSlot.entries {
                entries += [.separator, .submenu(String(localized: "技能与工具"), symbol: "puzzlepiece.extension", entries: tools())]
            }
            guard entries.count > 1 else { model.pickFiles(upload: upload); return }
            attachAnchor.popUp(entries: entries)
        } label: {
            Image(icon: "plus")
        }
        .buttonStyle(IconButtonStyle(size: 26))
        .background(MenuAnchorView(anchor: attachAnchor))
        .help("添加附件（也可以拖入或粘贴）")
    }

    /// Types an @ at the caret (after a space when it would join a word), which opens the mention menu.
    private func insertMention() {
        let ns = model.text as NSString
        let caret = min(max(model.caret, 0), ns.length)
        let before = caret > 0 ? ns.substring(with: NSRange(location: caret - 1, length: 1)) : ""
        let insert = before.isEmpty || before.rangeOfCharacter(from: .whitespacesAndNewlines) != nil ? "@" : " @"
        model.replace(text: ns.replacingCharacters(in: NSRange(location: caret, length: 0), with: insert), caret: caret + (insert as NSString).length)
        model.focus()
    }

    private func fullscreenButton(_ fullscreen: Binding<Bool>) -> some View {
        Button { withAnimation(reduceMotion ? nil : Motion.standard) { fullscreen.wrappedValue.toggle() }; model.focus() } label: {
            Image(icon: isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                .font(.riffet(size: S(11)))
        }
        .buttonStyle(IconButtonStyle(size: fullscreenButtonSize))
        .help(isFullscreen ? "退出全屏编辑 (esc)" : "全屏编辑")
        .accessibilityLabel(isFullscreen ? "退出全屏编辑 (esc)" : "全屏编辑")
    }

    private var barView: some View {
        bar
            .frame(maxWidth: .infinity)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                barSpace = width
                ComposerBarWidths.space[barKind] = width
            }
    }

    /// Compact once the regular controls no longer fit. Not `ViewThatFits`: that keeps both variants
    /// of every menu and model chip alive and measures them on each layout pass, which made resizing
    /// and opening panels take seconds. The regular width is the one last measured while it showed.
    /// A composer built again (the home page and quick chat are, on every open) starts from the space
    /// its kind last measured, so it does not show compact, then regular, while it measures. The
    /// controls' widths are its own: another conversation's (more chips) would keep this one compact.
    private var compactBar: Bool {
        // Start with the shrinkable controls until the available width has actually been measured.
        // Otherwise their full intrinsic width can prevent the window's first narrow layout.
        guard let space = barSpace ?? ComposerBarWidths.space[barKind], space > 0 else { return true }
        // Never shown regular yet: show it once to measure it.
        guard let controls = controlsWidth, let trailing = trailingWidth else { return false }
        let fullscreenWidth = showsFullscreenControl ? fullscreenButtonSize + Space.xxs : 0
        return controls + trailing + fullscreenWidth + Space.sm + Space.xxs * 2 > space
    }

    /// One entry per composer surface: each passes its own kinds of controls.
    private var barKind: ComposerBarWidths.Kind { .init(composer: ObjectIdentifier(Self.self)) }

    private var bar: some View {
        let compact = compactBar
        // Each group in its own row: a modifier on a bare list of views would stack them vertically.
        return HStack(spacing: Space.xxs) {
            HStack(spacing: Space.xxs) { controls }
                .fixedSize(horizontal: !compact, vertical: false)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    guard !compactBar else { return }
                    controlsWidth = width
                }
            Spacer(minLength: Space.sm)
            if showsFullscreenControl, let fullscreen {
                fullscreenButton(fullscreen).transition(.opacity)
            }
            HStack(spacing: Space.xxs) { trailing }
                .fixedSize(horizontal: !compact, vertical: false)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    guard !compactBar else { return }
                    trailingWidth = width
                }
        }
        .environment(\.compactControls, compact)
        .environment(\.composerToolsSlot, toolsSlot)
        .animation(motion, value: showsFullscreenControl)
    }

    private var mentionQuery: String? {
        if case let .mention(query, _)? = trigger { return query }
        return nil
    }

    private func searchFiles() async {
        guard let query = mentionQuery, !query.isEmpty, let search = features.searchFiles else {
            files = []
            filesLoading = false
            return
        }
        filesLoading = true
        try? await Task.sleep(for: .milliseconds(140))
        guard !Task.isCancelled else { return }
        let found = await search(query)
        guard !Task.isCancelled else { return }
        files = Array(found.filter { $0.kind == .file }.prefix(10))
        filesLoading = false
    }

    private func handle(_ key: ComposerKey) -> Bool {
        if key == .dismiss, !menuOpen, let fullscreen, fullscreen.wrappedValue {
            withAnimation(reduceMotion ? nil : Motion.standard) { fullscreen.wrappedValue = false }
            return true
        }
        // Nothing of the composer's is open: Escape belongs to whoever hosts it (the canvas's next-question panel).
        if key == .dismiss, !menuOpen, let escape { escape(); return true }
        guard menuOpen else { return false }
        switch key {
        case .up:
            guard menuLength > 0 else { return true }
            highlight = (highlight - 1 + menuLength) % menuLength
        case .down:
            guard menuLength > 0 else { return true }
            highlight = (highlight + 1) % menuLength
        case .accept:
            guard menuLength > 0 else { return false }
            choose(highlight)
        case .dismiss:
            dismissed = (model.text, model.caret)
        }
        return true
    }

    private func choose(_ index: Int) {
        guard let trigger else { return }
        switch trigger {
        case let .slash(query, start, leading):
            let items = slashItems
            if index < items.count {
                let slash = SlashTrigger(query: query, start: Int32(start), leading: leading)
                let picked = applySlashPick(text: model.text, caret: Int32(model.caret), trigger: slash, item: items[index])
                model.replace(text: picked.first as String? ?? model.text, caret: Int(truncating: picked.second ?? 0))
            } else if unknownCommand != nil {
                dismissed = (model.text, model.caret)
                onSend(false)
            }
        case let .mention(_, start):
            if index < files.count { features.addReference?(files[index].path) }
            else {
                let sessionIndex = index - files.count
                guard sessionIndex < sessionCandidates.count else { return }
                features.addSessionReference?(sessionCandidates[sessionIndex])
            }
            let ns = model.text as NSString
            let next = ns.replacingCharacters(in: NSRange(location: start, length: model.caret - start), with: "")
            model.replace(text: next, caret: start)
        }
    }

    /// One button that turns between send and stop: the arrow and the square trade places, the
    /// circle stays (docs/design/macos-native.md 1.3).
    private var actionButton: some View {
        let interrupting = sendState?.interrupting == true
        let stopping = onStop != nil && (interrupting || (working || background > 0) && !hasText)
        return Button { if stopping { onStop?() } else { onSend(false) } } label: {
            ZStack {
                Group {
                    if interrupting { Spinner(size: .mini) } else { Image(icon: "stop.fill").font(.riffet(size: S(10), weight: .bold)) }
                }
                .opacity(stopping ? 1 : 0)
                .scaleEffect(stopping ? 1 : 0.6)
                Group {
                    if busy { Spinner(size: .mini) } else { Image(icon: "arrow.up") }
                }
                .opacity(stopping ? 0 : 1)
                .scaleEffect(stopping ? 0.6 : 1)
            }
            .animation(reduceMotion ? nil : Motion.fast, value: stopping)
        }
        .buttonStyle(ComposerActionButtonStyle())
        .disabled(stopping
            ? sendState?.sending == true || interrupting
            : !sendEnabled || !model.canSend || model.schedulingLater || sendState?.sending == true || interrupting)
        .help(stopping
            ? (interrupting ? String(localized: "停止中") : working ? String(localized: "停止当前任务 (⌘.)") : String(localized: "停止后台任务 (⌘.)"))
            : working && onStop != nil ? String(localized: "\(features.steersWhileRunning ? String(localized: "补充到当前任务") : String(localized: "排队发送")) (\(sendKey))；⇧⌘↩ 停止并发送") : String(localized: "发送 (\(sendKey))"))
        .accessibilityLabel(stopping
            ? (interrupting ? String(localized: "停止中") : working ? String(localized: "停止当前任务") : String(localized: "停止后台任务"))
            : working ? (features.steersWhileRunning ? String(localized: "补充到当前任务") : String(localized: "加入发送队列")) : String(localized: "发送消息"))
        .contextMenu {
            if !stopping, working {
                if let enqueue = features.enqueue { Button("加入队列", action: enqueue).disabled(!sendEnabled || !model.canSend) }
                if let onStop {
                    Button("停止当前任务", action: onStop).disabled(sendState?.sending == true || interrupting)
                    Button("停止并发送") { onSend(true) }.disabled(!model.canSend || sendState?.sending == true || interrupting)
                }
            }
        }
    }

    private var sendKey: String { features.enterSends ? "↩" : "⌘↩" }

    private var statusError: String? { sendState?.error ?? model.notice }

    private struct StatusFeedback: Equatable {
        let text: String
        let error: Bool
    }

    private var statusMessage: String? {
        if let error = statusError { return error }
        // Delivery recovery is owned by the request dock, including in fullscreen.
        return nil
    }
}

/// The send / stop button: a solid circle.
private struct ComposerActionButtonStyle: ButtonStyle {
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.riffet(size: S(13), weight: .bold))
            .foregroundStyle(enabled ? palette.primaryFg : palette.fg4)
            .frame(width: 30, height: 30)
            .background(Circle().fill(enabled ? palette.primary : palette.bgMuted))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(Motion.fast, value: configuration.isPressed)
            .contentShape(Circle())
    }
}

/// The one motion for what changes size around the input: cards and docks arriving above it, rows
/// inside it, its height after a send. Short and the same everywhere; callers drop it under Reduce Motion.
enum ComposerMotion {
    static let resize = Motion.standard
    /// Fades in rising a little, and leaves the same way, as the share sheet's toast does.
    static let insert = AnyTransition.opacity.combined(with: .offset(y: 8))
}

/// The composer bar's last measured space, per kind of composer (`ComposerView.barKind`).
private enum ComposerBarWidths {
    struct Kind: Hashable {
        let composer: ObjectIdentifier
    }
    static var space: [Kind: CGFloat] = [:]
}

extension ComposerView where Trailing == EmptyView {
    init(
        model: ComposerModel, placeholder: String, working: Bool, background: Int = 0, sendState: ComposerSendState?, minLines: CGFloat = 1,
        features: ComposerFeatures = ComposerFeatures(), fullscreen: Binding<Bool>? = nil,
        onSend: @escaping (_ interrupt: Bool) -> Void, onStop: (() -> Void)?,
        upload: @escaping (PickedFile) async throws -> Attachment, @ViewBuilder controls: () -> Controls
    ) {
        self.init(
            model: model, placeholder: placeholder, working: working, background: background, sendState: sendState, minLines: minLines,
            features: features, fullscreen: fullscreen, onSend: onSend, onStop: onStop, upload: upload,
            controls: controls, trailing: { EmptyView() }
        )
    }
}

struct AttachmentChip: View {
    let item: ComposerModel.Item
    let remove: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false
    @State private var loadedPreview: NSImage?
    @State private var imageAnchor = ImageViewer.Anchor()
    @State private var previewHidden = false

    var body: some View {
        HStack(spacing: Space.sm) {
            Group {
                if let preview = item.file.preview ?? loadedPreview {
                    Image(nsImage: preview).resizable().aspectRatio(contentMode: .fill)
                } else if isImage {
                    Image(icon: "photo").font(.riffet(size: S(14))).foregroundStyle(palette.fg3)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(palette.bgMuted)
                } else {
                    Image(icon: "doc.fill").font(.riffet(size: S(14))).foregroundStyle(palette.fg3)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(palette.bgMuted)
                }
            }
            .frame(width: 36, height: 36)
            .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .background(ImageViewerAnchorView(anchor: imageAnchor).id(item.id).allowsHitTesting(false))
            .opacity(previewHidden ? 0 : 1)
            .contentShape(Rectangle())
            .onTapGesture { preview() }
            .help(isImage ? String(localized: "预览") : item.file.name)
            VStack(alignment: .leading, spacing: 1) {
                Text(displayName).font(.riffet(size: S(12))).foregroundStyle(palette.fg).lineLimit(1)
                Group {
                    switch item.state {
                    case .uploading: Text("上传中…")
                    case let .uploaded(attachment):
                        let byteCount = Int64(item.file.bytes.size) > 0 ? Int64(item.file.bytes.size) : attachment.size
                        Text(ByteCountFormatter.string(fromByteCount: byteCount, countStyle: .file))
                    case let .failed(message): Text(message).foregroundStyle(palette.danger)
                    }
                }
                .font(.riffet(size: S(11)))
                .foregroundStyle(palette.fg3)
                .lineLimit(1)
            }
            .frame(maxWidth: 150, alignment: .leading)
        }
        .padding(Space.xs)
        .padding(.trailing, Space.xs)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
        .overlay(alignment: .topTrailing) {
            Button(action: remove) {
                Image(icon: "xmark").font(.riffet(size: S(8), weight: .bold))
                    .foregroundStyle(palette.primaryFg)
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(palette.fg3))
            }
            .buttonStyle(.plain)
            .offset(x: 5, y: -5)
            .opacity(hovering ? 1 : 0)
        }
        .onHover { hovering = $0 }
        .task(id: item.id) {
            guard isImage, item.file.preview == nil, loadedPreview == nil, case let .uploaded(attachment) = item.state else { return }
            loadedPreview = await ImageLoader.shared.image(for: .attachment(attachment.id), projectId: nil)
        }
    }

    private var isImage: Bool { item.file.mimeType.hasPrefix("image/") }

    private var displayName: String {
        let name = item.file.name
        if name.hasPrefix("粘贴的图片") || name.hasPrefix("pasted.") { // i18n-ignore: matches generated attachment file name
            let ext = (name as NSString).pathExtension.uppercased()
            return ext.isEmpty ? "PNG" : ext
        }
        return name
    }

    /// The web's composer chip opens its image in the viewer; uploaded ones load the stored original.
    private func preview() {
        guard isImage else { return }
        let source: TimelineImageSource
        if case let .uploaded(attachment) = item.state {
            source = .attachment(attachment.id)
        } else if !item.file.data.isEmpty {
            source = .local(item.file.data)
        } else {
            return
        }
        let name = item.file.name
        if let image = item.file.preview ?? loadedPreview {
            ImageViewer.shared.show(image: image, source: source, projectId: nil, label: name,
                origin: imageAnchor.origin(cropped: true, visibility: { previewHidden = !$0 }))
        } else {
            Task {
                guard let image = await ImageLoader.shared.image(for: source, projectId: nil) else { return }
                guard imageAnchor.view?.window != nil else { return }
                loadedPreview = image
                ImageViewer.shared.show(image: image, source: source, projectId: nil, label: name,
                    origin: imageAnchor.origin(cropped: true, visibility: { previewHidden = !$0 }))
            }
        }
    }
}

/// Approval for the open conversation: how the agent should behave. Its mode is chosen when it starts.
struct SessionControls: View {
    let workbench: Workbench
    let session: Session
    let catalog: NativeBackendCatalogEntry?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Space.xxs) {
            if let catalog {
                if catalog.capabilities.supportsPermissionSelection, !catalog.capabilities.permissions.isEmpty {
                    OptionMenu(title: String(localized: "审批"), options: catalog.capabilities.permissions, selection: session.approval ?? workbench.status?.approval ?? catalog.capabilities.permissions.first?.id ?? "") { value in
                        Task { await workbench.setApproval(value, for: session.id) }
                    }
                    .equatable()
                    .help("审批")
                    .transition(.opacity)
                }
                if session.agentID != AgentDirectory.quickChat, session.archivedAt == nil {
                    SessionToolsPicker(workbench: workbench, session: session, capabilities: catalog.capabilities)
                        .transition(.opacity)
                }
            }
        }
        // The catalog arrives after the bar: its chip fades in rather than popping.
        .animation(reduceMotion ? nil : ComposerMotion.resize, value: catalog != nil)
        .id("\(session.id)|\(session.agentID)|\(session.backendProfileId ?? "")")
    }
}

/// What the open conversation runs as: the context meter, the model and its parameters
/// (`PickerOptions.kt`'s Fast, Max, thinking and effort rules).
struct SessionModelControls: View {
    let workbench: Workbench
    let session: Session
    let catalog: NativeBackendCatalogEntry?
    var quickChat = false
    /// The catalog is still being read: the chip waits with a spinner.
    var loading = false
    /// Re-reads the session's catalog as the list opens.
    var refresh: (() async -> Void)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The current provider and those the conversation can move to, in the catalog's order. Empty
    /// (a flat list, fixed provider) when nothing qualifies.
    private var providers: [ProviderModels] {
        guard let catalog, let current = session.backendProfileId else { return [] }
        let continuations = workbench.catalogs.continuations(for: session)
        guard !continuations.isEmpty, let profile = catalog.profiles.first(where: { $0.id == current }) else { return [] }
        let entries = [ProviderModels(profile: profile, models: catalog.models)]
            + continuations.map { ProviderModels(profile: $0.profile, models: $0.models) }
        let order = Dictionary(catalog.profiles.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        return entries.enumerated().sorted {
            (order[$0.element.id] ?? Int.max, $0.offset) < (order[$1.element.id] ?? Int.max, $1.offset)
        }.map(\.element)
    }

    private var showsMeter: Bool { !quickChat && (workbench.context?.size ?? 0) > 0 }

    var body: some View {
        HStack(spacing: Space.xxs) {
            if showsMeter, let context = workbench.context {
                ContextMeter(context: context).transition(.opacity)
            }
            if let catalog, catalog.capabilities.supportsModelSelection {
                ModelControls(catalog: catalog.models, selection: session.model, usage: quickChat ? nil : {
                    try? await workbench.host.api?.agentUsage(agentId: session.agentID, projectId: nil, profileId: nil, sessionId: session.id, global: false)
                }, reserveAccountUsage: !quickChat && session.agentID == "codex", loading: loading, providers: providers, activeProviderId: session.backendProfileId, chooseInProvider: { provider, value in
                    Task { await workbench.switchProfile(provider, model: value, for: session.id) }
                }, scope: "\(session.id)|\(session.agentID)|\(session.backendProfileId ?? "")|\(workbench.catalogs.connectionRevision)",
                   usageStoreKey: "\(workbench.baseURL.absoluteString)|\(session.id)|\(session.agentID)|\(session.backendProfileId ?? "")",
                   remembered: workbench.settings?.defaultsFor(agent: session.agentID)?.profileModels ?? [:], refresh: refresh) { value in
                    Task { await workbench.setModel(value, for: session.id) }
                }
                .id("\(session.id)|\(session.agentID)|\(session.backendProfileId ?? "")")
                .transition(.opacity)
            } else if loading, catalog == nil {
                ModelControls(catalog: [], selection: session.model, loading: true) { _ in }
                    .transition(.opacity)
            }
        }
        // The meter and the model chip arrive after the bar (the first usage, the catalog): they fade in.
        .animation(reduceMotion ? nil : ComposerMotion.resize, value: [showsMeter, catalog != nil])
        // Another conversation's controls replace these at once, rather than fading across them.
        .id(session.id)
    }
}

/// The provider's window or compaction meter, from its own count (`Composer.tsx`'s
/// `ContextMeter`); nothing at all when the backend does not report one.
struct ContextMeter: View {
    let context: NativeContext
    @Environment(\.palette) private var palette
    @State private var open = false

    private static let labels = [
        "system_prompt": String(localized: "系统提示词"), "tools": String(localized: "工具定义"), "rules": String(localized: "规则"), "skills": "Skills",
        "mcp": String(localized: "MCP 与动态工具"), "subagents": String(localized: "子 Agent 定义"), "summarized_conversation": String(localized: "已压缩的对话"), "conversation": String(localized: "对话"),
        "cached_input": String(localized: "缓存输入"), "cacheRead": String(localized: "缓存读取"), "cache_write": String(localized: "缓存写入"), "cacheWrite": String(localized: "缓存写入"), "reasoning_output": String(localized: "思考输出"),
        "systemPrompt": String(localized: "系统提示词"), "toolDefinitions": String(localized: "工具定义"), "developerMessages": String(localized: "指令"), "userMessages": String(localized: "你的消息"),
        "assistantMessages": String(localized: "回复"), "toolResponses": String(localized: "工具结果"), "otherMessages": String(localized: "其他"),
    ]

    private func partLabel(_ part: NativeContextBreakdown) -> String {
        if part.id == "input" {
            let splitFromCache = parts.contains { ["cached_input", "cacheRead", "cacheWrite"].contains($0.id) }
            return splitFromCache ? String(localized: "未缓存输入") : String(localized: "输入")
        }
        if part.id == "output" {
            return parts.contains { $0.id == "reasoning_output" } ? String(localized: "回复输出") : String(localized: "输出")
        }
        return Self.labels[part.id] ?? (part.label.isEmpty ? part.id : part.label)
    }

    private var ratio: Double { min(1, max(0, Double(context.used) / Double(context.size))) }
    private var title: String { String(localized: "上下文用量") }
    private var breakdownTotal: Int64 { parts.reduce(0) { $0 + $1.tokens } }
    private var breakdownBase: Int64 {
        context.breakdownEstimated ? max(breakdownTotal, 1) : max(1, max(context.size, max(context.used, breakdownTotal)))
    }
    private func formatShare(_ tokens: Int64) -> String {
        let pct = Double(tokens) / Double(breakdownBase) * 100
        return tokens > 0 && pct < 1 ? "<1%" : "\(Int(pct.rounded()))%"
    }
    /// The chip's own ink until the window runs short: the ring is a glance, not an accent.
    private var tone: Color { ratio >= 0.9 ? palette.danger : ratio >= 0.75 ? palette.warning : palette.fg2 }

    var body: some View {
        Button { open.toggle() } label: {
            // The ring alone; the figures are in the tooltip and the popover.
            ZStack {
                Circle().stroke(palette.lineStrong, lineWidth: 2)
                Circle().trim(from: 0, to: ratio).stroke(tone, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
            }
            .frame(width: S(13), height: S(13))
        }
        .buttonStyle(ChipButtonStyle())
        .help(hint)
        .accessibilityLabel(title)
        .accessibilityValue(Text(verbatim: "\(percent)%"))
        .stylePopover(isPresented: $open, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(title).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
                        Text("\(percent)%").font(.riffet(size: S(13)).monospacedDigit()).foregroundStyle(palette.fg3)
                    }
                    Spacer()
                    Text("\(Self.compactTokens(context.used)) / \(Self.compactTokens(context.size))")
                        .font(.riffet(size: S(13)).monospacedDigit())
                        .foregroundStyle(palette.fg3)
                }
                bar.padding(.top, Space.sm)
                if context.limitKind == "compaction" {
                    Text("自动压缩阈值 \(Self.compactTokens(context.size)) tokens · 按最近一次响应计量")
                        .font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, Space.sm)
                }
                if !parts.isEmpty {
                    VStack(spacing: 6) {
                        if context.breakdownEstimated {
                            Text("内容估算 · ~\(Self.compactTokens(breakdownTotal))")
                                .font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ForEach(parts, id: \.id) { part in
                            HStack(spacing: Space.sm) {
                                Text(partLabel(part)).font(.riffet(size: S(12))).foregroundStyle(palette.fg2).lineLimit(1)
                                Spacer(minLength: Space.sm)
                                Text("\(context.breakdownEstimated ? "~" : "")\(Self.compactTokens(part.tokens))").font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3)
                                Text(formatShare(part.tokens))
                                    .font(.riffet(size: S(12)).monospacedDigit())
                                    .foregroundStyle(palette.fg3)
                                    .frame(width: 40, alignment: .trailing)
                            }
                        }
                    }
                    .padding(.top, Space.md)
                }
            }
            .padding(12)
            .frame(width: 288)
        }
    }

    private var percent: Int { Int((Double(context.used) / Double(context.size) * 100).rounded()) }
    private var hint: String { "\(title) \(percent)% · \(Self.compactTokens(context.used)) / \(Self.compactTokens(context.size))" }

    /// The breakdown without empty parts, as the web lists it.
    private var parts: [NativeContextBreakdown] { context.breakdown.filter { $0.tokens > 0 } }

    /// The used share as one rounded bar of contiguous segments, each a lighter step of the tone.
    private var bar: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                if parts.isEmpty || context.breakdownEstimated {
                    Rectangle().fill(tone).frame(width: geometry.size.width * ratio)
                } else {
                    ForEach(Array(parts.enumerated()), id: \.element.id) { index, part in
                        Rectangle()
                            .fill(tone.opacity(1 - Double(index) * (0.7 / Double(parts.count))))
                            .frame(width: geometry.size.width * ratio * Double(part.tokens) / Double(max(1, max(context.used, breakdownTotal))))
                    }
                }
                Spacer(minLength: 0)
            }
            .background(palette.line)
            .clipShape(Capsule())
        }
        .frame(height: 6)
    }

    static func compactTokens(_ value: Int64) -> String {
        if value >= 10_000 { return "\((value + 500) / 1000)k" }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1000.0) }
        return "\(value)"
    }
}

enum PermissionIconStyle: String, CaseIterable, Identifiable {
    case shield, semantic, gate, ring
    var id: String { rawValue }
    var title: String {
        switch self {
        case .shield: String(localized: "盾牌")
        case .semantic: String(localized: "语义")
        case .gate: String(localized: "门禁")
        case .ring: String(localized: "圆环")
        }
    }
}

enum PermissionTier: String, CaseIterable, Identifiable {
    case read, ask, `default`, workspace, auto, deny, full
    var id: String { rawValue }
    var title: String {
        switch self {
        case .read: String(localized: "只读")
        case .ask: String(localized: "每次询问")
        case .default: String(localized: "默认")
        case .workspace: String(localized: "工作区")
        case .auto: String(localized: "自动审查")
        case .deny: String(localized: "拒绝")
        case .full: String(localized: "全部放行")
        }
    }

    static func of(_ mode: String) -> PermissionTier {
        switch mode {
        case "read-only", "plan": .read
        case "allowlist", "manual", "off", "request-review": .ask
        case "default", "strict", "low": .default
        case "acceptEdits", "on-request", "workspace-write", "proceed-in-sandbox", "medium": .workspace
        case "auto-review", "auto": .auto
        case "dontAsk": .deny
        case "unrestricted", "bypassPermissions", "danger-full-access", "always-proceed", "high", "never": .full
        default: .default
        }
    }
}

enum PermissionIconGlyphs {
    struct Shape {
        var stroke = Path()
        var dashed = Path()
        var fills: [CGRect] = []
    }

    private static var shieldOutline: Path {
        var p = Path()
        p.move(to: CGPoint(x: 12, y: 2.3))
        p.addCurve(to: CGPoint(x: 19, y: 5), control1: CGPoint(x: 14.2, y: 3.8), control2: CGPoint(x: 17, y: 5))
        p.addQuadCurve(to: CGPoint(x: 20, y: 6), control: CGPoint(x: 20, y: 5))
        p.addLine(to: CGPoint(x: 20, y: 13))
        p.addCurve(to: CGPoint(x: 12, y: 22), control1: CGPoint(x: 20, y: 18), control2: CGPoint(x: 16.5, y: 20.5))
        p.addCurve(to: CGPoint(x: 4, y: 13), control1: CGPoint(x: 7.5, y: 20.5), control2: CGPoint(x: 4, y: 18))
        p.addLine(to: CGPoint(x: 4, y: 6))
        p.addQuadCurve(to: CGPoint(x: 5, y: 5), control: CGPoint(x: 4, y: 5))
        p.addCurve(to: CGPoint(x: 12, y: 2.3), control1: CGPoint(x: 7, y: 5), control2: CGPoint(x: 9.8, y: 3.8))
        p.closeSubpath()
        return p
    }

    private static var gateOpen: Path {
        var p = Path()
        p.move(to: CGPoint(x: 8.5, y: 4))
        p.addLine(to: CGPoint(x: 6.5, y: 4))
        p.addQuadCurve(to: CGPoint(x: 4, y: 6.5), control: CGPoint(x: 4, y: 4))
        p.addLine(to: CGPoint(x: 4, y: 17.5))
        p.addQuadCurve(to: CGPoint(x: 6.5, y: 20), control: CGPoint(x: 4, y: 20))
        p.addLine(to: CGPoint(x: 8.5, y: 20))
        p.move(to: CGPoint(x: 15.5, y: 4))
        p.addLine(to: CGPoint(x: 17.5, y: 4))
        p.addQuadCurve(to: CGPoint(x: 20, y: 6.5), control: CGPoint(x: 20, y: 4))
        p.addLine(to: CGPoint(x: 20, y: 17.5))
        p.addQuadCurve(to: CGPoint(x: 17.5, y: 20), control: CGPoint(x: 20, y: 20))
        p.addLine(to: CGPoint(x: 15.5, y: 20))
        return p
    }

    private static func addInner(_ tier: PermissionTier, cy: CGFloat, to shape: inout Shape) {
        switch tier {
        case .read:
            shape.stroke.move(to: CGPoint(x: 8.25, y: cy))
            shape.stroke.addQuadCurve(to: CGPoint(x: 15.75, y: cy), control: CGPoint(x: 12, y: cy - 3))
            shape.stroke.addQuadCurve(to: CGPoint(x: 8.25, y: cy), control: CGPoint(x: 12, y: cy + 3))
            shape.stroke.closeSubpath()
            shape.fills.append(CGRect(x: 11.1, y: cy - 0.9, width: 1.8, height: 1.8))
        case .ask:
            shape.stroke.move(to: CGPoint(x: 9.85, y: cy - 1.5))
            shape.stroke.addCurve(to: CGPoint(x: 11.9, y: cy - 3.3), control1: CGPoint(x: 9.85, y: cy - 2.65), control2: CGPoint(x: 10.75, y: cy - 3.3))
            shape.stroke.addCurve(to: CGPoint(x: 13.9, y: cy - 1.65), control1: CGPoint(x: 13.05, y: cy - 3.3), control2: CGPoint(x: 13.9, y: cy - 2.65))
            shape.stroke.addCurve(to: CGPoint(x: 12.55, y: cy + 0.15), control1: CGPoint(x: 13.9, y: cy - 0.7), control2: CGPoint(x: 13.25, y: cy - 0.25))
            shape.stroke.addCurve(to: CGPoint(x: 12, y: cy + 1.2), control1: CGPoint(x: 12.15, y: cy + 0.4), control2: CGPoint(x: 12, y: cy + 0.7))
            shape.fills.append(CGRect(x: 11.2, y: cy + 2.3, width: 1.6, height: 1.6))
        case .default:
            shape.stroke.move(to: CGPoint(x: 9.1, y: cy))
            shape.stroke.addLine(to: CGPoint(x: 11, y: cy + 1.9))
            shape.stroke.addLine(to: CGPoint(x: 14.9, y: cy - 2))
        case .workspace:
            shape.stroke.move(to: CGPoint(x: 10.3, y: cy - 1.9))
            shape.stroke.addLine(to: CGPoint(x: 8.4, y: cy))
            shape.stroke.addLine(to: CGPoint(x: 10.3, y: cy + 1.9))
            shape.stroke.move(to: CGPoint(x: 13.7, y: cy - 1.9))
            shape.stroke.addLine(to: CGPoint(x: 15.6, y: cy))
            shape.stroke.addLine(to: CGPoint(x: 13.7, y: cy + 1.9))
        case .auto:
            let r: CGFloat = 3.6
            shape.stroke.move(to: CGPoint(x: 12, y: cy - r))
            shape.stroke.addQuadCurve(to: CGPoint(x: 12 + r, y: cy), control: CGPoint(x: 12, y: cy))
            shape.stroke.addQuadCurve(to: CGPoint(x: 12, y: cy + r), control: CGPoint(x: 12, y: cy))
            shape.stroke.addQuadCurve(to: CGPoint(x: 12 - r, y: cy), control: CGPoint(x: 12, y: cy))
            shape.stroke.addQuadCurve(to: CGPoint(x: 12, y: cy - r), control: CGPoint(x: 12, y: cy))
            shape.stroke.closeSubpath()
        case .deny:
            shape.stroke.move(to: CGPoint(x: 9.8, y: cy - 2.2))
            shape.stroke.addLine(to: CGPoint(x: 14.2, y: cy + 2.2))
            shape.stroke.move(to: CGPoint(x: 14.2, y: cy - 2.2))
            shape.stroke.addLine(to: CGPoint(x: 9.8, y: cy + 2.2))
        case .full:
            shape.stroke.move(to: CGPoint(x: 12.5, y: cy - 3.6))
            shape.stroke.addLine(to: CGPoint(x: 9.6, y: cy + 0.2))
            shape.stroke.addLine(to: CGPoint(x: 14.4, y: cy + 0.2))
            shape.stroke.addLine(to: CGPoint(x: 11.5, y: cy + 3.6))
        }
    }

    static func shape(for tier: PermissionTier, style: PermissionIconStyle) -> Shape {
        var out = Shape()
        switch style {
        case .shield:
            out.stroke.addPath(shieldOutline)
            addInner(tier, cy: 11.4, to: &out)
        case .semantic:
            switch tier {
            case .read:
                out.stroke.move(to: CGPoint(x: 2.2, y: 12))
                out.stroke.addQuadCurve(to: CGPoint(x: 21.8, y: 12), control: CGPoint(x: 12, y: 4.2))
                out.stroke.addQuadCurve(to: CGPoint(x: 2.2, y: 12), control: CGPoint(x: 12, y: 19.8))
                out.stroke.closeSubpath()
                out.stroke.addEllipse(in: CGRect(x: 9, y: 9, width: 6, height: 6))
            case .ask:
                out.stroke.addArc(
                    center: CGPoint(x: 12, y: 12),
                    radius: 9,
                    startAngle: .radians(atan2(8.0, -4.1)),
                    endAngle: .radians(atan2(4.1, -8.0)),
                    clockwise: true
                )
                out.stroke.addLine(to: CGPoint(x: 2, y: 22))
                out.stroke.closeSubpath()
                addInner(.ask, cy: 12, to: &out)
            case .default:
                out.stroke.addPath(shieldOutline)
                addInner(.default, cy: 11.4, to: &out)
            case .workspace:
                out.stroke.move(to: CGPoint(x: 8, y: 8))
                out.stroke.addLine(to: CGPoint(x: 4, y: 12))
                out.stroke.addLine(to: CGPoint(x: 8, y: 16))
                out.stroke.move(to: CGPoint(x: 16, y: 8))
                out.stroke.addLine(to: CGPoint(x: 20, y: 12))
                out.stroke.addLine(to: CGPoint(x: 16, y: 16))
                out.stroke.move(to: CGPoint(x: 13.5, y: 6))
                out.stroke.addLine(to: CGPoint(x: 10.5, y: 18))
            case .auto:
                out.stroke.move(to: CGPoint(x: 12, y: 3))
                out.stroke.addQuadCurve(to: CGPoint(x: 21, y: 12), control: CGPoint(x: 12, y: 12))
                out.stroke.addQuadCurve(to: CGPoint(x: 12, y: 21), control: CGPoint(x: 12, y: 12))
                out.stroke.addQuadCurve(to: CGPoint(x: 3, y: 12), control: CGPoint(x: 12, y: 12))
                out.stroke.addQuadCurve(to: CGPoint(x: 12, y: 3), control: CGPoint(x: 12, y: 12))
                out.stroke.closeSubpath()
                out.stroke.move(to: CGPoint(x: 19, y: 4))
                out.stroke.addLine(to: CGPoint(x: 19, y: 7))
                out.stroke.move(to: CGPoint(x: 17.5, y: 5.5))
                out.stroke.addLine(to: CGPoint(x: 20.5, y: 5.5))
            case .deny:
                out.stroke.addEllipse(in: CGRect(x: 3, y: 3, width: 18, height: 18))
                out.stroke.move(to: CGPoint(x: 5.64, y: 5.64))
                out.stroke.addLine(to: CGPoint(x: 18.36, y: 18.36))
            case .full:
                out.stroke.move(to: CGPoint(x: 13, y: 3))
                out.stroke.addLine(to: CGPoint(x: 5, y: 13.5))
                out.stroke.addLine(to: CGPoint(x: 11.5, y: 13.5))
                out.stroke.addLine(to: CGPoint(x: 11, y: 21))
                out.stroke.addLine(to: CGPoint(x: 19, y: 10.5))
                out.stroke.addLine(to: CGPoint(x: 12.5, y: 10.5))
                out.stroke.closeSubpath()
            }
        case .gate:
            if tier == .ask || tier == .auto || tier == .full {
                out.stroke.addPath(gateOpen)
            } else {
                out.stroke.addRoundedRect(in: CGRect(x: 4, y: 4, width: 16, height: 16), cornerSize: CGSize(width: 3.5, height: 3.5))
            }
            addInner(tier, cy: 12, to: &out)
        case .ring:
            let circle = CGRect(x: 3, y: 3, width: 18, height: 18)
            if tier == .auto {
                out.dashed.addEllipse(in: circle)
            } else {
                out.stroke.addEllipse(in: circle)
            }
            addInner(tier, cy: 12, to: &out)
        }
        return out
    }

    static func menuImage(for mode: String, style: PermissionIconStyle, color: NSColor? = nil) -> NSImage {
        let size: CGFloat = 15
        let shape = Self.shape(for: .of(mode), style: style)
        let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let scale = size / 24
            ctx.scaleBy(x: scale, y: scale)
            let ink = (color ?? .labelColor).cgColor
            ctx.setStrokeColor(ink)
            ctx.setFillColor(ink)
            ctx.setLineWidth(1.25 / scale)
            ctx.setLineCap(.round)
            ctx.setLineJoin(.round)
            ctx.addPath(shape.stroke.cgPath)
            ctx.strokePath()
            if !shape.dashed.isEmpty {
                ctx.saveGState()
                ctx.setLineDash(phase: 0, lengths: [3.5, 2.5])
                ctx.addPath(shape.dashed.cgPath)
                ctx.strokePath()
                ctx.restoreGState()
            }
            for rect in shape.fills {
                ctx.fillEllipse(in: rect)
            }
            return true
        }
        image.isTemplate = color == nil
        return image
    }
}

struct PermissionIconView: View {
    let tier: PermissionTier
    var style: PermissionIconStyle? = nil
    var size: CGFloat = 15
    var color: Color? = nil

    init(tier: PermissionTier, style: PermissionIconStyle? = nil, size: CGFloat = 15, color: Color? = nil) {
        self.tier = tier
        self.style = style
        self.size = size
        self.color = color
    }

    init(mode: String, style: PermissionIconStyle? = nil, size: CGFloat = 15, color: Color? = nil) {
        self.init(tier: .of(mode), style: style, size: size, color: color)
    }

    var body: some View {
        let resolvedStyle = style ?? DisplayPreferences.shared.permissionIconStyle
        let shape = PermissionIconGlyphs.shape(for: tier, style: resolvedStyle)
        let scaled = size * DisplayPreferences.shared.textScale
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 24
            let strokeWidth = 1.25 / scale
            context.transform = CGAffineTransform(scaleX: scale, y: scale)
            let shading: GraphicsContext.Shading = color.map { .color($0) } ?? .foreground
            context.stroke(shape.stroke, with: shading, style: StrokeStyle(lineWidth: strokeWidth, lineCap: .round, lineJoin: .round))
            if !shape.dashed.isEmpty {
                context.stroke(shape.dashed, with: shading, style: StrokeStyle(lineWidth: strokeWidth, lineCap: .round, lineJoin: .round, dash: [3.5, 2.5]))
            }
            for rect in shape.fills {
                context.fill(Path(ellipseIn: rect), with: shading)
            }
        }
        .frame(width: scaled, height: scaled)
        .accessibilityHidden(true)
    }
}

/// The approval mode as its semantic glyph on the composer toolbar; its choices live in the native menu.
struct OptionMenu: View, Equatable {
    let title: String
    let options: [NativeBackendOption]
    let selection: String
    let choose: (String) -> Void
    @Environment(\.palette) private var palette
    @State private var anchor = MenuAnchor()

    /// Compare the chip's data; each click builds a separate static AppKit menu so streaming
    /// updates cannot rebuild subtitle rows while AppKit is tracking the open menu.
    static func == (lhs: OptionMenu, rhs: OptionMenu) -> Bool {
        lhs.title == rhs.title && lhs.options == rhs.options && lhs.selection == rhs.selection
    }

    var body: some View {
        let current = options.first { $0.id == selection }
        let label = current?.label ?? String(localized: "默认")
        let risky = Self.risky(selection)
        Button { showMenu() } label: {
            PermissionIconView(mode: selection, color: risky ? palette.warning : palette.fg2)
        }
        .buttonStyle(ChipButtonStyle())
        .background(MenuAnchorView(anchor: anchor))
        .fixedSize()
        .help("\(title)：\(label)")
        .accessibilityLabel(title)
        .accessibilityValue(label)
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(.sectionHeader(title: title))
        let style = DisplayPreferences.shared.permissionIconStyle
        var selected: String?
        for option in options {
            let id = option.id
            let item = MenuAction.item(option.label) { selected = id }
            item.subtitle = option.description_
            item.state = id == selection ? .on : .off
            item.image = PermissionIconGlyphs.menuImage(
                for: id, style: style,
                color: Self.risky(id) ? palette.nsColor(\.warning) : nil
            )
            menu.addItem(item)
        }
        // Apply the choice only after AppKit has finished tracking and closed the menu.
        if anchor.popUp(menu), let selected, selected != selection { choose(selected) }
    }

    private static func risky(_ id: String) -> Bool {
        ["unrestricted", "bypassPermissions", "danger-full-access", "always-proceed", "never", "high"].contains(id)
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}

/// Touch ID (or the login password) before an approval, when the reader turned that on.
enum TouchID {
    static func confirm(_ reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return true }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

extension EnvironmentValues {
    /// What Escape does in a composer with no menu open, when its host has a use for it.
    @Entry var composerEscape: (() -> Void)?
}
