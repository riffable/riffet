import AppKit
import SwiftUI
import RiffetKit

/// Every saved reply (收藏, `MarksPage.tsx`): search, filter, notes, batch delete,
/// and the way back to where each one was said. A mark whose message can no longer be found keeps
/// its saved text, so it stays readable here.
struct MarksPage: View {
    let workbench: Workbench
    /// Kept by the workbench: a later visit shows the last results and query while they are read again.
    @Bindable private var model: MarksModel
    @State private var selecting = false
    @State private var chosen: Set<String> = []
    @State private var confirmDelete = false
    @Environment(\.palette) private var palette

    init(workbench: Workbench) {
        self.workbench = workbench
        model = workbench.pageModels.marks
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let error = model.error, model.loaded != nil {
                    NoticeBar(tone: .warning, symbol: "exclamationmark.triangle", text: error) {
                        Button("重试") { Task { await model.reload() } }.buttonStyle(ChipButtonStyle())
                    }.padding(.bottom, Space.md)
                }
                content
            }
            .padding(.horizontal, Space.xl)
            .padding(.top, Space.lg)
            .padding(.bottom, Space.xxl * 2)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .navigationTitle(WorkbenchPage.marks.title)
        .pageChrome(.marks, workbench: workbench, search: PageSearch(text: $model.query.q, prompt: String(localized: "搜索收藏的内容、备注或会话"))) {
            if selecting {
                PageActionButton(title: chosen.isEmpty ? String(localized: "删除") : String(localized: "删除 \(chosen.count) 条"), symbol: "trash", titled: true) { confirmDelete = true }
                    .disabled(chosen.isEmpty)
                PageActionButton(title: String(localized: "完成"), symbol: "checkmark", titled: true) { selecting = false; chosen = [] }
            } else {
                PageMenuButton(symbol: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease", help: String(localized: "筛选"), build: filterMenu)
                PageActionButton(title: String(localized: "选择"), symbol: "checkmark.circle") { selecting = true }
                    .disabled(model.marks.isEmpty)
            }
        }
        // A change made anywhere (a transcript, the web, another window) bumps the store's revision.
        .onAppear { MarksStore.shared.follow() }
        .onDisappear { MarksStore.shared.unfollow() }
        .task(id: ReloadKey(query: model.query, revision: MarksStore.shared.revision)) {
            if !model.query.q.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await model.reload()
            chosen.formIntersection(model.marks.map(\.id))
        }
        .confirmationDialog("删除 \(chosen.count) 条收藏？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                let ids = Array(chosen)
                Task {
                    if await model.delete(ids) { chosen = []; selecting = false }
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("收藏里保存的原文也会一并删除，原会话不受影响。")
        }
    }

    // MARK: Filters

    /// A kind or a project narrows the list; the query alone is the search field's to show.
    private var filtered: Bool { model.tab != .all || model.query.projectId != nil }

    private func filterMenu() -> NSMenu {
        let menu = NSMenu()
        for tab in MarksTab.allCases {
            let item = MenuAction.item(tab.title) { model.tab = tab }
            item.state = model.tab == tab ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: String(localized: "项目")))
        let all = MenuAction.item(String(localized: "全部项目")) { model.query.projectId = nil }
        all.state = model.query.projectId == nil ? .on : .off
        menu.addItem(all)
        for project in workbench.projects {
            let item = MenuAction.item(project.name) { model.query.projectId = project.id }
            item.state = model.query.projectId == project.id ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if let error = model.error, model.loaded == nil {
            VStack(spacing: Space.md) {
                Text(error).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).multilineTextAlignment(.center)
                Button("重试") { Task { await model.reload() } }.buttonStyle(SolidButtonStyle())
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 80)
        } else if model.loaded == nil {
            Spinner().frame(maxWidth: .infinity).padding(.top, 120)
        } else if model.marks.isEmpty {
            emptyState
        } else {
            ForEach(model.days, id: \.label) { day in
                Section {
                    VStack(spacing: Space.md) {
                        ForEach(day.marks) { mark in
                            MarkCard(
                                mark: mark,
                                created: model.created[mark.id],
                                projectName: workbench.project(mark.projectId)?.name,
                                selecting: selecting,
                                chosen: chosen.contains(mark.id),
                                choose: { on in if on { chosen.insert(mark.id) } else { chosen.remove(mark.id) } },
                                open: { open(mark) },
                                openFile: { open(mark, file: true) },
                                saveNote: { note in Task { await model.saveNote(mark, note) } },
                                delete: { Task { _ = await model.delete([mark.id]) } },
                                export: { ShareImage.present(ShareSource(mark: mark, project: workbench.project(mark.projectId)?.name)) }
                            )
                            .onAppear { if mark.id == model.marks.last?.id, model.moreError == nil { Task { await model.loadMore() } } }
                        }
                    }
                    .padding(.bottom, Space.xl)
                } header: {
                    Text(day.label)
                        .font(.riffet(size: S(12), weight: .medium))
                        .foregroundStyle(palette.fg3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, Space.sm)
                }
            }
            if model.loadingMore { Spinner(size: .small).frame(maxWidth: .infinity).padding(.vertical, Space.md) }
            if let error = model.moreError {
                NoticeBar(tone: .warning, symbol: "exclamationmark.triangle", text: error) {
                    Button("重试") { Task { await model.loadMore() } }.buttonStyle(ChipButtonStyle())
                }
            }
        }
    }

    private var emptyState: some View {
        let filtered = model.query.isFiltered
        return VStack(spacing: Space.md) {
            Image(icon: filtered ? "magnifyingglass" : "bookmark").font(.riffet(size: S(26), weight: .light)).foregroundStyle(palette.fg4)
            Text(filtered ? "没有符合条件的收藏" : "还没有收藏").font(.riffet(size: S(15), weight: .semibold)).foregroundStyle(palette.fg)
            if !filtered {
                Text("在回复、文字或图片上点右键即可收藏。")
                    .font(.riffet(size: S(12.5)))
                    .foregroundStyle(palette.fg3)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .frame(maxWidth: 400)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 100)
    }

    // MARK: Opening

    /// Opens the mark where its message is now: the server re-locates it (rewriting a stale anchor),
    /// and the transcript reads older pages until the message is loaded, as a search hit does.
    private func open(_ mark: Mark, file: Bool = false) {
        Task {
            defer { if file, let path = mark.asset?.path { workbench.preview(path: path) } }
            let location = try? await MarksStore.shared.locate(mark.id)
            if let location, location.found {
                workbench.focus = TranscriptFocus(
                    sessionId: mark.sessionId,
                    sequence: location.sequence?.int64Value,
                    messageIds: [location.messageId].compactMap { $0 } + mark.anchor.ids,
                    quote: mark.quote,
                    exact: true
                )
            } else {
                workbench.notice = SessionNotice(sessionId: mark.sessionId, text: location == nil ? String(localized: "无法定位这条收藏，已打开所在会话。") : String(localized: "这条收藏的原文已找不到，已打开所在会话。"))
            }
            workbench.open(sessionId: mark.sessionId)
        }
    }
}

/// The filter row: a kind of mark, or only those whose message can no longer be found.
enum MarksTab: CaseIterable {
    case all, message, span, asset, orphaned

    var title: String {
        switch self {
        case .all: String(localized: "全部")
        case .message: String(localized: "回复")
        case .span: String(localized: "高亮")
        case .asset: String(localized: "图片与文件")
        case .orphaned: String(localized: "找不到原文")
        }
    }
}

private struct ReloadKey: Equatable {
    let query: MarkQuery
    let revision: Int64
}

private extension MarkQuery {
    var isFiltered: Bool { projectId != nil || kind != nil || state != nil || !q.trimmingCharacters(in: .whitespaces).isEmpty }
}

/// One saved reply as a card: where it came from, the words themselves (a highlight in its own
/// colour, an answer as rendered Markdown that fades out), and the note. Its actions take the
/// timestamp's place on hover, so nothing moves under the pointer.
private struct MarkCard: View {
    let mark: Mark
    /// When it was saved, parsed once with the page of results.
    let created: Date?
    let projectName: String?
    let selecting: Bool
    let chosen: Bool
    let choose: (Bool) -> Void
    let open: () -> Void
    let openFile: () -> Void
    let saveNote: (String) -> Void
    let delete: () -> Void
    let export: () -> Void
    @State private var hovering = false
    @State private var editing = false
    @State private var draft = ""
    @State private var bodyHeight: CGFloat = 0
    @State private var picture: NSImage?
    @State private var pictureFailed = false
    @State private var imageAnchor = ImageViewer.Anchor()
    @State private var previewHidden = false
    @FocusState private var noteFocused: Bool
    @Environment(\.palette) private var palette

    private static let bodyLimit: CGFloat = 240

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            header
            switch mark.kind {
            case "span": quote
            case "image": savedImage
            case "file": savedFile
            default: answer
            }
            note
        }
        .padding(.horizontal, Space.lg + 4)
        .padding(.vertical, Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .fill(palette.bgElevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(chosen ? palette.mark : hovering ? palette.lineStrong : palette.line, lineWidth: chosen ? 1.5 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .onHover { hovering = $0 }
        .animation(.snappy(duration: 0.12), value: hovering)
        .animation(.snappy(duration: 0.12), value: chosen)
        .onTapGesture { if selecting { choose(!chosen) } else if !editing { open() } }
        .contextMenu {
            Button(mark.kind == "file" ? "打开会话并预览文件" : "打开原会话", action: mark.kind == "file" ? openFile : open)
            if mark.kind == "image", picture != nil { Button("查看大图", action: openImage) }
            Button(mark.note?.isEmpty == false ? "编辑备注" : "添加备注", action: beginEditing)
            Button("复制内容", action: copy)
            if mark.isMessage || mark.isSpan { Button("导出图片", action: export) }
            Divider()
            Button("删除收藏", role: .destructive, action: delete)
        }
    }

    // MARK: Parts

    private var header: some View {
        HStack(spacing: Space.sm) {
            if selecting {
                Image(icon: chosen ? "checkmark.circle.fill" : "circle")
                    .font(.riffet(size: S(14)))
                    .foregroundStyle(chosen ? palette.mark : palette.fg4)
            }
            if mark.isSpan {
                Circle().fill(Color(nsColor: mark.markColor.nsColor)).frame(width: 7, height: 7)
            } else {
                Image(icon: mark.kind == "image" ? "photo" : mark.kind == "file" ? "doc.text" : "bookmark").font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
            }
            Text(mark.snapshot.sessionTitle.isEmpty ? String(localized: "未命名会话") : mark.snapshot.sessionTitle)
                .font(.riffet(size: S(12), weight: .medium))
                .foregroundStyle(palette.fg2)
                .lineLimit(1)
            if let projectName {
                Text(projectName).font(.riffet(size: S(12))).foregroundStyle(palette.fg4).lineLimit(1).layoutPriority(-1)
            }
            if mark.orphaned {
                Text("原文已找不到")
                    .font(.riffet(size: S(10.5), weight: .medium))
                    .padding(.horizontal, 6)
                    .frame(height: 18)
                    .background(palette.warningSoft, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .foregroundStyle(palette.warning)
                    .fixedSize()
            }
            Spacer(minLength: Space.sm)
            ZStack(alignment: .trailing) {
                Text(relativeTime)
                    .font(.riffet(size: S(11.5)))
                    .monospacedDigit()
                    .foregroundStyle(palette.fg4)
                    .opacity(hovering && !selecting ? 0 : 1)
                    .help(mark.createdAt)
                if !selecting {
                    HStack(spacing: 2) {
                        // The jump comes first: a saved asset is opened where it was saved, and the
                        // asset's own preview is what a click on the card already shows.
                        if mark.isAsset {
                            action(mark.kind == "file" ? String(localized: "打开会话并预览文件") : String(localized: "跳转到对话"),
                                   symbol: "text.bubble",
                                   run: mark.kind == "file" ? openFile : open)
                        }
                        action(mark.note?.isEmpty == false ? String(localized: "编辑备注") : String(localized: "添加备注"), symbol: "square.and.pencil", run: beginEditing)
                        if !mark.isAsset { action(mark.kind == "file" ? String(localized: "复制路径") : String(localized: "复制内容"), symbol: "doc.on.doc", run: copy) }
                        if mark.isMessage || mark.isSpan { action(String(localized: "导出图片"), symbol: "square.and.arrow.up", run: export) }
                        action(String(localized: "删除收藏"), symbol: "trash", run: delete)
                    }
                    .opacity(hovering ? 1 : 0)
                    .allowsHitTesting(hovering)
                }
            }
            .fixedSize()
        }
        .frame(height: 22)
    }

    private func action(_ title: String, symbol: String, run: @escaping () -> Void) -> some View {
        Button(action: run) { Image(icon: symbol).font(.riffet(size: S(11.5))) }
            .buttonStyle(IconButtonStyle(size: 22))
            .help(title)
    }

    /// A highlight reads as one: the words on their own colour, a little larger than body text.
    private var quote: some View {
        var text = AttributedString((mark.quote?.exact ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        text.backgroundColor = Color(nsColor: mark.markColor.fill)
        return Text(text)
            .font(.riffet(size: S(14.5)))
            .foregroundStyle(mark.orphaned ? palette.fg2 : palette.fg)
            .lineSpacing(6)
            .lineLimit(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.disabled)
    }

    /// A saved picture: the copy the server keeps, so it shows after the file or conversation is gone.
    private var savedImage: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let picture {
                    Image(nsImage: picture).resizable().aspectRatio(contentMode: .fit)
                } else {
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle)
                        .overlay { if pictureFailed { Text("图片无法加载").font(.riffet(size: S(12))).foregroundStyle(palette.fg4) } else { Spinner(size: .small) } }
                        .frame(height: 160)
                }
            }
            .frame(maxWidth: picture.map { min($0.size.width, 640) }, maxHeight: 280, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
            // The conversation's own viewer, from the thumbnail already on screen: a saved picture
            // opens exactly the way the image in an agent's reply does.
            .background(ImageViewerAnchorView(anchor: imageAnchor).id(mark.id).allowsHitTesting(false))
            .opacity(previewHidden ? 0 : 1)
            .contentShape(Rectangle())
            .onTapGesture { if selecting { choose(!chosen) } else if !editing { openImage() } }
            if let path = mark.asset?.path {
                Text(path).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4).lineLimit(1).truncationMode(.middle)
            }
        }
        .task(id: mark.id) {
            do { picture = try await MarksStore.shared.asset(mark.id) } catch { pictureFailed = true }
        }
    }

    /// A saved file: what it is, where it lives, and what the agent did to it.
    private var savedFile: some View {
        let name = mark.asset?.name ?? ""
        let directory = mark.asset?.path.map { ($0 as NSString).deletingLastPathComponent }
        return HStack(spacing: Space.md) {
            Image(icon: "doc.text")
                .font(.riffet(size: S(14)))
                .foregroundStyle(palette.fg3)
                .frame(width: 34, height: 34)
                .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgElevated))
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.riffet(size: S(13), design: .monospaced)).foregroundStyle(palette.fg).lineLimit(1)
                if let directory, !directory.isEmpty {
                    Text(directory).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: Space.sm)
            if let detail = mark.asset?.detail {
                HStack(spacing: 6) {
                    ForEach(detail.split(separator: " ").map(String.init), id: \.self) { part in
                        Text(part).foregroundStyle(part.hasPrefix("+") ? palette.success : part.hasPrefix("−") ? palette.danger : palette.fg4)
                    }
                }
                .font(.riffet(size: S(11.5), design: .monospaced))
                .monospacedDigit()
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if selecting { choose(!chosen) } else if !editing { openFile() } }
        .padding(.horizontal, Space.md)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
    }

    /// The answer as the transcript renders it, cut to a few paragraphs and faded out where it goes on.
    private var answer: some View {
        let excerpt = Self.excerpt(mark.snapshot.text)
        let faded = excerpt.cut || bodyHeight > Self.bodyLimit
        return MarkdownView(source: excerpt.source, compact: true, muted: mark.orphaned)
            .background(GeometryReader { proxy in Color.clear.preference(key: BodyHeightKey.self, value: proxy.size.height) })
            .onPreferenceChange(BodyHeightKey.self) { bodyHeight = $0 }
            .allowsHitTesting(false)
            .frame(maxWidth: .infinity, maxHeight: Self.bodyLimit, alignment: .topLeading)
            .clipped()
            .mask(
                LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: faded ? 0.72 : 1), .init(color: faded ? .clear : .black, location: 1)], startPoint: .top, endPoint: .bottom)
            )
    }

    @ViewBuilder
    private var note: some View {
        if editing {
            TextField("写点什么，方便以后找到它…", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.riffet(size: S(12.5)))
                .lineLimit(2...6)
                .focused($noteFocused)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.mark.opacity(0.5)))
                .onSubmit(commit)
                .onExitCommand { editing = false }
                .onChange(of: noteFocused) { _, focused in if !focused { commit() } }
        } else if let note = mark.note, !note.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                Image(icon: "text.quote").font(.riffet(size: S(10.5))).foregroundStyle(palette.fg4)
                Text(note).font(.riffet(size: S(12.5))).foregroundStyle(palette.fg2).lineSpacing(3).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgSubtle))
            .onTapGesture { if !selecting { beginEditing() } }
        }
    }

    // MARK: Actions

    private var relativeTime: String {
        guard let created else { return "" }
        return MarksModel.relative.localizedString(for: created, relativeTo: Date())
    }

    private func beginEditing() {
        draft = mark.note ?? ""
        editing = true
        DispatchQueue.main.async { noteFocused = true }
    }

    private func commit() {
        guard editing else { return }
        editing = false
        let next = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if next != (mark.note ?? "") { saveNote(next) }
    }

    /// Opens the saved picture in the conversation's own viewer, on the copy the server keeps (the
    /// original file may be gone), from the thumbnail that is already on screen.
    private func openImage() {
        guard let picture else { return }
        ImageViewer.shared.show(
            image: picture,
            source: .local(MarksStore.png(picture) ?? Data()),
            projectId: mark.projectId,
            label: mark.asset?.name ?? String(localized: "图片"),
            origin: imageAnchor.origin(visibility: { previewHidden = !$0 })
        )
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(mark.excerpt, forType: .string)
    }

    /// The start of a saved answer, cut at a paragraph so the Markdown still parses as written; a
    /// code fence the cut leaves open is closed.
    static func excerpt(_ text: String) -> (source: String, cut: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let limit = 1200
        guard trimmed.count > limit else { return (trimmed, false) }
        let head = String(trimmed.prefix(limit))
        var source = head
        if let paragraph = head.range(of: "\n\n", options: .backwards), head.distance(from: head.startIndex, to: paragraph.lowerBound) > limit / 3 {
            source = String(head[..<paragraph.lowerBound])
        } else if let line = head.range(of: "\n", options: .backwards), head.distance(from: head.startIndex, to: line.lowerBound) > limit / 2 {
            source = String(head[..<line.lowerBound])
        }
        let fences = source.components(separatedBy: "\n").filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
        if fences % 2 == 1 { source += "\n```" }
        return (source, true)
    }
}

private struct BodyHeightKey: SwiftUI.PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The page's query and the pages of results read for it.
@MainActor
@Observable
final class MarksModel {
    static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = AppLocale.current
        formatter.unitsStyle = .short
        return formatter
    }()

    private static let pageSize = 30
    /// One formatter per format: a shared one whose format changes per call is neither cheap nor safe.
    /// Templates, so each language orders the parts its own way (Chinese: M月d日 EEEE).
    private static func dayFormat(_ template: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = AppLocale.current
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter
    }
    private static let weekDayFormat = dayFormat("MMMdEEEE")
    private static let monthDayFormat = dayFormat("MMMd")
    private static let fullDayFormat = dayFormat("yMMMd")

    /// 今天, 昨天, or the date.
    static func dayLabel(_ date: Date?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date else { return String(localized: "更早") }
        if calendar.isDateInToday(date) { return String(localized: "今天") }
        if calendar.isDateInYesterday(date) { return String(localized: "昨天") }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return (days < 7 ? weekDayFormat : sameYear ? monthDayFormat : fullDayFormat).string(from: date)
    }

    var query = MarkQuery(limit: 30)
    /// The filter row, kept in [query]: a kind, or only marks whose message is gone.
    var tab: MarksTab {
        get { query.state == "orphaned" ? .orphaned : query.kind == "message" ? .message : query.kind == "span" ? .span : query.kind == "image,file" ? .asset : .all }
        set {
            query.kind = newValue == .message ? "message" : newValue == .span ? "span" : newValue == .asset ? "image,file" : nil
            query.state = newValue == .orphaned ? "orphaned" : nil
        }
    }
    /// Consecutive marks of one day under one heading; the list is newest first, so a day never splits.
    /// Grouped when the results change, not on every redraw.
    private(set) var days: [(label: String, marks: [Mark])] = []
    /// Each shown mark's creation time, parsed once.
    @ObservationIgnored private(set) var created: [String: Date] = [:]
    private(set) var marks: [Mark] = [] { didSet { regroup() } }
    /// The day the headings were grouped on: 今天 and 昨天 move at midnight even if the marks do not.
    @ObservationIgnored private var groupedOn = Calendar.current.startOfDay(for: .now)
    private(set) var total = 0
    /// The query the shown results answer; nil before the first read.
    private(set) var loaded: MarkQuery?
    private(set) var nextCursor: String?
    private(set) var error: String?
    private(set) var moreError: String?
    private(set) var loadingMore = false
    @ObservationIgnored private var ticket = 0

    /// Reads the first page again, keeping as many rows as were shown so a change does not shorten the list.
    func reload() async {
        ticket += 1
        let started = ticket
        var first = query
        first.cursor = nil
        first.limit = loaded == query ? min(max(marks.count, Self.pageSize), 200) : Self.pageSize
        do {
            let page = try await MarksStore.shared.list(first)
            guard started == ticket else { return }
            // A revisit or a revision bump usually answers what is already shown.
            if page.marks != marks { marks = page.marks } else if groupedOn != Calendar.current.startOfDay(for: .now) { regroup() }
            if Int(page.total) != total { total = Int(page.total) }
            if page.nextCursor != nextCursor { nextCursor = page.nextCursor }
            if loaded != query { loaded = query }
            if error != nil { error = nil }
            moreError = nil
        } catch is CancellationError {} catch {
            guard started == ticket else { return }
            self.error = error.riffetMessage
        }
    }

    func loadMore() async {
        guard let cursor = nextCursor, !loadingMore, loaded == query else { return }
        loadingMore = true
        moreError = nil
        defer { loadingMore = false }
        let started = ticket
        var next = query
        next.cursor = cursor
        next.limit = Self.pageSize
        do {
            let page = try await MarksStore.shared.list(next)
            guard started == ticket else { return }
            let known = Set(marks.map(\.id))
            marks += page.marks.filter { !known.contains($0.id) }
            nextCursor = page.nextCursor
            total = Int(page.total)
        } catch is CancellationError {} catch {
            guard started == ticket else { return }
            moreError = error.riffetMessage
        }
    }

    private func regroup() {
        groupedOn = Calendar.current.startOfDay(for: .now)
        var dates: [String: Date] = [:]
        dates.reserveCapacity(marks.count)
        var groups: [(label: String, marks: [Mark])] = []
        let now = Date()
        let calendar = Calendar.current
        var labels: [Date: String] = [:]
        for mark in marks {
            let date = created[mark.id] ?? ServerTime.date(mark.createdAt)
            if let date { dates[mark.id] = date }
            let day = date.map { calendar.startOfDay(for: $0) }
            let label: String
            if let day, let known = labels[day] { label = known } else {
                label = Self.dayLabel(date, now: now, calendar: calendar)
                if let day { labels[day] = label }
            }
            if groups.last?.label == label { groups[groups.count - 1].marks.append(mark) } else { groups.append((label, [mark])) }
        }
        created = dates
        days = groups
    }

    func saveNote(_ mark: Mark, _ note: String) async {
        do {
            let updated = try await MarksStore.shared.setNote(mark.id, note)
            if let index = marks.firstIndex(where: { $0.id == mark.id }) { marks[index] = updated }
        } catch {
            show(error)
        }
    }

    @discardableResult
    func delete(_ ids: [String]) async -> Bool {
        do {
            try await MarksStore.shared.delete(ids)
            let gone = Set(ids)
            marks.removeAll { gone.contains($0.id) }
            total = max(0, total - ids.count)
            return true
        } catch {
            show(error)
            return false
        }
    }

    private func show(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = String(localized: "收藏操作失败")
        alert.informativeText = error.riffetMessage
        alert.runModal()
    }
}
