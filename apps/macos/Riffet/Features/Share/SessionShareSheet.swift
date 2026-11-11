import SwiftUI
import RiffetKit

struct SessionShareSheet: View {
    let workbench: Workbench
    let session: Session
    var purpose: SessionSharePurpose = .link
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @State private var model = SessionShareModel()
    @State private var selectionMode = "all"
    @State private var recentCount = 20
    @State private var selected = Set<String>()
    @State private var themeId = ThemeStore.shared.entry.id
    @State private var mode = "system"
    @State private var showAuthor = false
    @State private var expiryDays = 30
    @State private var removeConfirmation = false
    @State private var appearanceInitialized = false
    @State private var refreshing = false
    @State private var printer = SessionSharePrinter()

    private var isPDF: Bool { purpose == .pdf }
    private var connection: ObjectIdentifier? { workbench.host.api.map(ObjectIdentifier.init) }
    private var selection: ShareSelection {
        ShareSelection(mode: selectionMode, count: selectionMode == "recent" ? KotlinInt(int: Int32(recentCount)) : nil,
                       turnIds: selectionMode == "selected" ? model.turns?.turns.filter { selected.contains($0.id) }.map(\.id) : nil,
                       nativeChatId: selectionMode == "selected" ? model.turns?.nativeChatId : nil)
    }
    private var appearance: ShareAppearanceRequest {
        ShareAppearanceRequest(themeId: themeId, mode: mode, themeRevision: themeId.hasPrefix("custom-") ? ThemeStore.shared.libraryRevision : nil, uiFont: nil, monoFont: nil, background: nil)
    }
    private var hasOwner: Bool { workbench.owner.map { ($0.name?.isEmpty == false) || $0.avatar != nil } ?? false }
    private var validSelection: Bool { selectionMode != "selected" || !selected.isEmpty && model.turns != nil && !model.loadingTurns }
    private var formKey: String { "\(selectionMode)|\(recentCount)|\(selected.sorted().joined(separator: ","))|\(themeId)|\(mode)|\(showAuthor)" }
    private var controlsDisabled: Bool { model.busy || model.checking || refreshing || printer.printing }
    private var notice: String? {
        if !model.error.isEmpty { return model.error }
        if isPDF { return nil }
        if let blocker = model.status?.blocker, blocker.code != "SHARE_UNCONFIRMED" { return blocker.localizedMessage() }
        if let message = model.status?.share?.localizedError() { return message }
        if let blocker = model.status?.blocker { return blocker.localizedMessage() }
        if model.status?.capability.available == false { return model.status?.capability.message }
        return nil
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(isPDF ? String(localized: "导出为 PDF") : String(localized: "分享会话")).font(RiffetFont.body.weight(.semibold))
                Spacer()
                Button { dismiss() } label: { Image(icon: "xmark") }
                    .buttonStyle(IconButtonStyle())
                    .disabled(printer.printing)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("关闭")
                    .help("关闭")
            }
            .padding(Space.lg)
            Divider()
            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.lg) {
                        statusRow
                        rangeControls
                        Divider()
                        themeControls
                        if isPDF {
                            Text("在系统打印窗口中选择“存储为 PDF”。")
                                .font(RiffetFont.caption).foregroundStyle(palette.fg3)
                                .fixedSize(horizontal: false, vertical: true)
                            if let draft = model.draft {
                                ForEach(Array(draft.localizedWarnings().enumerated()), id: \.offset) { _, warning in
                                    Text(warning).font(RiffetFont.caption).foregroundStyle(palette.fg3)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                        if !isPDF {
                            Divider()
                            field("有效期") {
                                choice("有效期", selection: $expiryDays,
                                       options: [7, 30, 90, 365].map { ($0, String(localized: "\($0) 天")) })
                            }
                        }
                        if model.status?.share == nil, let publishers = model.status?.capability.publishers, publishers.count > 1 {
                            field("发布到") {
                                choice("发布到", selection: Binding(
                                    get: { model.status?.capability.publisher?.id ?? "" },
                                    set: { model.setDefaultPublisher($0) }
                                ), options: publishers.map { ($0.id, $0.label) })
                            }
                        }
                        if let publisher = model.status?.capability.publisher {
                            Text(publisher.audience).font(RiffetFont.caption).foregroundStyle(palette.fg3)
                        }
                        if let notice {
                            Text(notice).font(RiffetFont.caption)
                                .foregroundStyle(model.error.isEmpty ? palette.fg3 : palette.danger)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let share = model.status?.share {
                            shareDetails(share)
                        }
                    }
                    .padding(Space.lg)
                }
                .frame(width: 280)
                Divider()
                preview
            }
            Divider()
            HStack {
                if !isPDF, model.status?.share != nil, model.status?.actions.remove == true {
                    Button("取消分享", role: .destructive) { removeConfirmation = true }
                        .buttonStyle(ChipButtonStyle())
                        .disabled(controlsDisabled)
                }
                Spacer()
                Button(model.draft == nil ? String(localized: "生成预览") : String(localized: "重新生成")) {
                    model.generate(selection: selection, appearance: appearance, author: hasOwner && showAuthor)
                }
                    .buttonStyle(SolidButtonStyle())
                    .disabled(controlsDisabled || !validSelection || !model.canPreview)
                if isPDF {
                    Button("打印 / 保存为 PDF…") {
                        printer.printDocument(title: session.title) {
                            model.previewReady = false
                            model.previewFailed = true
                        }
                    }
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .disabled(controlsDisabled || !model.previewReady)
                } else {
                    Button(model.status?.share?.state == "published" ? String(localized: "更新分享") : String(localized: "创建链接")) {
                        model.publish(days: expiryDays)
                    }
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .disabled(controlsDisabled || !model.previewReady || model.status?.actions.publish != true)
                }
            }
            .padding(Space.lg)
        }
        .frame(minWidth: 920, idealWidth: 1060, minHeight: 640, idealHeight: 760)
        .background(palette.bg)
        .interactiveDismissDisabled(printer.printing)
        .task(id: [connection.map { String(describing: $0) } ?? "", session.id]) {
            appearanceInitialized = false
            selectionMode = "all"
            recentCount = 20
            selected = []
            themeId = ThemeStore.shared.entry.id
            mode = !isPDF && colorScheme == .dark ? "dark" : "light"
            showAuthor = false
            await model.connect(api: workbench.host.api, sessionId: session.id, purpose: purpose)
            guard !Task.isCancelled else { return }
            if let saved = model.status?.share?.appearance {
                themeId = saved.themeId
                if ["system", "light", "dark"].contains(saved.mode) { mode = saved.mode }
            }
            showAuthor = model.status?.share?.author?.boolValue ?? false
            appearanceInitialized = true
        }
        .onDisappear { model.disconnect() }
        .onChange(of: formKey) { _, _ in if appearanceInitialized { model.clearDraft() } }
        .onChange(of: selectionMode) { _, next in
            if next == "selected", model.turns == nil { model.loadTurns() }
        }
        .onChange(of: model.turns?.turns.map(\.id)) { _, _ in
            selected.formIntersection(Set(model.turns?.turns.map(\.id) ?? []))
        }
        .confirmationDialog("取消分享？", isPresented: $removeConfirmation, titleVisibility: .visible) {
            Button("取消分享", role: .destructive) { model.remove() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("链接将失效。")
        }
    }

    private var rangeControls: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            field("范围") {
                choice("范围", selection: $selectionMode, options: [
                    ("recent", String(localized: "最近几轮")),
                    ("selected", String(localized: "手动选择")),
                    ("all", String(localized: "全部")),
                ])
            }
            if selectionMode == "recent" {
                Stepper(value: $recentCount, in: 1...1000) { Text("\(recentCount)").monospacedDigit() }
            }
            if selectionMode == "selected" {
                if model.loadingTurns { Spinner() }
                if !model.turnsError.isEmpty {
                    Text(model.turnsError).font(RiffetFont.caption).foregroundStyle(palette.danger)
                    Button("重试") { model.loadTurns() }
                }
                if let turns = model.turns?.turns {
                    if turns.isEmpty { Text("暂无内容").font(RiffetFont.caption).foregroundStyle(palette.fg3) }
                    ForEach(turns, id: \.id) { turn in
                        Toggle(isOn: Binding(get: { selected.contains(turn.id) }, set: { value in
                            if value { selected.insert(turn.id) } else { selected.remove(turn.id) }
                        })) {
                            Text(turn.text).font(RiffetFont.caption).lineLimit(3)
                        }
                        .toggleStyle(.checkbox)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .disabled(controlsDisabled)
    }

    private var themeControls: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            field("主题") {
                choice("主题", selection: $themeId, options: ThemeStore.shared.choices.map { ($0.id, $0.name) })
            }
            field("明暗") {
                SegmentedTrack(selection: $mode, fontSize: 12) {
                    Text("跟随系统").tag("system")
                    Text("浅色").tag("light")
                    Text("深色").tag("dark")
                }
            }
            if hasOwner {
                Toggle("显示分享者", isOn: $showAuthor)
                    .toggleStyle(.switch)
                    .controlSize(.small)
            }
        }
        .disabled(controlsDisabled)
    }

    private func field<Content: View>(_ title: LocalizedStringResource, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(String(localized: title)).font(RiffetFont.caption).foregroundStyle(palette.fg3)
            content().labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func choice<Value: Equatable>(_ title: LocalizedStringResource, selection: Binding<Value>, options: [(Value, String)]) -> some View {
        let current = options.first { $0.0 == selection.wrappedValue }?.1 ?? String(describing: selection.wrappedValue)
        return ChoiceMenu(options: options.map { value, name in
            ChoiceOption(title: name, selected: value == selection.wrappedValue) { selection.wrappedValue = value }
        }) {
            HStack(spacing: Space.sm) {
                Text(current).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                Image(icon: "chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
            }
            .font(RiffetFont.label).foregroundStyle(palette.fg)
            .padding(.horizontal, Space.sm)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineStrong, lineWidth: 0.5))
            .opacity(controlsDisabled ? 0.45 : 1)
        }
        .disabled(controlsDisabled)
        .accessibilityLabel(Text(String(localized: title)))
        .accessibilityValue(current)
    }

    private var statusRow: some View {
        HStack(spacing: Space.sm) {
            if printer.printing {
                Spinner()
                Text("正在准备打印…")
            } else if !isPDF && (model.checking || refreshing) {
                Spinner()
                Text("正在检查登录…")
            } else if model.busy || model.status?.blocker?.code == "SHARE_BUSY" {
                Spinner()
                Text(model.progress)
            } else if let username = model.status?.capability.username {
                Text(username).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
            if model.generating {
                Button("取消") { model.cancelGeneration() }.buttonStyle(ChipButtonStyle())
            } else if notice != nil, !isPDF {
                Button {
                    refreshing = true
                    Task {
                        await model.refresh(fresh: true)
                        await ThemeStore.shared.reload()
                        refreshing = false
                    }
                } label: { Image(icon: "arrow.clockwise") }
                .buttonStyle(IconButtonStyle())
                .accessibilityLabel("刷新状态")
                .help("刷新状态")
                .disabled(controlsDisabled)
            }
        }
        .font(RiffetFont.caption).foregroundStyle(palette.fg3)
        .frame(height: 28)
    }

    @ViewBuilder
    private func shareDetails(_ share: SessionShare) -> some View {
        if share.state == "published", let link = share.url, let url = URL(string: link) {
            HStack {
                Link(destination: url) { Image(icon: "arrow.up.right.square") }
                Text(link).font(RiffetFont.caption).lineLimit(1).truncationMode(.middle)
                Button { copyToPasteboard(link) } label: { Image(icon: "doc.on.doc") }
                    .buttonStyle(IconButtonStyle()).accessibilityLabel("复制链接").help("复制链接")
            }
            if let expiry = ServerTime.date(share.expiresAt) {
                Text("到期时间：\(expiry.formatted(date: .abbreviated, time: .shortened))")
                    .font(RiffetFont.caption).foregroundStyle(palette.fg3)
            }
        }
        if share.operation == "uncertain" {
            HStack {
                Button("核对状态") { model.reconcile() }.disabled(controlsDisabled || model.status?.actions.reconcile != true)
                Button("重试") { model.retry() }.disabled(controlsDisabled || model.status?.actions.retry != true)
            }
            .buttonStyle(SolidButtonStyle())
        }
    }

    private var preview: some View {
        ZStack {
            if let draft = model.draft, let request = previewRequest(draft) {
                let revision = model.previewRevision
                SessionSharePreview(request: request, capturedAt: draft.capturedAt, printer: isPDF ? printer : nil, onReady: {
                    guard model.draft?.id == draft.id, model.previewRevision == revision else { return }
                    model.previewReady = true
                    model.previewFailed = false
                    model.previewExpired = false
                }, onFailure: { expired in
                    guard model.draft?.id == draft.id, model.previewRevision == revision else { return }
                    model.previewReady = false
                    model.previewFailed = true
                    model.previewExpired = expired
                })
                .id("\(draft.id)|\(revision)")
                if !model.previewReady {
                    VStack(spacing: Space.md) {
                        if model.previewFailed {
                            Text(model.previewExpired ? String(localized: "预览已过期，请重新生成") : String(localized: "预览加载失败，请重试"))
                                .font(RiffetFont.caption).foregroundStyle(palette.danger)
                            Button(model.previewExpired ? String(localized: "重新生成") : String(localized: "重新加载")) {
                                if model.previewExpired {
                                    model.generate(selection: selection, appearance: appearance, author: hasOwner && showAuthor)
                                } else {
                                    model.previewFailed = false
                                    model.previewRevision += 1
                                }
                            }
                            .buttonStyle(SolidButtonStyle())
                        } else { Spinner() }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(palette.bg)
                }
            } else {
                VStack(spacing: Space.md) {
                    Image(icon: "doc.text").font(.riffet(size: 32)).foregroundStyle(palette.fg3)
                    Text(session.title).font(RiffetFont.label).foregroundStyle(palette.fg2).lineLimit(2)
                }
                .padding(Space.xl)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func previewRequest(_ draft: ShareDraft) -> URLRequest? {
        guard let base = workbench.host.api?.baseUrl,
              let previewURL = URL(string: draft.previewUrl.hasPrefix("/") ? base + draft.previewUrl : draft.previewUrl),
              ProjectDownloads.allowsAuthorization(previewURL, baseURL: base),
              var components = URLComponents(url: previewURL, resolvingAgainstBaseURL: false) else { return nil }
        if isPDF {
            var query = (components.queryItems ?? []).filter { $0.name != "print" && $0.name != "nativePrint" }
            query.append(contentsOf: [URLQueryItem(name: "print", value: "1"), URLQueryItem(name: "nativePrint", value: "1")])
            components.queryItems = query
        }
        guard let url = components.url else { return nil }
        var request = ProjectDownloads.authorized(url)
        request.setValue("1", forHTTPHeaderField: "X-Riffet-Share-Preview")
        return request
    }
}
