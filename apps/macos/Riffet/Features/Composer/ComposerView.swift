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
        // One line is the line composer's whole shape, wherever it sits.
        let minimum = lineHeight * (line ? 1 : minLines) + 4
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

    /// The Claude-style recipe: a flat box with the attach and send buttons on its row, the controls under it.
    private var line: Bool { DisplayPreferences.shared.style.composer == .line }

    private var rowInset: CGFloat { line ? 7 : 0 }

    var body: some View {
        let line = line
        return VStack(alignment: .leading, spacing: 0) {
            box(line: line)
            if line {
                envRow
            }
        }
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

    /// The input surface. Both recipes share this one tree (attachments, the row holding the single text
    /// view, the status line): the recipe changes parameters and which neighbours sit on the row, so the
    /// text view is never rebuilt by a switch.
    private func box(line: Bool) -> some View {
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
            HStack(alignment: .bottom, spacing: line ? 4 : 0) {
                if line {
                    attachButton(line: true).padding(.bottom, rowInset)
                    sendLaterButton(line: true).padding(.bottom, rowInset)
                }
                ZStack(alignment: .topLeading) {
                    if model.text.isEmpty && !composing {
                        Text(placeholder)
                            .font(.riffet(size: S(line ? 15 : 14)))
                            .foregroundStyle(line ? palette.fg3 : palette.fg4)
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
                        fontSize: S(line ? 15 : 14),
                        resize: motion,
                        onSubmit: { interrupt in if sendEnabled && !model.schedulingLater { onSend(interrupt) } },
                        onPasteFiles: { _ in model.paste(upload: upload) },
                        onKey: handle,
                        onComposing: { composing = $0 }
                    )
                    .frame(height: isFullscreen ? nil : editorHeight)
                    .frame(maxHeight: isFullscreen ? .infinity : nil)
                }
                .padding(.horizontal, line ? 4 : Space.lg)
                .padding(.top, line ? 10 : Space.md + 2)
                .padding(.bottom, line ? 10 : 0)
                .contentShape(Rectangle())
                .onTapGesture { model.focus() }
                if line {
                    if showsFullscreenControl, let fullscreen {
                        fullscreenButton(fullscreen).padding(.bottom, 10).transition(.opacity)
                    }
                    actionButton.padding(.bottom, rowInset)
                }
            }
            .frame(minHeight: line ? 46 : 0)
            .padding(.leading, line ? 6 : 0)
            .padding(.trailing, line ? 8 : 0)
            .animation(motion, value: line && showsFullscreenControl)

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
                .padding(.bottom, line ? Space.sm : 0)
                .transition(.opacity)
            }
            .id(ObjectIdentifier(model))
            if !line {
                HStack(spacing: Space.xxs) {
                    attachButton(line: false)
                    sendLaterButton(line: false)
                    barView(line: false)
                    actionButton.padding(.leading, Space.xs)
                }
                .padding(.horizontal, Space.sm)
                .padding(.top, Space.xs)
                .padding(.bottom, Space.sm)
            }
        }
        .frame(maxHeight: isFullscreen ? .infinity : nil)
        // The user bubble's radius: what is typed and what was sent share one shape. Same modifier chain
        // in both recipes (`View.card` for the card); only the colours and the shadow differ.
        .background(
            RoundedRectangle(cornerRadius: Radius.floating, style: .continuous)
                .fill(line ? palette.page : palette.bgElevated)
                .shadow(color: .black.opacity(DisplayPreferences.shared.style.surface == .outlined ? 0 : 0.04), radius: 6, y: 2)
        )
        .overlay(RoundedRectangle(cornerRadius: Radius.floating, style: .continuous).strokeBorder(line ? palette.lineStrong : palette.line, lineWidth: 1))
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
        .animation(.easeOut(duration: 0.12), value: menuOpen)
    }

    /// The controls that sit in the card's toolbar, under the box: right-aligned, outside it.
    private var envRow: some View {
        barView(line: true)
            .environment(\.chipMetrics, .row)
            .padding(.horizontal, 4)
            .frame(height: 40)
    }

    /// The clock beside the attach button: the draft, with its attachments and references, goes to this conversation at a later time.
    @ViewBuilder
    private func sendLaterButton(line: Bool) -> some View {
        if let sendLater = features.sendLater {
            NativeMenuButton(entries: {
                var entries: [NativeMenuEntry] = TimePreset.moments.compactMap { preset in
                    preset.date().map { date in .item(preset.label) { sendLater(date) } }
                }
                entries.append(.separator)
                entries.append(.item(String(localized: "自定义时间…")) { laterDate = Date.now.addingTimeInterval(3600); pickingLater = true })
                return entries
            }) {
                if line {
                    Image(icon: "clock").font(.riffet(size: S(16))).foregroundStyle(palette.fg2)
                } else {
                    Image(icon: "clock")
                }
            }
            .buttonStyle(IconButtonStyle(size: line ? 32 : 26))
            .disabled(!sendEnabled || !model.canSend || model.schedulingLater)
            .help("稍后发送")
            .accessibilityLabel("稍后发送")
            .popover(isPresented: $pickingLater, arrowEdge: .top) {
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

    private func attachButton(line: Bool) -> some View {
        Button {
            guard let tools = toolsSlot.entries else { model.pickFiles(upload: upload); return }
            toolsSlot.refresh?()
            attachAnchor.popUp(entries: [
                .item(String(localized: "添加图片或文件"), symbol: "paperclip") { model.pickFiles(upload: upload) },
                .separator,
                .submenu(String(localized: "技能与工具"), symbol: "puzzlepiece.extension", entries: tools()),
            ])
        } label: {
            if line {
                Image(icon: "plus").font(.riffet(size: S(16))).foregroundStyle(palette.fg2)
            } else {
                Image(icon: "paperclip")
            }
        }
        .buttonStyle(IconButtonStyle(size: line ? 32 : 26))
        .background(MenuAnchorView(anchor: attachAnchor))
        .help("添加附件（也可以拖入或粘贴）")
    }

    private func fullscreenButton(_ fullscreen: Binding<Bool>) -> some View {
        Button { withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) { fullscreen.wrappedValue.toggle() }; model.focus() } label: {
            Image(icon: isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                .font(.riffet(size: S(11)))
        }
        .buttonStyle(IconButtonStyle(size: fullscreenButtonSize))
        .help(isFullscreen ? "退出全屏编辑 (esc)" : "全屏编辑")
        .accessibilityLabel(isFullscreen ? "退出全屏编辑 (esc)" : "全屏编辑")
    }

    private func barView(line: Bool) -> some View {
        bar(line: line)
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
        let fullscreenWidth = showsFullscreenControl && !line ? fullscreenButtonSize + Space.xxs : 0
        return controls + trailing + fullscreenWidth + Space.sm + Space.xxs * 2 > space
    }

    /// One entry per composer surface: each passes its own kinds of controls.
    /// The card's toolbar and the line recipe's row are different widths, so they keep separate figures.
    private var barKind: ComposerBarWidths.Kind { .init(composer: ObjectIdentifier(Self.self), line: line) }

    private func bar(line: Bool) -> some View {
        let compact = compactBar
        // Each group in its own row: a modifier on a bare list of views would stack them vertically.
        return HStack(spacing: Space.xxs) {
            HStack(spacing: Space.xxs) { controls }
                .fixedSize(horizontal: !compact, vertical: false)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    guard !compactBar else { return }
                    controlsWidth = width
                }
            if !line {
                Spacer(minLength: Space.sm)
                if showsFullscreenControl, let fullscreen {
                    fullscreenButton(fullscreen).transition(.opacity)
                }
            }
            // A line composer's row: the mode on its own at the leading edge, the model and its context at the trailing one.
            if line { Spacer(minLength: Space.sm) }
            HStack(spacing: Space.xxs) { trailing }
                .fixedSize(horizontal: !compact, vertical: false)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    guard !compactBar else { return }
                    trailingWidth = width
                }
        }
        .environment(\.compactControls, compact)
        .environment(\.composerEnvRow, line)
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
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) { fullscreen.wrappedValue = false }
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
            .animation(reduceMotion ? nil : .snappy(duration: 0.12), value: stopping)
        }
        .buttonStyle(ComposerActionButtonStyle(line: line))
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

/// The send / stop button: the card's solid circle, or the line recipe's rounded square in the text colour.
private struct ComposerActionButtonStyle: ButtonStyle {
    let line: Bool
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.riffet(size: S(13), weight: .bold))
            .foregroundStyle(line ? (enabled ? palette.page : palette.fg4) : (enabled ? palette.primaryFg : palette.fg4))
            .frame(width: line ? 32 : 30, height: line ? 32 : 30)
            .background {
                if line {
                    RoundedRectangle(cornerRadius: Radius.container, style: .continuous).fill(enabled ? palette.fg : palette.bgActive)
                } else {
                    Circle().fill(enabled ? palette.primary : palette.bgMuted)
                }
            }
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
            .contentShape(RoundedRectangle(cornerRadius: line ? Radius.container : 15))
    }
}

/// The one motion for what changes size around the input: cards and docks arriving above it, rows
/// inside it, its height after a send. Short and the same everywhere; callers drop it under Reduce Motion.
enum ComposerMotion {
    static let resize = Animation.snappy(duration: 0.18)
    /// Fades in rising a little, and leaves the same way, as the share sheet's toast does.
    static let insert = AnyTransition.opacity.combined(with: .offset(y: 8))
}

/// The composer bar's last measured space, per kind of composer (`ComposerView.barKind`).
private enum ComposerBarWidths {
    struct Kind: Hashable {
        let composer: ObjectIdentifier
        let line: Bool
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
                    OptionMenu(title: String(localized: "审批"), options: catalog.capabilities.permissions, selection: workbench.status?.approval ?? session.approval ?? "") { value in
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
    @Environment(\.composerEnvRow) private var envRow

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
            // The card's toolbar puts the meter before the model; a line composer's row after it.
            if showsMeter, !envRow, let context = workbench.context {
                ContextMeter(context: context).transition(.opacity)
            }
            if let catalog, catalog.capabilities.supportsModelSelection {
                ModelControls(catalog: catalog.models, selection: session.model, usage: quickChat ? nil : {
                    try? await workbench.host.api?.agentUsage(agentId: session.agentID, projectId: nil, profileId: nil, sessionId: session.id, global: false)
                }, showsAccountUsage: !quickChat && session.agentID == "codex", loading: loading, providers: providers, activeProviderId: session.backendProfileId, chooseInProvider: { provider, value in
                    Task { await workbench.switchProfile(provider, model: value, for: session.id) }
                }, scope: "\(session.id)|\(session.agentID)|\(session.backendProfileId ?? "")", refresh: refresh) { value in
                    Task { await workbench.setModel(value, for: session.id) }
                }
                .id("\(session.id)|\(session.agentID)|\(session.backendProfileId ?? "")")
                .transition(.opacity)
            } else if loading, catalog == nil {
                ModelControls(catalog: [], selection: session.model, loading: true) { _ in }
                    .transition(.opacity)
            }
            if showsMeter, envRow, let context = workbench.context {
                ContextMeter(context: context).transition(.opacity)
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
    ]

    private var ratio: Double { min(1, max(0, Double(context.used) / Double(context.size))) }
    private var title: String { String(localized: "上下文用量") }
    private var breakdownTotal: Int64 { parts.reduce(0) { $0 + $1.tokens } }
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
                                Text(Self.labels[part.id] ?? part.label).font(.riffet(size: S(12))).foregroundStyle(palette.fg2).lineLimit(1)
                                Spacer(minLength: Space.sm)
                                Text("\(context.breakdownEstimated ? "~" : "")\(Self.compactTokens(part.tokens))").font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3)
                                Text("\(Int((Double(part.tokens) / Double(max(breakdownTotal, 1)) * 100).rounded()))%")
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
        if value >= 1_000 { return String(format: "%.1fk", Double(value / 100) / 10) }
        return "\(value)"
    }
}

/// The approval mode by its short name, as the model chip beside it says the model; its choices
/// live in the native menu. Words rather than a glyph apiece, as the agents' own CLIs say them:
/// only running everything is marked, by colour.
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
        Button { showMenu() } label: {
            Text(current?.shortLabel ?? label)
                .lineLimit(1)
                .foregroundStyle(Self.risky(selection) ? palette.warning : palette.fg2)
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
        var selected: String?
        for option in options {
            let id = option.id
            let item = MenuAction.item(option.label) { selected = id }
            item.subtitle = option.description_
            item.state = id == selection ? .on : .off
            menu.addItem(item)
        }
        // Apply the choice only after AppKit has finished tracking and closed the menu.
        if anchor.popUp(menu), let selected, selected != selection { choose(selected) }
    }

    private static func risky(_ id: String) -> Bool {
        ["unrestricted", "bypassPermissions", "danger-full-access", "never", "high"].contains(id)
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
    /// The controls sit in a line composer's environment row rather than in the card's toolbar.
    @Entry var composerEnvRow = false
    /// What Escape does in a composer with no menu open, when its host has a use for it.
    @Entry var composerEscape: (() -> Void)?
}
