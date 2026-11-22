import SwiftUI
import RiffetKit

/// The reader's own fold choice for each run of tool calls. It lives outside the list cells (they are
/// reused) and outside the view that builds the plan, because the plan itself needs it: an open run
/// lists its calls as cells of their own. Keys carry the server and session, since row keys are only
/// unique within one transcript. Small flags only, cleared when they pile up.
@MainActor @Observable
final class ConversationToolRunChoices {
    static let shared = ConversationToolRunChoices()
    private var flags: [String: Bool] = [:]
    /// Runs drawn open by default. Not observed: planning records into it while the page draws.
    @ObservationIgnored private var seenOpen: Set<String> = []
    subscript(key: String) -> Bool? {
        get { flags[key] }
        set {
            if flags.count > 4_096 { flags.removeAll(keepingCapacity: true) }
            flags[key] = newValue
        }
    }
    /// The run's fold when the reader has not chosen. A run the reader saw open stays open while they
    /// read above the bottom, so the rows they are looking at do not slide when it settles. One way
    /// only: a run already folded at the bottom stays folded when they leave it, as they do the moment
    /// something they open pushes the bottom away; reopening it then slid everything after it.
    func open(_ key: String, byDefault open: Bool, readingAbove: Bool) -> Bool {
        if open {
            if seenOpen.count > 4_096 { seenOpen.removeAll(keepingCapacity: true) }
            seenOpen.insert(key)
            return true
        }
        guard readingAbove else { seenOpen.remove(key); return false }
        return seenOpen.contains(key)
    }
}

/// Whether a call is still going or never settled, kept per immutable item so planning a long
/// transcript does not parse every call again on each pass.
@MainActor
private enum ConversationToolRunState {
    private final class Entry {
        let item: TimelineItemTool // Retain identity while its cache key exists.
        let active: Bool
        let incomplete: Bool
        init(item: TimelineItemTool, active: Bool, incomplete: Bool) { self.item = item; self.active = active; self.incomplete = incomplete }
    }
    private static let cache: NSCache<NSString, Entry> = CacheRegistry.cache("conversation.toolRunState", count: 512)
    static func state(_ item: TimelineItemTool, stale: Bool) -> (active: Bool, incomplete: Bool) {
        let key = "\(ObjectIdentifier(item))|\(stale)" as NSString
        if let hit = cache.object(forKey: key) { return (hit.active, hit.incomplete) }
        let presentation = toolPresentation(item: item, root: nil, stale: stale)
        let active = item.job.map { $0.status == .running } ?? presentation.running
        let incomplete = item.job.map { $0.status == .unknown } ?? presentation.dangling
        cache.setObject(Entry(item: item, active: active, incomplete: incomplete), forKey: key)
        return (active, incomplete)
    }
}

/// Native scroll rows, with process children at the same lazy-layout level as their header.
/// Entries retain immutable DTO references; generating a plan never parses or copies message text.
enum ConversationRenderPlan {
    /// A stretch of tool calls (and the reasoning between them) folded into one line.
    struct ToolRun {
        let id: String
        /// Where the reader's fold choice is kept (`ConversationToolRunChoices`).
        let choiceKey: String
        let items: [any TimelineItem]
        let summary: ToolRunSummary
        let open: Bool
    }

    enum Content {
        case row(any TimelineRow)
        case processHeader(TimelineRowProcess, open: Bool)
        case toolRun(ToolRun)
        /// `nested`: a member of an open tool run, drawn under its hairline.
        case item(any TimelineItem, process: TimelineRowProcess, nested: Bool)
        /// Adjacent completed tool calls sharing a `mergeKey` inside an open tool run.
        case mergedTools(ToolRunGroupEntryMerged, process: TimelineRowProcess, nested: Bool)
        case footer(TimelineRowProcess)
    }

    struct Entry: Identifiable {
        let id: String
        let rowKey: String
        let topSpacing: CGFloat
        var isLastInRow: Bool
        let content: Content
    }

    /// The air between two rows. Compact one-line rows (tool calls, run headers, folded reasoning) sit flush.
    private static let rowGap: CGFloat = 16

    @MainActor
    /// `scope` names the transcript (server and session) for tool-run fold choices; `readingAbove`: the
    /// reader is not at the bottom.
    static func entries(rows: [any TimelineRow], compactAbove: [Bool], expanded: [String: Bool], focusedRow: String?,
                        scope: String, readingAbove: Bool, disclosureState: ConversationDisclosureState? = nil, root: String? = nil) -> [Entry] {
        var result: [Entry] = []
        result.reserveCapacity(rows.count)
        for (index, row) in rows.enumerated() {
            let spacing: CGFloat = index < compactAbove.count && compactAbove[index] ? 4 : (index > 0 ? rowGap : 0)
            switch onEnum(of: row) {
            case let .process(process):
                let key = nativeKey(process.key)
                let open = expanded[key] ?? (focusedRow == key || process.running || process.issueCount > 0)
                result.append(Entry(id: key, rowKey: key, topSpacing: spacing, isLastInRow: false, content: .processHeader(process, open: open)))
                if open { appendChildren(of: process, key: key, scope: scope, readingAbove: readingAbove, disclosureState: disclosureState, root: root, to: &result) }
                if process.settled, process.endsTurn, let answer = process.answerText, !answer.isEmpty {
                    result.append(Entry(id: childID(role: "footer", row: key), rowKey: key, topSpacing: 4, isLastInRow: false, content: .footer(process)))
                }
                result[result.count - 1].isLastInRow = true
            case .single, .trigger:
                let key = nativeKey(row.key)
                result.append(Entry(id: key, rowKey: key, topSpacing: spacing, isLastInRow: true, content: .row(row)))
            }
        }
        return result
    }

    @MainActor
    private static func appendChildren(of process: TimelineRowProcess, key: String, scope: String, readingAbove: Bool, disclosureState: ConversationDisclosureState?, root: String?, to result: inout [Entry]) {
        let items = Array(process.items)
        var previous: (any TimelineItem)?
        var index = 0
        func child(_ item: any TimelineItem, id: String, nested: Bool, spacing: CGFloat) {
            result.append(Entry(id: id, rowKey: key, topSpacing: spacing, isLastInRow: false, content: .item(item, process: process, nested: nested)))
        }
        while index < items.count {
            let end = toolRunEnd(items, from: index)
            if end > index {
                let members = Array(items[index..<end])
                let id = "toolrun:" + members[0].key
                let followed = !process.endsTurn || end < items.count
                let stale = !process.turnActive
                let tools = members.compactMap { $0 as? TimelineItemTool }
                let presentations = tools.map { ConversationToolPresentations.value(item: $0, root: root, stale: stale) }
                let summary = toolRunSummary(items: tools, root: root, stale: stale, presentations: presentations)
                let choiceKey = scope + "|" + id
                let choices = ConversationToolRunChoices.shared
                let open = choices[choiceKey] ?? choices.open(choiceKey, byDefault: defaultOpen(members, process: process, followed: followed, disclosureState: disclosureState), readingAbove: readingAbove)
                result.append(Entry(id: id, rowKey: key, topSpacing: spacing(for: members[0], after: previous), isLastInRow: false, content: .toolRun(.init(id: id, choiceKey: choiceKey, items: members, summary: summary, open: open))))
                if open {
                    let presentationsByKey = Dictionary(zip(tools, presentations).map { ($0.key, $1) }, uniquingKeysWith: { first, _ in first })
                    let grouped = groupAdjacentToolRunEntries(entries: members, root: root, stale: stale, presentationsByKey: presentationsByKey)
                    for entry in grouped {
                        switch onEnum(of: entry) {
                        case let .single(single):
                            child(single.item, id: childID(role: "item", row: key, item: single.item.key), nested: true, spacing: 0)
                        case let .merged(merged):
                            result.append(Entry(id: childID(role: "merged", row: key, item: merged.key), rowKey: key, topSpacing: 0, isLastInRow: false, content: .mergedTools(merged, process: process, nested: true)))
                        }
                    }
                }
                previous = members.last
                index = end
                continue
            }
            let item = items[index]
            child(item, id: childID(role: "item", row: key, item: item.key), nested: false, spacing: spacing(for: item, after: previous))
            previous = item
            index += 1
        }
    }

    /// Where the run starting at `start` ends, or `start` when none starts there: a run needs a call in
    /// it and two items, or its items stand on their own. Prose, delegations and anything else end it.
    static func toolRunEnd(_ items: [any TimelineItem], from start: Int) -> Int {
        var end = start
        while end < items.count, joinsToolRun(items[end]) { end += 1 }
        return end - start > 1 && items[start..<end].contains(where: { isToolRunItem(item: $0) }) ? end : start
    }
    private static func joinsToolRun(_ item: any TimelineItem) -> Bool {
        isToolRunItem(item: item) || (item as? TimelineItemThought)?.channel == .thinking
    }

    /// Open while a call is working or never settled, while a member row is expanded, or while nothing follows the run; the reader's choice wins.
    @MainActor
    private static func defaultOpen(_ members: [any TimelineItem], process: TimelineRowProcess, followed: Bool, disclosureState: ConversationDisclosureState?) -> Bool {
        if !followed { return true }
        if let disclosureState, members.contains(where: { disclosureState.isItemOpen($0) }) { return true }
        let stale = !process.turnActive
        for case let tool as TimelineItemTool in members {
            let state = ConversationToolRunState.state(tool, stale: stale)
            if state.active || state.incomplete { return true }
        }
        return false
    }

    /// Consecutive one-line rows sit flush; prose keeps the row gap around it.
    private static func spacing(for item: any TimelineItem, after previous: (any TimelineItem)?) -> CGFloat {
        // The first child follows the process header, itself a compact row.
        guard let previous else { return isCompactRow(item) ? 0 : rowGap }
        return isCompactRow(item) && isCompactRow(previous) ? 0 : rowGap
    }
    private static func isCompactRow(_ item: any TimelineItem) -> Bool {
        switch onEnum(of: item) {
        case .tool: true
        case let .thought(thought): thought.channel != .narration
        default: false
        }
    }

    /// A Kotlin string reaches Swift as a bridged NSString, and hashing or comparing one walks it a
    /// character at a time through Unicode normalisation. Every pass hashes each entry's id several
    /// times (row cache, speeds, records), so the key is copied to native UTF-8 once per row
    /// (ios-performance.md §2.13). `utf8String` copies the bridged string in bulk; `makeContiguousUTF8`
    /// would copy it a scalar at a time.
    static func nativeKey(_ key: String) -> String {
        if key.utf8.withContiguousStorageIfAvailable({ _ in true }) == true { return key }
        if let utf8 = (key as NSString).utf8String { return String(cString: utf8) }
        var key = key
        key.makeContiguousUTF8()
        return key
    }

    /// Length prefixes keep arbitrary item keys containing separators unambiguous.
    private static func childID(role: String, row: String, item: String = "") -> String {
        "render.\(role):\(row.utf8.count):\(row):\(item.utf8.count):\(item)"
    }
}

extension ConversationRenderPlan.Entry {
    /// The timeline items this cell draws, by key: one for a single row or a process child, every
    /// member of a folded tool run or a batch of notices, none for a process header or footer.
    var itemKeys: [String] {
        switch content {
        case let .row(row): (row as? TimelineRowTrigger)?.notices.map(\.key) ?? [row.key]
        case let .item(item, _, _): [item.key]
        case let .mergedTools(group, _, _): group.items.map(\.key)
        case let .toolRun(run): run.open ? [] : run.items.map(\.key)
        case .processHeader, .footer: []
        }
    }

    /// Whether this cell marks find's words in its own text: a message, an answer or a thought.
    /// Elsewhere (a tool, whose match may be in a command it does not show folded; a notice) it is tinted.
    var marksFindWords: Bool {
        let item: (any TimelineItem)?
        switch content {
        case let .item(value, _, _): item = value
        case let .row(row): item = (row as? TimelineRowSingle)?.item
        default: item = nil
        }
        return item is TimelineItemUser || item is TimelineItemAssistant || item is TimelineItemThought
    }

    /// The item at the top of this cell, a real timeline row key (find starts there); a header reads its first item.
    var readingKey: String? {
        if case let .processHeader(process, _) = content { return process.items.first?.key }
        return itemKeys.first
    }
}

extension ConversationRenderPlan {
    /// What can change an entry's rendering without its identity changing.
    static func revision(_ entry: Entry, speed: SpeedTag?) -> AnyHashable {
        var hasher = Hasher()
        switch entry.content {
        case let .row(row):
            hasher.combine(ObjectIdentifier(row as AnyObject))
            // Only a terminal result's footer draws the speed. Speeds arrive with the runs, after the
            // rows: in every row's revision, they reconfigured and refitted each answer once per open.
            if let single = row as? TimelineRowSingle, single.item is TimelineItemStatus, single.footer == .shown {
                hasher.combine(speed?.label ?? ""); hasher.combine(speed?.estimated ?? false)
            }
        case let .processHeader(process, open): hasher.combine(ObjectIdentifier(process)); hasher.combine(open)
        case let .toolRun(run): hasher.combine(run.open); for item in run.items { hasher.combine(ObjectIdentifier(item as AnyObject)) }
        case let .item(item, process, nested): hasher.combine(ObjectIdentifier(item as AnyObject)); hasher.combine(process.turnActive); hasher.combine(nested)
        case let .mergedTools(group, _, nested): hasher.combine(group.key); hasher.combine(group.items.count); hasher.combine(group.failed); hasher.combine(nested); for item in group.items { hasher.combine(ObjectIdentifier(item as AnyObject)) }
        case let .footer(process): hasher.combine(ObjectIdentifier(process)); hasher.combine(speed?.label ?? ""); hasher.combine(speed?.estimated ?? false)
        }
        return hasher.finalize()
    }
}

/// One transcript entry, as the session page and a subagent's page both draw it.
struct ConversationEntryView: View {
    let entry: ConversationRenderPlan.Entry
    let workbench: Workbench
    let projectID: String
    let backend: NativeBackendId
    /// The spawning transcript when this is a subagent's page, so nested subagents resolve.
    var parentItems: [any TimelineItem]? = nil
    var speed: SpeedTag? = nil
    let toggleProcess: (TimelineRowProcess, Bool) -> Void
    @Environment(\.palette) private var palette
    var body: some View {
        switch entry.content {
        case let .row(row):
            ConversationTimelineRow(row: row, workbench: workbench, projectID: projectID, parentItems: parentItems, speed: speed).equatable()
        case let .processHeader(process, open):
            ConversationProcessHeader(row: process, open: open) { toggleProcess(process, open) }
        case let .toolRun(run):
            ConversationToolRunHeader(run: run)
        case let .item(item, process, nested):
            let content = ConversationTimelineItem(item: item, workbench: workbench, projectID: projectID, active: process.turnActive, parentItems: parentItems, showsFooter: false)
            nestedRow(content, nested: nested)
        case let .mergedTools(group, _, nested):
            nestedRow(ConversationMergedTool(group: group, workbench: workbench, projectID: projectID), nested: nested)
        case let .footer(process):
            if let answer = process.answerText { ConversationCopyActions(text: answer, endedAt: ServerTime.date(process.endedAt), speed: speed) }
        }
    }

    @ViewBuilder
    private func nestedRow<V: View>(_ content: V, nested: Bool) -> some View {
        if nested {
            // The calls hang off a hairline under the run's icon: x = 7, content 16 further in.
            content.padding(.leading, 24)
                .background(alignment: .leading) { Rectangle().fill(palette.line).frame(width: 1).padding(.leading, 7) }
        } else {
            content
        }
    }
}

/// One line naming what a run of calls did ("读取 3 个文件、运行 2 条命令 +12 −4"); the calls themselves open beneath it.
struct ConversationToolRunHeader: View {
    let run: ConversationRenderPlan.ToolRun
    @Environment(\.palette) private var palette
    @Environment(\.conversationReadAction) private var readAction
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var title: String {
        let names = run.summary.counts.prefix(2).map(Self.countLabel).joined(separator: String(localized: "、", bundle: .riffet))
        return run.summary.counts.count > 2 ? String(localized: "\(names)等", bundle: .riffet) : names
    }
    var body: some View {
        Button {
            readAction()
            withAnimation(RiffetMotion.unlessReduced(RiffetMotion.spatial, reduceMotion)) { ConversationToolRunChoices.shared[run.choiceKey] = !run.open }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: ConversationToolHeader.symbol(kind: run.summary.primaryIcon))
                    .font(.system(size: 12))
                    .foregroundStyle(palette.fg4)
                    .frame(width: 16)
                Text(title).riffetFont(.label).foregroundStyle(palette.fg3).lineLimit(1)
                if run.summary.totalAdded > 0 {
                    Text("+\(run.summary.totalAdded)").riffetFont(.monoSmall).foregroundStyle(palette.success).fixedSize()
                }
                if run.summary.totalRemoved > 0 {
                    Text("−\(run.summary.totalRemoved)").riffetFont(.monoSmall).foregroundStyle(palette.danger).fixedSize()
                }
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(palette.fg4)
                    .rotationEffect(.degrees(run.open ? 90 : 0))
                    .riffetAnimation(RiffetMotion.chevron, value: run.open)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 36)
        }
        .buttonStyle(RiffetDimPressStyle())
        .accessibilityValue(run.open ? String(localized: "已展开", bundle: .riffet) : String(localized: "已折叠", bundle: .riffet))
    }
    private static func countLabel(_ entry: ToolRunCount) -> String {
        let count = Int(entry.count)
        switch entry.bucket {
        case "read": return String(localized: "读取 \(count) 个文件", bundle: .riffet)
        case "edit": return String(localized: "编辑 \(count) 个文件", bundle: .riffet)
        case "search": return String(localized: "搜索 \(count) 次", bundle: .riffet)
        case "execute": return String(localized: "运行 \(count) 条命令", bundle: .riffet)
        case "fetch": return String(localized: "获取 \(count) 次", bundle: .riffet)
        default: return String(localized: "调用 \(count) 个工具", bundle: .riffet)
        }
    }
}
