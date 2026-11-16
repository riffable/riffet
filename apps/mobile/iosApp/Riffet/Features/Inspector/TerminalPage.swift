import Observation
import os
import SwiftTerm
import SwiftUI
import RiffetKit
import UniformTypeIdentifiers

struct TerminalPage: View {
    let workbench: Workbench
    let projectID: String
    var terminalID: String? = nil
    @Environment(\.scenePhase) private var phase
    @Environment(\.palette) private var palette
    @State private var controller = IOSTerminalController()
    @State private var terminals: [TerminalInfo] = []
    @State private var selectedID: String?
    @State private var error: String?
    @State private var busy = false
    @State private var terminate = false

    private var selected: TerminalInfo? { terminals.first { $0.id == selectedID } }

    var body: some View {
        VStack(spacing: 0) {
            if selectedID != nil {
                statusNotice
                if controller.pasting || (controller.live && !controller.hasFailure) {
                    HStack {
                        if controller.pasting { ProgressView().controlSize(.small) }
                        Spacer()
                        if controller.live { Text(controller.hasControl ? "由此 iPhone 控制" : "输入会接管终端").riffetFont(.caption).foregroundStyle(palette.fg3) }
                    }.padding(.horizontal, RiffetMetrics.pageInset).padding(.vertical, 8)
                }
            } else if let error {
                RiffetNotice(kind: .error, message: error, boxed: true).padding(RiffetMetrics.pageInset)
            }
            if let id = selectedID {
                IOSTerminalSurface(controller: controller, terminalID: id).id(id)
            } else if busy { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                ContentUnavailableView {
                    Label("没有终端", systemImage: "terminal")
                } description: { Text("Shell 在 Mac 上运行。离开此页面后进程继续运行。") } actions: {
                    Button("新建 Shell") { Task { await create() } }.disabled(busy)
                }
            }
        }
        .navigationTitle(selected?.title.isEmpty == false ? selected!.title : String(localized: "终端", bundle: .riffet))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .bottomBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if selectedID != nil {
                    if controller.live {
                        Button(controller.hasControl ? "释放控制权" : "接管终端", systemImage: controller.hasControl ? "hand.raised.slash" : "hand.raised") { controller.control() }
                    }
                    Button("键盘", systemImage: "keyboard") { controller.toggleKeyboard() }.disabled(!controller.live)
                }
                Menu {
                    if !terminals.isEmpty {
                        Picker("终端", selection: $selectedID) {
                            ForEach(terminals, id: \.id) { terminal in Text(terminal.title.isEmpty ? (terminal.kind == .shell ? "Shell" : String(localized: "Agent 终端", bundle: .riffet)) : terminal.title).tag(Optional(terminal.id)) }
                        }
                    }
                    Button("新建 Shell", systemImage: "plus") { Task { await create() } }.disabled(busy)
                    Button("刷新终端列表", systemImage: "arrow.clockwise") { Task { await load() } }
                    if selectedID != nil {
                        Divider()
                        if !controller.live, !controller.exited {
                            Button("重新连接", systemImage: "arrow.triangle.2.circlepath") { reconnect() }
                        }
                        if controller.live { Button("中断当前命令 (Ctrl+C)", systemImage: "stop.circle") { Task { await sendInterrupt() } } }
                        if selected?.kind == .shell && selected?.state != .exited {
                            Button("结束这个 Shell", systemImage: "xmark.circle", role: .destructive) { terminate = true }
                        }
                    }
                } label: { Label("终端操作", systemImage: "ellipsis.circle") }
            }
        }
        .task(id: projectID) {
            selectedID = terminalID
            await load()
            if let selectedID, phase == .active { controller.start(workbench: workbench, terminalID: selectedID) }
        }
        .onChange(of: selectedID) { _, id in
            controller.stop()
            if let id, phase == .active { controller.start(workbench: workbench, terminalID: id) }
        }
        .onChange(of: phase) { _, phase in
            if phase == .active { reconnect() }
            else { controller.stop() }
        }
        .onDisappear { controller.stop() }
        .confirmationDialog("结束这个 Shell？", isPresented: $terminate, titleVisibility: .visible) {
            Button("结束 Shell", role: .destructive) { Task { await close() } }
        } message: { Text("Shell 及其中运行的进程会结束。") }
    }

    /// One notice for the bar: a failure outranks the connection's own status; a live terminal says nothing.
    @ViewBuilder private var statusNotice: some View {
        if let error {
            RiffetNotice(kind: .error, message: error, boxed: true).padding(RiffetMetrics.pageInset)
        } else if controller.hasFailure || controller.notice != nil {
            RiffetNotice(kind: .error, message: controller.notice ?? controller.status, boxed: true).padding(RiffetMetrics.pageInset)
        } else if !controller.live {
            let retry = !controller.exited && controller.reconnectable
            RiffetNotice(kind: .info, message: controller.status,
                         actionTitle: retry ? String(localized: "重试", bundle: .riffet) : nil,
                         action: retry ? { reconnect() } : nil, boxed: true)
                .padding(RiffetMetrics.pageInset)
        }
    }

    private func reconnect() {
        guard let selectedID, phase == .active else { return }
        controller.stop()
        controller.start(workbench: workbench, terminalID: selectedID)
    }
    private func load() async {
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            terminals = try await api.terminals().filter { $0.projectId == projectID && $0.state != .exited }
            if selectedID == nil { selectedID = terminals.first?.id }
            error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func create() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            let shell = try await api.createShellTerminal(projectId: projectID, title: nil)
            terminals.append(shell)
            selectedID = shell.id
            error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func close() async {
        guard let selectedID, selected?.kind == .shell, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            _ = try await api.closeTerminal(id: selectedID)
            controller.stop()
            terminals.removeAll { $0.id == selectedID }
            self.selectedID = terminals.first?.id
            error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func sendInterrupt() async {
        do {
            guard let selectedID, let api = workbench.api else { throw InspectorFailure.disconnected }
            _ = try await api.interruptTerminal(id: selectedID)
            error = nil
        } catch { self.error = error.riffetMessage }
    }
}

@MainActor @Observable
final class IOSTerminalController {
    private(set) var status = String(localized: "未连接", bundle: .riffet)
    private(set) var notice: String?
    var hasFailure: Bool {
        if notice != nil { return true }
        guard let link = connection?.link.value else { return false }
        if case .unauthenticated = onEnum(of: link) { return true }
        return false
    }
    private(set) var live = false
    private(set) var hasControl = false
    private(set) var exited = false
    /// No link is trying on its own: paused, or the service was unreachable.
    private(set) var reconnectable = false
    private(set) var pasting = false
    @ObservationIgnored var connection: TerminalConnection?
    @ObservationIgnored weak var view: RemoteTerminalView?
    @ObservationIgnored weak var container: RemoteTerminalContainer?
    @ObservationIgnored private var tint: TerminalRetint?
    @ObservationIgnored private var originalOutput: String? = ""
    @ObservationIgnored private var originalBytes = 0
    @ObservationIgnored private var appearanceKey = ""
    @ObservationIgnored private var appearanceConfiguration: (theme: ThemeEntry, dark: Bool)?
    @ObservationIgnored private var launchAppearance: TerminalAppearance?
    @ObservationIgnored private let subscriptions = FlowSubscriptions()
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var pending: [(String, Bool, Int, Int)] = []
    @ObservationIgnored private var terminalID: String?
    @ObservationIgnored private var attachedTerminalID: String?

    private static var clientID: String {
        let key = "riffet.iphone.terminal-client"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = "iphone-" + UUID().uuidString.lowercased()
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    func start(workbench: Workbench, terminalID: String) {
        guard connection == nil else { return }
        notice = nil
        reconnectable = false
        self.terminalID = terminalID
        generation += 1
        let token = generation
        let inbox = TerminalOutputInbox { [weak self] data, fresh, cols, rows in
            guard let self, self.generation == token else { return }
            self.output(data, fresh: fresh, cols: cols, rows: rows)
        }
        connection = workbench.host.openTerminalForStore(store: workbench.store, terminalId: terminalID, clientId: Self.clientID) { data, fresh, cols, rows in
            inbox.append(data, fresh: fresh.boolValue, cols: cols.intValue, rows: rows.intValue)
        }
        guard let connection else { status = String(localized: "服务器未连接", bundle: .riffet); reconnectable = true; return }
        subscriptions.observe(connection.link) { [weak self] link in
            guard let self else { return }
            switch onEnum(of: link) {
            case .connecting: status = String(localized: "正在连接…", bundle: .riffet); live = false; exited = false
            case .live: status = String(localized: "已连接", bundle: .riffet); live = true; exited = false
            case .reconnecting: status = String(localized: "正在重新连接", bundle: .riffet); live = false
            case let .exited(exit): status = exit.exitCode.map { String(localized: "进程已退出（\($0.int64Value)）", bundle: .riffet) } ?? String(localized: "进程已退出", bundle: .riffet); live = false; exited = true
            case .unauthenticated: status = String(localized: "授权已失效，请重新配对", bundle: .riffet); live = false
            }
            view?.inputAllowed = live
            if !live { _ = view?.resignFirstResponder() }
        }
        subscriptions.observe(connection.info) { [weak self] info in
            guard let self else { return }
            hasControl = connection.hasControl
            if launchAppearance?.foreground != info?.appearance?.foreground || launchAppearance?.background != info?.appearance?.background {
                launchAppearance = info?.appearance
                if let config = appearanceConfiguration { applyAppearance(theme: config.theme, dark: config.dark) }
            }
        }
        subscriptions.observe(connection.notice) { [weak self] notice in self?.notice = notice }
    }

    func attach(_ container: RemoteTerminalContainer, terminalID: String) {
        self.container = container
        appearanceKey = ""
        let view = container.terminal
        self.view = view
        container.onViewportSize = { [weak self] cols, rows in self?.connection?.requestSize(cols: Int32(cols), rows: Int32(rows)) }
        attachedTerminalID = terminalID
        view.inputAllowed = live && terminalID == self.terminalID
        view.onAttachmentPaste = { [weak self] in
            guard let self else { return false }
            let board = UIPasteboard.general
            let urls = board.urls?.filter(\.isFileURL) ?? []
            let image = urls.isEmpty ? board.image?.pngData() : nil
            guard !urls.isEmpty || image != nil else { return false }
            pasteAttachments(text: image == nil ? nil : board.string) {
                try await Task.detached(priority: .userInitiated) {
                    if !urls.isEmpty {
                        var files: [ImportedAttachment] = []
                        do {
                            for url in urls { files.append(try AttachmentImporter.importFile(url)) }
                            return files
                        } catch { files.forEach { $0.removeLocalCopy() }; throw error }
                    }
                    return try image.map { [try AttachmentImporter.importImage($0)] } ?? []
                }.value
            }
            return true
        }
        view.onDrop = { [weak self] providers in
            self?.pasteAttachments {
                var files: [ImportedAttachment] = []
                do {
                    for provider in providers {
                        guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) else { continue }
                        let file: ImportedAttachment = try await withCheckedThrowingContinuation { continuation in
                            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                                if let error { continuation.resume(throwing: error); return }
                                guard let url else { continuation.resume(throwing: AttachmentImportError.unavailable); return }
                                do { continuation.resume(returning: try AttachmentImporter.importFile(url, preferredName: provider.suggestedName)) }
                                catch { continuation.resume(throwing: error) }
                            }
                        }
                        files.append(file)
                    }
                    return files
                } catch { files.forEach { $0.removeLocalCopy() }; throw error }
            }
        }
        view.onReply = { [weak self] in self?.connection?.sendReply(data: $0) }
        view.onTextPaste = { [weak self] text in
            guard let self, live else { return }
            connection?.paste(text: text)
        }
        if terminalID == self.terminalID {
            for (data, fresh, cols, rows) in pending { output(data, fresh: fresh, cols: cols, rows: rows) }
            pending = []

        }
    }

    private func pasteAttachments(text: String? = nil, prepare: @escaping () async throws -> [ImportedAttachment]) {
        guard live, !pasting, let connection else { return }
        pasting = true
        notice = nil
        let token = generation
        Task { [weak self] in
            guard let self else { return }
            defer { if token == generation { pasting = false } }
            do {
                let epoch = try await connection.acquirePasteLease()
                let files = try await prepare()
                defer { files.forEach { $0.removeLocalCopy() } }
                guard token == generation, self.connection === connection else { return }
                let uploads = try files.map(NativeUpload.init)
                let result = try await connection.pasteAttachments(files: uploads, requestId: UUID().uuidString.lowercased(), expectedLease: epoch, text: text)
                guard token == generation else { return }
                if result.status != "completed" { notice = String(localized: "粘贴结果未知，请检查终端后再操作", bundle: .riffet) }
            } catch {
                guard token == generation else { return }
                notice = error.riffetMessage
            }
        }
    }

    func stop() {
        generation += 1
        subscriptions.cancelAll()
        connection?.close()
        connection = nil
        live = false
        hasControl = false
        notice = nil
        reconnectable = true
        status = String(localized: "连接已暂停", bundle: .riffet)
        _ = view?.resignFirstResponder()
        view?.inputAllowed = false
        pending = []
        pasting = false
        originalOutput = ""
        originalBytes = 0
    }

    func output(_ data: String, fresh: Bool, cols: Int, rows: Int) {
        guard let view, attachedTerminalID == terminalID else {
            if fresh { pending = [] }
            pending.append((data, fresh, cols, rows))
            return
        }
        if fresh {
            container?.setGrid(cols: cols, rows: rows)
            originalOutput = ""
            originalBytes = 0
            view.resetToInitialState()
            tint?.reset()
        }
        if originalOutput != nil {
            originalBytes += data.utf8.count
            if originalBytes <= 2 * 1024 * 1024 { originalOutput?.append(data) }
            else { originalOutput = nil }
        }
        view.feed(text: tint?.transform(data: data) ?? data)
    }

    func applyAppearance(theme: ThemeEntry, dark appDark: Bool) {
        appearanceConfiguration = (theme, appDark)
        guard let view else { return }
        // Without a recorded appearance the pane keeps tmux's default colours, painted with this theme.
        let page = appDark ? theme.values.dark : theme.values.light
        let appearance = launchAppearance ?? TerminalAppearance(foreground: String(page.fg.hex.prefix(7)), background: String(page.bg.hex.prefix(7)))
        let key = "\(theme.id)|\(appearance.foreground)|\(appearance.background)"
        guard key != appearanceKey else { return }
        appearanceKey = key
        tint = IOSTerminalColors.apply(view, theme: theme, appearance: appearance)
        if let originalOutput {
            view.replay(tint?.transform(data: originalOutput) ?? originalOutput)
        } else {
            // A bounded replay cannot represent an arbitrarily old screen; reconnect for a snapshot.
            connection?.close()
            connection?.start()
        }
        if hasControl { view.notifyColorScheme() }
    }

    func control() {
        guard let connection else { return }
        if hasControl { connection.release(); _ = view?.resignFirstResponder() }
        else { connection.takeOver(); _ = view?.becomeFirstResponder() }
    }
    func toggleKeyboard() {
        guard let view else { return }
        if view.isFirstResponder { _ = view.resignFirstResponder() } else { _ = view.becomeFirstResponder() }
    }
}

/// Parser replies bypass the user's delegate, so a DSR/DA response never takes the input lease.
final class RemoteTerminalView: SwiftTerm.TerminalView, UIDropInteractionDelegate {
    private nonisolated let suppressReplies = OSAllocatedUnfairLock(initialState: false)
    var onAttachmentPaste: (() -> Bool)?
    /// Pasted text goes to the server, which applies bracketed paste; it never passes through `send`.
    var onTextPaste: ((String) -> Void)?
    var onDrop: (([NSItemProvider]) -> Void)?
    override init(frame: CGRect) {
        super.init(frame: frame)
        addInteraction(UIDropInteraction(delegate: self))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func paste(_ sender: Any?) {
        guard inputAllowed else { return }
        if onAttachmentPaste?() == true { return }
        if let text = UIPasteboard.general.string, !text.isEmpty { onTextPaste?(text) }
    }
    func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
        inputAllowed && session.items.contains { $0.itemProvider.hasItemConformingToTypeIdentifier(UTType.data.identifier) }
    }
    func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal { UIDropProposal(operation: inputAllowed ? .copy : .cancel) }
    func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
        guard inputAllowed else { return }
        onDrop?(session.items.map(\.itemProvider))
    }
    var onReply: ((String) -> Void)?
    var inputAllowed = false
    override var canBecomeFirstResponder: Bool { inputAllowed }
    func replay(_ text: String) {
        suppressReplies.withLock { $0 = true }
        defer { suppressReplies.withLock { $0 = false } }
        resetToInitialState()
        feed(text: text)
    }
    nonisolated override func send(source: SwiftTerm.Terminal, data: ArraySlice<UInt8>) {
        guard !suppressReplies.withLock({ $0 }) else { return }
        let text = String(decoding: data, as: UTF8.self)
        DispatchQueue.main.async { [weak self] in self?.onReply?(text) }
    }
}

@MainActor
final class RemoteTerminalContainer: UIScrollView {
    let terminal = RemoteTerminalView(frame: .zero)
    var onViewportSize: ((Int, Int) -> Void)?
    private var grid: (cols: Int, rows: Int)?
    private var proposed: CGSize = .zero
    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(terminal)
        alwaysBounceVertical = false
        alwaysBounceHorizontal = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func setGrid(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        grid = (cols, rows)
        if terminal.terminalDimensions.cols != cols || terminal.terminalDimensions.rows != rows { terminal.resize(cols: cols, rows: rows) }
        terminal.frame = terminal.getOptimalFrameSize()
        contentSize = terminal.frame.size
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        let dimensions = terminal.terminalDimensions
        let optimal = terminal.getOptimalFrameSize().size
        let width = optimal.width / CGFloat(max(1, dimensions.cols))
        let height = optimal.height / CGFloat(max(1, dimensions.rows))
        if bounds.size != proposed, bounds.width > 0, bounds.height > 0 {
            proposed = bounds.size
            onViewportSize?(max(20, Int(bounds.width / max(1, width))), max(5, Int(bounds.height / max(1, height))))
        }
        if let grid {
            terminal.frame = CGRect(origin: .zero, size: CGSize(width: CGFloat(grid.cols) * width, height: CGFloat(grid.rows) * height))
            contentSize = terminal.frame.size
        }
    }
}

private struct IOSTerminalSurface: UIViewRepresentable {
    let controller: IOSTerminalController
    let terminalID: String
    @Environment(\.colorScheme) private var colorScheme
    @Environment(ThemeStore.self) private var themeStore
    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }
    func makeUIView(context: Context) -> RemoteTerminalContainer {
        let container = RemoteTerminalContainer(frame: .zero)
        let view = container.terminal
        view.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        view.changeScrollback(Int(BudgetsKt.TERMINAL_KEPT_ROWS_PHONE))
        view.terminalDelegate = context.coordinator
        view.accessibilityLabel = String(localized: "远程终端", bundle: .riffet)
        controller.attach(container, terminalID: terminalID)
        controller.applyAppearance(theme: themeStore.entry, dark: colorScheme == .dark)
        return container
    }
    func updateUIView(_ view: RemoteTerminalContainer, context: Context) { controller.applyAppearance(theme: themeStore.entry, dark: colorScheme == .dark) }
    @MainActor final class Coordinator: NSObject, TerminalViewDelegate {
        let controller: IOSTerminalController
        init(controller: IOSTerminalController) { self.controller = controller }
        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {}
        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            guard controller.live else { return }
            controller.connection?.sendInput(data: String(decoding: data, as: UTF8.self))
        }
        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
            UIApplication.shared.open(url)
        }
        func bell(source: SwiftTerm.TerminalView) { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            // A remote process cannot silently replace the phone's clipboard.
        }
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
    }
}

/// The terminal uses the app theme and the configured foreground-only correction.
@MainActor
private enum IOSTerminalColors {
    static func apply(_ view: SwiftTerm.TerminalView, theme: ThemeEntry, appearance: TerminalAppearance) -> TerminalRetint {
        let dark = appearance.dark
        let foreground = RiffetRGBA(hex: appearance.foreground) ?? theme.values.dark.fg
        let background = RiffetRGBA(hex: appearance.background) ?? theme.values.dark.bg
        let palette = dark ? theme.values.dark : theme.values.light
        let ansi = dark ? theme.values.ansi.dark : theme.values.ansi.light
        func native(_ color: RiffetRGBA) -> UIColor { UIColor(red: color.red, green: color.green, blue: color.blue, alpha: color.alpha) }
        func argb(_ color: RiffetRGBA) -> Int32 {
            Int32(bitPattern: 0xFF000000 | UInt32((color.red * 255).rounded()) << 16 | UInt32((color.green * 255).rounded()) << 8 | UInt32((color.blue * 255).rounded()))
        }
        let colors = KotlinIntArray(size: 16)
        for (index, color) in ansi.enumerated() { colors.set(index: Int32(index), value: argb(color)) }
        view.superview?.backgroundColor = native(background)
        view.nativeBackgroundColor = native(background)
        view.nativeForegroundColor = native(foreground)
        view.caretColor = native(foreground)
        view.caretTextColor = native(background)
        view.selectedTextBackgroundColor = native(palette.accent).withAlphaComponent(dark ? 0.3 : 0.18)
        view.ansi256PaletteStrategy = .xterm
        view.installColors(ansi.map { color in
            SwiftTerm.Color(red: UInt16((color.red * 255).rounded()) * 257, green: UInt16((color.green * 255).rounded()) * 257, blue: UInt16((color.blue * 255).rounded()) * 257)
        })
        view.updateColorScheme(dark ? .dark : .light, notify: false)
        let tint = TerminalRetint { KotlinDouble(value: 0) }
        tint.configure(foreground: argb(foreground), background: argb(background), ansi: colors)
        return tint
    }
}
