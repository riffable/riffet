import Foundation
import Observation
import RiffetKit

/// 标签样式: whether the Riffet header draws session tabs. Off, it names the open conversation instead.
enum SessionTabStyle: String, CaseIterable, Identifiable {
    case titleBar, off

    var id: String { rawValue }
}

/// 打开会话时. `preview`: a newly opened conversation is a temporary tab, kept once the reader sends
/// a message there. `keep`: it is kept at once. `manual`: it stays temporary until the reader adds it.
enum SessionTabOpenMode: String, CaseIterable, Identifiable {
    case preview, keep, manual

    var id: String { rawValue }
}

/// The tab settings of this Mac (the web's `tabsStore` style and open mode).
@MainActor
@Observable
final class SessionTabsPreferences {
    static let shared = SessionTabsPreferences()

    var style: SessionTabStyle { didSet { UserDefaults.standard.set(style.rawValue, forKey: Self.styleKey) } }
    var openMode: SessionTabOpenMode { didSet { UserDefaults.standard.set(openMode.rawValue, forKey: Self.openModeKey) } }

    private static let styleKey = "riffet.session-tab-style"
    private static let openModeKey = "riffet.session-tab-open"

    private init() {
        let defaults = UserDefaults.standard
        style = defaults.string(forKey: Self.styleKey).flatMap(SessionTabStyle.init) ?? .titleBar
        openMode = defaults.string(forKey: Self.openModeKey).flatMap(SessionTabOpenMode.init) ?? .preview
    }

    /// The tab bar is on screen: the style draws one and the setting has not turned it off.
    var active: Bool {
        let spec = DisplayPreferences.shared.style
        return style == .titleBar && spec.backend == .custom && spec.header == .sessionTabs
    }
}

struct SessionTabEntry: Codable, Equatable {
    var sessionId: String
    /// The tab the next conversation opened from anywhere replaces.
    var preview: Bool
}

/// A tab with its conversation.
struct SessionTabItem: Identifiable {
    let entry: SessionTabEntry
    let session: Session
    let pinned: Bool

    var id: String { session.id }
}

/// The menu commands of the tab bar; nil in a window without one.
struct SessionTabCommands {
    /// 1–8 are the nth tab, 9 the last.
    let goTo: (Int) -> Void
    let step: (Int) -> Void
    /// Closes the tab on screen; false when no tab is.
    let closeCurrent: () -> Bool
    let reopen: () -> Void
}

/// The conversations kept as tabs on one server (the web's `tabsStore`). Opening a conversation
/// gives it a preview tab, the few ways a reader commits to it keep that tab, and the tabs persist
/// on this Mac. The header's bar feeds it the open conversation and the list (`sync`).
@MainActor
@Observable
final class SessionTabs {
    private static var models: [String: SessionTabs] = [:]

    /// The tabs of the server at [baseURL].
    static func model(for baseURL: URL) -> SessionTabs {
        let key = baseURL.absoluteString
        if let model = models[key] { return model }
        let model = SessionTabs(key: key)
        models[key] = model
        return model
    }

    private static let tabLimit = 100
    private static let closedLimit = 30
    private static let launchWindow: TimeInterval = 10

    /// In the order the reader keeps them; which zone a tab shows in follows its conversation's pin.
    private(set) var entries: [SessionTabEntry] { didSet { save() } }
    /// Conversations that finished a turn while their tab was not the one on screen.
    private(set) var unread: Set<String> = []
    /// The conversation last read: where the next tab opens.
    private(set) var anchor = ""

    @ObservationIgnored weak var workbench: Workbench?
    @ObservationIgnored private let storeKey: String
    @ObservationIgnored private var index = SessionIndex()
    @ObservationIgnored private var closed: [(sessionId: String, index: Int)] = []
    @ObservationIgnored private var seen: [String: (state: SessionState, pinned: Bool)] = [:]
    @ObservationIgnored private var launchedSession: (id: String, at: Date)?
    @ObservationIgnored private var lastCurrent: String?

    private init(key: String) {
        storeKey = "riffet.session-tabs.v2|\(key)"
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: storeKey), let stored = try? JSONDecoder().decode([SessionTabEntry].self, from: data) {
            entries = Self.normalized(stored)
        } else {
            // The first version kept a bare id list: every one of them was a kept tab.
            let legacyKey = "riffet.session-tabs|\(key)"
            let legacy = (defaults.string(forKey: legacyKey) ?? "").split(separator: "\n").map(String.init)
            entries = Self.normalized(legacy.map { SessionTabEntry(sessionId: $0, preview: false) })
            defaults.removeObject(forKey: legacyKey)
        }
    }

    /// Without repeats and with at most one preview.
    private static func normalized(_ stored: [SessionTabEntry]) -> [SessionTabEntry] {
        var ids = Set<String>()
        var previewSeen = false
        var result: [SessionTabEntry] = []
        for var entry in stored where !entry.sessionId.isEmpty && ids.insert(entry.sessionId).inserted {
            if entry.preview { if previewSeen { entry.preview = false } else { previewSeen = true } }
            result.append(entry)
            if result.count >= tabLimit { break }
        }
        return result
    }

    private func save() {
        if let data = try? JSONEncoder().encode(entries) { UserDefaults.standard.set(data, forKey: storeKey) }
    }

    private var openMode: SessionTabOpenMode { SessionTabsPreferences.shared.openMode }

    // MARK: Reading

    /// The tab on screen: none on the home page, a one-level page or an attempt group.
    var current: String? {
        guard let workbench, !workbench.showingHome, workbench.page == nil, workbench.attemptGroupSelection == nil else { return nil }
        return workbench.selected?.id
    }

    /// The conversation [id], the open one in its freshest copy.
    private func session(_ id: String) -> Session? {
        guard let workbench else { return nil }
        if let selected = workbench.selected, selected.id == id { return selected }
        return index.sessions(workbench.list)[id]
    }

    /// The tabs of conversations that exist: the pinned ones in the server's order, then the rest in the reader's.
    var zones: (pinned: [SessionTabItem], normal: [SessionTabItem]) {
        var pinned: [SessionTabItem] = []
        var normal: [SessionTabItem] = []
        for entry in entries {
            guard let session = session(entry.sessionId), session.archivedAt == nil else { continue }
            if session.pinnedAt != nil {
                pinned.append(SessionTabItem(entry: entry, session: session, pinned: true))
            } else {
                normal.append(SessionTabItem(entry: entry, session: session, pinned: false))
            }
        }
        pinned.sort { Self.pinsBefore($0.session, $1.session) }
        return (pinned, normal)
    }

    /// The server's pin order: ranked pins by rank, unranked ones before them, newest pin first.
    static func pinsBefore(_ a: Session, _ b: Session) -> Bool {
        let rankA = a.pinRank?.intValue
        let rankB = b.pinRank?.intValue
        if let rankA, let rankB { return rankA < rankB }
        if rankA != nil || rankB != nil { return rankA == nil }
        return (a.pinnedAt ?? "") > (b.pinnedAt ?? "")
    }

    func isKept(_ id: String) -> Bool {
        entries.contains { $0.sessionId == id && !$0.preview }
    }

    /// A conversation of this list has a tab, kept or not.
    func hasTab(_ id: String) -> Bool {
        entries.contains { $0.sessionId == id }
    }

    // MARK: Following the workbench

    /// The open conversation or the list changed: opens a preview tab for the conversation on
    /// screen, marks it read, and notes which conversations finished a turn or were pinned.
    func sync() {
        guard let workbench else { return }
        let list = workbench.list
        let sessions = index.sessions(list)
        let current = self.current
        if list.loaded { observe(sessions, current: current) }
        // A conversation the server no longer lists loses its tab, once a fresh list has loaded:
        // never on a cached or loading list, which may simply not have it yet.
        let fresh = list.loaded && !list.loading && list.cachedAt == nil && list.error == nil
        let gone = entries.filter { entry in
            guard let session = sessions[entry.sessionId] else { return fresh && entry.sessionId != workbench.selected?.id }
            return session.archivedAt != nil
        }
        if !gone.isEmpty { remove(Set(gone.map(\.sessionId))) }
        if let current, current != lastCurrent || !hasTab(current) {
            select(current, keep: takeLaunched(current) && openMode != .manual)
        }
        lastCurrent = current
    }

    /// What the list says about each conversation, to tell a change from a re-read.
    private func observe(_ sessions: [String: Session], current: String?) {
        var next: [String: (state: SessionState, pinned: Bool)] = [:]
        next.reserveCapacity(sessions.count)
        let tabbed = Set(entries.map(\.sessionId))
        var finished: [String] = []
        var pinnedNow: [String] = []
        var unpinned: Set<String> = []
        for (id, session) in sessions {
            let pinned = session.pinnedAt != nil
            next[id] = (session.state, pinned)
            guard let before = seen[id], tabbed.contains(id) else { continue }
            if id != current, before.state.isActive, session.state == .idle { finished.append(id) }
            if before.pinned && !pinned { unpinned.insert(id) } else if !before.pinned && pinned { pinnedNow.append(id) }
        }
        seen = next
        // A pinned conversation is one the reader keeps.
        for id in pinnedNow { keep(id) }
        unread.formUnion(finished)
        // An unpinned one returns to the front of the normal zone, where it is easy to find.
        if !unpinned.isEmpty {
            entries = entries.filter { unpinned.contains($0.sessionId) } + entries.filter { !unpinned.contains($0.sessionId) }
        }
    }

    /// Makes sure [id] has a tab, a preview unless [keep] or the open mode keeps every one, and marks it read.
    private func select(_ id: String, keep wanted: Bool) {
        guard let session = session(id), session.archivedAt == nil else { return }
        let keep = wanted || openMode == .keep
        unread.remove(id)
        anchor = id
        if let at = entries.firstIndex(where: { $0.sessionId == id }) {
            if keep, entries[at].preview { entries[at].preview = false }
            return
        }
        let entry = SessionTabEntry(sessionId: id, preview: !keep)
        if !keep, let preview = entries.firstIndex(where: \.preview) {
            entries[preview] = entry
        } else {
            insertNormal(entry, at: nil)
        }
        trim(keeping: id)
    }

    /// Opening one more than the limit drops the oldest.
    private func trim(keeping id: String) {
        let excess = entries.count - Self.tabLimit
        guard excess > 0 else { return }
        var dropped = 0
        entries = entries.filter { entry in
            guard dropped < excess, entry.sessionId != id else { return true }
            dropped += 1
            return false
        }
    }

    /// Puts [entry] in the normal zone at [position], by default after the conversation last read.
    private func insertNormal(_ entry: SessionTabEntry, at position: Int?) {
        let zones = self.zones
        let position = position ?? {
            if let at = zones.normal.firstIndex(where: { $0.id == anchor }) { return at + 1 }
            return zones.pinned.contains { $0.id == anchor } ? 0 : zones.normal.count
        }()
        let before = position < zones.normal.count ? entries.firstIndex { $0.sessionId == zones.normal[position].id } : nil
        entries.insert(entry, at: before ?? entries.count)
    }

    // MARK: Opening

    /// The conversation Riffet itself just created or launched: its tab is kept as it opens.
    func launched(_ id: String) {
        launchedSession = (id, .now)
    }

    private func takeLaunched(_ id: String) -> Bool {
        guard let launchedSession, launchedSession.id == id else { return false }
        self.launchedSession = nil
        return Date.now.timeIntervalSince(launchedSession.at) < Self.launchWindow
    }

    /// The reader sent a message in [id]: a preview tab becomes a kept one (unless tabs are added by hand).
    func sent(_ id: String) {
        if openMode == .preview { keep(id) }
    }

    /// Makes a preview tab a kept one.
    func keep(_ id: String) {
        guard let at = entries.firstIndex(where: { $0.sessionId == id && $0.preview }) else { return }
        entries[at].preview = false
    }

    /// 加入标签栏: a kept tab for [id], without opening it.
    func add(_ id: String) {
        guard let session = session(id), session.archivedAt == nil else { return }
        if hasTab(id) { keep(id); return }
        insertNormal(SessionTabEntry(sessionId: id, preview: false), at: nil)
        trim(keeping: current ?? id)
    }

    /// Shows [id], as a click on its tab does.
    func activate(_ id: String, clicked: Bool = true) {
        workbench?.sidebar.pick(id, clicked: clicked)
    }

    // MARK: Closing

    private func remove(_ ids: Set<String>) {
        entries.removeAll { ids.contains($0.sessionId) }
        unread.subtract(ids)
    }

    private func remember(_ ids: [String], in zones: (pinned: [SessionTabItem], normal: [SessionTabItem])) {
        for id in ids {
            closed.append((id, max(0, zones.normal.firstIndex { $0.id == id } ?? 0)))
        }
        if closed.count > Self.closedLimit { closed.removeFirst(closed.count - Self.closedLimit) }
    }

    /// Closing the tab on screen opens its neighbour, or the home page after the last one.
    func close(_ id: String) {
        let zones = self.zones
        let order = (zones.pinned + zones.normal).map(\.id)
        guard let at = order.firstIndex(of: id) else { remove([id]); return }
        remember([id], in: zones)
        remove([id])
        guard id == current else { return }
        let rest = order.filter { $0 != id }
        if rest.isEmpty {
            workbench?.showHome()
        } else {
            activate(rest[min(at, rest.count - 1)])
        }
    }

    /// Closes the tab on screen; false when no tab is.
    func closeCurrent() -> Bool {
        guard let current, hasTab(current) else { return false }
        close(current)
        return true
    }

    /// The normal tabs other than [id]'s; pinned tabs stay, as in a browser.
    func othersToClose(_ id: String) -> [String] {
        zones.normal.map(\.id).filter { $0 != id }
    }

    func rightToClose(_ id: String) -> [String] {
        let zones = self.zones
        let order = zones.pinned + zones.normal
        guard let at = order.firstIndex(where: { $0.id == id }) else { return [] }
        return order[(at + 1)...].filter { !$0.pinned }.map(\.id)
    }

    func closeOthers(_ id: String) {
        let ids = othersToClose(id)
        remember(ids, in: zones)
        remove(Set(ids))
        activate(id)
    }

    func closeRight(_ id: String) {
        let ids = rightToClose(id)
        guard !ids.isEmpty else { return }
        remember(ids, in: zones)
        remove(Set(ids))
        if let current, ids.contains(current) { activate(id) }
    }

    /// Reopens the last closed tab at the place it had.
    func reopen() {
        while let last = closed.popLast() {
            guard let session = session(last.sessionId), session.archivedAt == nil else { continue }
            if !hasTab(last.sessionId) {
                insertNormal(SessionTabEntry(sessionId: last.sessionId, preview: false), at: min(last.index, zones.normal.count))
            }
            activate(last.sessionId, clicked: false)
            return
        }
    }

    // MARK: Moving

    /// The tab [delta] places from the current one, wrapping; from the home or a page, the first or last.
    func step(_ delta: Int) {
        let zones = self.zones
        let order = (zones.pinned + zones.normal).map(\.id)
        guard !order.isEmpty else { return }
        let at = current.flatMap { order.firstIndex(of: $0) }
        let target = at.map { ($0 + delta + order.count) % order.count } ?? (delta > 0 ? 0 : order.count - 1)
        activate(order[target], clicked: false)
    }

    /// 1–8 are the nth tab; 9 is the last.
    func goTo(_ position: Int) {
        let zones = self.zones
        let order = (zones.pinned + zones.normal).map(\.id)
        let id = position >= 9 ? order.last : (order.indices.contains(position - 1) ? order[position - 1] : nil)
        if let id { activate(id, clicked: false) }
    }

    var commands: SessionTabCommands {
        SessionTabCommands(goTo: { [self] in goTo($0) }, step: { [self] in step($0) }, closeCurrent: { [self] in closeCurrent() }, reopen: { [self] in reopen() })
    }
}

/// The list's conversations by id, rebuilt only when the list itself is replaced.
@MainActor
final class SessionIndex {
    private var source: ObjectIdentifier?
    private var byId: [String: Session] = [:]

    func sessions(_ list: SessionListState) -> [String: Session] {
        let key = ObjectIdentifier(list)
        if key != source {
            source = key
            byId = Dictionary(list.sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
        return byId
    }
}
