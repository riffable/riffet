import SwiftUI
import RiffetKit

/// What a composer can offer beyond plain text, supplied by the page that hosts it.
struct ComposerFeatures {
    /// The `/` menu's commands and skills (`SlashRules.kt`).
    var slash: NativeSlashCatalog?
    /// Called as the `/` menu opens, so a stale catalog is refreshed like the web's.
    var onSlashOpen: (() -> Void)?
    /// Shown next to a typed command the catalog does not list.
    var unknownCommandHint: String?
    /// `@` file search in the project; nil turns `@` mentions off.
    var searchFiles: ((String) async -> [FileEntry])?
    var references: [PromptContextReference] = []
    var addReference: ((String) -> Void)?
    var removeReference: ((PromptContextReference) -> Void)?
    var sessionCandidates: [Session] = []
    var sessionProjects: [Project] = []
    var currentSessionId: String?
    var projectId: String?
    var addSessionReference: ((Session) -> Void)?
    var openSessionReference: ((String) -> Void)?
    /// Plain Return sends (`composerEnterBehavior == "send"`).
    var enterSends = false
    /// Presentation only; SessionComposer chooses and preserves the actual send intent.
    var steersWhileRunning = false
    var enqueue: (() -> Void)?
    /// Sends the draft as a turn of this conversation at a later time (the clock button beside send); nil where it does not apply.
    var sendLater: ((Date) -> Void)?
    /// The menu opens below the card (the home page's hero composer) instead of above it.
    var menuBelow = false
}

/// The live `/` or `@` token under the caret (`Composer.tsx`'s `detectTrigger`).
enum ComposerTrigger: Equatable {
    case slash(query: String, start: Int, leading: Bool)
    case mention(query: String, start: Int)

    var query: String {
        switch self {
        case let .slash(query, _, _), let .mention(query, _): query
        }
    }

    static func detect(_ text: String, caret: Int) -> ComposerTrigger? {
        let ns = text as NSString
        guard caret <= ns.length else { return nil }
        let before = ns.substring(to: caret)
        if let match = before.range(of: #"(?:^|\s)@([^\s@]*)$"#, options: .regularExpression) {
            let token = String(before[match]).drop { $0 != "@" }.dropFirst()
            let query = String(token)
            return .mention(query: query, start: caret - (query as NSString).length - 1)
        }
        if let slash = detectSlashTrigger(text: text, caret: Int32(caret)) {
            return .slash(query: slash.query, start: Int(slash.start), leading: slash.leading)
        }
        return nil
    }
}

/// The popover above (or below) the composer card: commands and skills for `/`, files for `@`.
struct ComposerMenuView: View {
    let trigger: ComposerTrigger
    let groups: [(skills: Bool, items: [NativeSlashItem])]
    let unknownCommand: String?
    let unknownHint: String
    let files: [FileEntry]
    let filesLoading: Bool
    let supportsFiles: Bool
    let sessions: [Session]
    let projects: [Project]
    let highlight: Int
    let choose: (Int) -> Void
    let hover: (Int) -> Void
    @Environment(\.palette) private var palette

    private static var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Radius.container, style: .continuous) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) { rows }
                    .padding(5)
            }
            .scrollIndicators(.automatic)
            .frame(maxHeight: 300)
            .fixedSize(horizontal: false, vertical: true)
            .onChange(of: highlight) { _, value in proxy.scrollTo(value) }
        }
        .modifier(ComposerMenuChrome(shape: Self.shape))
    }

    @ViewBuilder
    private var rows: some View {
        switch trigger {
        case .slash:
            let offsets = groups.indices.map { index in groups[..<index].reduce(0) { $0 + $1.items.count } }
            ForEach(groups.indices, id: \.self) { groupIndex in
                if groups.count > 1 { section(groups[groupIndex].skills ? "Skills" : String(localized: "命令"), first: groupIndex == 0) }
                ForEach(Array(groups[groupIndex].items.enumerated()), id: \.offset) { itemIndex, item in
                    let index = offsets[groupIndex] + itemIndex
                    row(index, symbol: groups[groupIndex].skills ? "sparkles" : "command", title: "/\(item.name)", detail: item.description_ ?? item.hint)
                        .help(item.description_ ?? "")
                }
            }
            if let unknownCommand {
                row(groups.reduce(0) { $0 + $1.items.count }, symbol: "questionmark.circle", title: "/\(unknownCommand)", detail: unknownHint)
            }
        case .mention:
            if supportsFiles { section(filesLoading ? String(localized: "正在搜索文件…") : String(localized: "引用文件"), first: true) }
            ForEach(Array(files.enumerated()), id: \.offset) { index, file in
                row(index, symbol: FileSymbols.symbol(file.name), title: file.name, detail: (file.path as NSString).deletingLastPathComponent, detailHead: true)
            }
            if !sessions.isEmpty {
                section(String(localized: "会话"), first: files.isEmpty)
                ForEach(Array(sessions.enumerated()), id: \.offset) { index, session in
                    row(files.count + index, symbol: "text.bubble", title: session.title,
                        detail: [projects.first(where: { $0.id == session.projectId })?.name, session.agent].compactMap { $0 }.joined(separator: " · "))
                }
            }
            if files.isEmpty, sessions.isEmpty, !filesLoading {
                Text(supportsFiles ? (trigger.query.isEmpty ? "输入文件名进行搜索" : "没有匹配的文件") : "没有匹配的会话")
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .frame(height: 24)
            }
        }
    }

    private func section(_ title: String, first: Bool) -> some View {
        Text(title)
            .font(.riffet(size: S(11), weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.top, first ? 3 : 9)
            .padding(.bottom, 3)
    }

    /// A row as a native list draws it: the system selection colour with white text when chosen.
    private func row(_ index: Int, symbol: String, title: String, detail: String?, detailHead: Bool = false) -> some View {
        let selected = index == highlight
        return HStack(spacing: 7) {
            Image(icon: symbol)
                .font(.riffet(size: S(12)))
                .foregroundStyle(selected ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
                .frame(width: 16)
            Text(title)
                .font(.riffet(size: S(13)))
                .foregroundStyle(selected ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
                .lineLimit(1)
                .layoutPriority(1)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(selected ? AnyShapeStyle(.white.opacity(0.8)) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                    .truncationMode(detailHead ? .head : .tail)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 5)
        .frame(height: 24)
        .background(selected ? Color(nsColor: .selectedContentBackgroundColor) : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .contentShape(Rectangle())
        .onHover { if $0 { hover(index) } }
        .onTapGesture { choose(index) }
        .id(index)
    }
}

/// A file the next message cites, as a removable chip in the attachment rail.
struct ReferenceChip: View {
    let reference: PromptContextReference
    let remove: () -> Void
    var open: (() -> Void)? = nil
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            Image(icon: reference.kind == "session" ? "text.bubble" : "at").font(.riffet(size: S(11), weight: .semibold)).foregroundStyle(palette.mark)
            Text(reference.kind == "session" ? reference.title ?? reference.sessionId ?? "" : (reference.path as NSString).lastPathComponent + (reference.line.map { ":\($0.int64Value)" } ?? ""))
                .font(.riffet(size: S(12), design: .monospaced))
                .foregroundStyle(palette.fg)
                .lineLimit(1)
            Button(action: remove) {
                Image(icon: "xmark").font(.riffet(size: S(8), weight: .bold)).foregroundStyle(palette.fg3)
            }
            .buttonStyle(.plain)
            .opacity(hovering ? 1 : 0.55)
        }
        .padding(.horizontal, Space.sm)
        .frame(height: 28)
        .background(palette.markSoft.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .help(reference.path + (reference.line.map { ":\($0.int64Value)" } ?? ""))
        .onHover { hovering = $0 }
        .onTapGesture { open?() }
    }
}

/// The menu's card: the drawn menus' surface under the drawn recipe, the system's material otherwise.
private struct ComposerMenuChrome: ViewModifier {
    let shape: RoundedRectangle

    func body(content: Content) -> some View {
        if DisplayPreferences.shared.style.menu == .drawn {
            content.floatingSurface(cornerRadius: Radius.menu)
        } else {
            content
                .background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
                .elevation(.pop)
        }
    }
}
