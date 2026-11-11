import Foundation
import Observation
import RiffetKit

enum ExtensionStatusFilter: String, CaseIterable {
    case all, attention, enabled, disabled, unknown

    var label: String {
        switch self {
        case .all: String(localized: "全部状态")
        case .attention: String(localized: "需处理")
        case .enabled: String(localized: "已启用")
        case .disabled: String(localized: "已停用")
        case .unknown: String(localized: "未声明")
        }
    }
}

enum ExtensionOriginFilter: String, CaseIterable {
    case all, own, plugin

    var label: String {
        switch self {
        case .all: String(localized: "全部来源")
        case .own: String(localized: "独立配置")
        case .plugin: String(localized: "插件提供")
        }
    }
}

enum ExtensionSort: String, CaseIterable {
    case standard, name, kind

    var label: String {
        switch self {
        case .standard: String(localized: "默认排序")
        case .name: String(localized: "名称 A–Z")
        case .kind: String(localized: "按类型")
        }
    }
}

/// The catalog's filters (web `ExtensionsPage`). A filter that is not set matches everything.
struct ExtensionFilters: Equatable {
    var query = ""
    var backend: NativeBackendId?
    var profileKey: String?
    var kind: String? = "skill"
    var scope: String?
    var origin = ExtensionOriginFilter.all
    var status = ExtensionStatusFilter.all
    var sort = ExtensionSort.standard

    /// Filters behind the popover; search, kind and sorting have their own controls.
    var activeCount: Int {
        (scope == nil ? 0 : 1) + (origin == .all ? 0 : 1) + (status == .all ? 0 : 1)
    }
}

/// What a catalog row shows. Equatable so a list update only rebuilds the rows whose text changed.
struct ExtensionRow: Identifiable, Equatable {
    let id: String
    let name: String
    let subtitle: String
    let kind: String
    let agent: String
    let profile: String
    let source: String
    let scopeAndKind: String
    let scope: String
    let skillSource: String?
    let readOnlyReason: String?
    let canDelete: Bool
    let status: ExtensionStatus
}

/// Counts of the scanned entries (not usage): what the overview draws.
struct ExtensionStats: Equatable {
    var total = 0
    var kinds: [String: Int] = [:]
    var backends: [NativeBackendId: Int] = [:]
    var enabled = 0
    var disabled = 0
    var unknown = 0
}

struct ExtensionCreation {
    let context: ExtensionContext
    let profileName: String
    let targets: [ExtensionCreateTarget]
}

/// An action's outcome for the pane that started it.
struct ExtensionActionReport {
    var success: Bool
    var text: String
    var authorizationURL: URL?
    var details: String?
}

/// A batch the reader still has to confirm: Skill manifests were read first, so a failed read
/// leaves everything untouched.
struct ExtensionBatchPlan {
    let enable: Bool
    let requests: [(entry: ExtensionEntry, request: ExtensionActionRequest)]
    let skipped: Int
    let title: String
    let message: String
}

/// The outcome banner of a batch or an action.
struct ExtensionBanner: Equatable {
    let success: Bool
    let title: String
    let text: String
}

struct ExtensionBatchSummary: Equatable {
    var selected = 0
    var enable = 0
    var disable = 0
}

/// The aggregated catalog of every Agent profile for one project: loading, filtering, selection,
/// batch actions. Per-item reading and editing stay in the inspector.
@MainActor
@Observable
final class ExtensionsStore {
    private(set) var sources: [ExtensionSource] = []
    /// Every row the filters leave; the catalog shows `pagedRows`.
    private(set) var rows: [ExtensionRow] = []
    /// The catalog's current page, from 1, and its rows.
    private(set) var page = 1
    private(set) var pagedRows: [ExtensionRow] = []
    private(set) var stats = ExtensionStats()
    private(set) var kindCounts: [String: Int] = [:]
    private(set) var attentionCount = 0
    private(set) var filters = ExtensionFilters()
    private(set) var checked: Set<String> = []
    private(set) var batch = ExtensionBatchSummary()
    private(set) var runtime: [String: ExtensionRuntimeReport] = [:]
    private(set) var selectedKey: String?
    private(set) var creation: ExtensionCreation?
    private(set) var operationBusy = false
    private(set) var batchProgress: (done: Int, total: Int)?
    var banner: ExtensionBanner?
    var error: String?
    /// Set by the inspector: an unsaved draft, or a save in flight.
    var dirty = false
    var editorBusy = false

    @ObservationIgnored private var api: RiffetApi?
    @ObservationIgnored private var projectId: String?
    @ObservationIgnored private var projectName: String?
    @ObservationIgnored private var serverURL: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var entriesBySource: [String: [ExtensionEntry]] = [:]
    @ObservationIgnored private var entries: [ExtensionEntry] = []
    @ObservationIgnored private var entriesByKey: [String: ExtensionEntry] = [:]
    @ObservationIgnored private var filtered: [ExtensionEntry] = []
    @ObservationIgnored private var selectedSnapshot: ExtensionEntry?
    @ObservationIgnored private var fetchedAt: [String: Date] = [:]
    @ObservationIgnored private var capabilityCheckedAt: [String: Date] = [:]
    @ObservationIgnored private var capabilityInFlight: Set<String> = []
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    /// The derived lists are rebuilt once for the inventories that arrived together, not per source.
    @ObservationIgnored private var rebuildTask: Task<Void, Never>?
    /// Sources re-read in the background while their last inventory stays on screen: no spinner.
    private var quietKeys: Set<String> = []

    static let pageSize = 20
    private static let inventoryTTL: TimeInterval = 30
    private static let capabilityTTL: TimeInterval = 60
    private static let concurrency = 3

    /// A read the reader is waiting for: a source not read yet, or one they asked to read again.
    var loading: Bool {
        currentSource.map { $0.loading && !quietKeys.contains($0.key) } ?? false
    }
    var pageCount: Int { max(1, (rows.count + Self.pageSize - 1) / Self.pageSize) }
    var busy: Bool { operationBusy || editorBusy }
    /// Exactly one native profile belongs to each Agent in the catalog.
    var currentSource: ExtensionSource? { sources.first { $0.backendId == filters.backend } }
    var failedSources: [ExtensionSource] { currentSource.map { $0.error == nil ? [] : [$0] } ?? [] }

    /// Read failures and the diagnostics each directory reported, one line each.
    var diagnosticLines: [String] {
        [currentSource].compactMap { $0 }.flatMap { source in
            ([source.error] + (source.inventory?.diagnostics ?? []).map { Optional($0) })
                .compactMap { $0 }.map { String(localized: "\(backendTitle(source.backendId))：\($0)") }
        }
    }
    var readableSourceCount: Int { currentSource?.inventory == nil ? 0 : 1 }

    /// The selected entry; once a refresh drops it, the last known copy stays (flagged by `selectedMissing`).
    var selected: ExtensionEntry? {
        guard let selectedKey else { return nil }
        return entriesByKey[selectedKey] ?? (selectedSnapshot?.key == selectedKey ? selectedSnapshot : nil)
    }

    var selectedMissing: Bool { selectedKey.map { entriesByKey[$0] == nil } ?? false }

    func source(_ key: String) -> ExtensionSource? { sources.first { $0.key == key } }
    func entry(_ key: String) -> ExtensionEntry? { entriesByKey[key] }

    /// Source keys whose management capabilities the page currently needs.
    var neededCapabilityKeys: [String] {
        var keys: [String] = currentSource.map { [$0.key] } ?? []
        if let selected { keys.append(selected.sourceKey) }
        keys.append(contentsOf: checkedSourceKeys)
        return Array(Set(keys)).sorted()
    }

    @ObservationIgnored private var checkedSourceKeys: Set<String> = []

    // MARK: Configuration and loading

    /// Applies the Agent profiles and project to read. Sources that survive keep their loaded data.
    func configure(api: RiffetApi?, backends: [NativeBackendCatalogEntry], projectId: String?, projectName: String?) {
        // Another server's inventories share the source keys but none of the data.
        let serverChanged = api?.baseUrl != serverURL
        let projectChanged = self.projectId != projectId || serverChanged
        var next = extensionSourceDescriptors(backends: backends, projectId: projectId)
        // A revisit with the same profiles keeps everything as it is.
        if !projectChanged, projectName == self.projectName,
           next.map(\.key) == sources.map(\.key), next.map(\.profileName) == sources.map(\.profileName) {
            self.api = api
            return
        }
        self.api = api
        serverURL = api?.baseUrl
        self.projectId = projectId
        self.projectName = projectName
        if serverChanged {
            sources = []
            fetchedAt = [:]
            capabilityCheckedAt = [:]
            entriesBySource = [:]
        }
        let previous = Dictionary(sources.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        for index in next.indices {
            guard let old = previous[next[index].key] else { continue }
            next[index].inventory = old.inventory
            next[index].capabilities = old.capabilities
            next[index].capabilityError = old.capabilityError
            next[index].error = old.error
            next[index].loading = old.loading
        }
        let retained = Set(next.map(\.key))
        fetchedAt = fetchedAt.filter { retained.contains($0.key) }
        capabilityCheckedAt = capabilityCheckedAt.filter { retained.contains($0.key) }
        entriesBySource = entriesBySource.filter { retained.contains($0.key) }
        sources = next
        if projectChanged {
            runtime = [:]
            banner = nil
            error = nil
            filters.profileKey = nil
            checked = []
            page = 1
            generation += 1
            for index in sources.indices { sources[index].loading = false }
        }
        normalizeSelection()
        for source in sources where entriesBySource[source.key] == nil && source.inventory != nil {
            entriesBySource[source.key] = extensionEntries(for: source, projectName: projectName)
        }
        rebuild()
    }

    /// Reads the sources that are missing or older than 30 seconds (all of them when forced). An
    /// unforced read of a source already shown happens in the background.
    func loadAll(force: Bool) async {
        let now = Date()
        let stale = sources.filter { source in
            force || fetchedAt[source.key].map { now.timeIntervalSince($0) >= Self.inventoryTTL } ?? true
        }
        await load(stale.map(\.key), quiet: force ? [] : Set(stale.filter { $0.inventory != nil }.map(\.key)))
    }

    /// Reads the given sources at most three at a time; each reports its own error.
    func load(_ keys: [String], quiet: Set<String> = []) async {
        guard let api, !keys.isEmpty else { return }
        let epoch = generation
        let contexts = keys.compactMap { key in source(key).map { (key, $0.context) } }
        let nextQuiet = quietKeys.subtracting(keys).union(quiet)
        if nextQuiet != quietKeys { quietKeys = nextQuiet }
        for (key, _) in contexts where source(key)?.loading != true { update(key) { $0.loading = true } }
        // A few workers on the main actor take the next source in turn. Not a task group: one here
        // crashed the app as the page opened (a child finishing into a group that was already gone,
        // `TaskGroup::offer` on a destroyed group).
        let queue = SourceQueue(contexts)
        let workers = (0..<min(Self.concurrency, contexts.count)).map { _ in
            Task { @MainActor in
                while !Task.isCancelled, let (key, context) = queue.take() {
                    let result: Result<ExtensionInventory, Error>
                    do { result = .success(try await api.extensions(context: context)) }
                    catch { result = .failure(error) }
                    await accept(key, result, epoch: epoch)
                }
            }
        }
        await withTaskCancellationHandler {
            for worker in workers { await worker.value }
        } onCancel: {
            for worker in workers { worker.cancel() }
        }
        // A read stopped by cancellation or a newer context must not leave a spinner behind.
        if epoch == generation {
            for (key, _) in contexts where source(key)?.loading == true { update(key) { $0.loading = false } }
        }
        flushRebuild()
    }

    /// Takes one source's answer. An inventory that did not change leaves the derived lists alone; a
    /// new one has its entries built off the main thread and joins the next coalesced rebuild.
    private func accept(_ key: String, _ result: Result<ExtensionInventory, Error>, epoch: Int) async {
        guard epoch == generation, !Task.isCancelled else { return }
        switch result {
        case let .success(inventory):
            guard var next = source(key) else { return }
            if next.inventory == inventory, entriesBySource[key] != nil {
                fetchedAt[key] = Date()
                if next.error != nil || next.loading { update(key) { $0.error = nil; $0.loading = false } }
                return
            }
            next.inventory = inventory
            let projectName = self.projectName
            let built = await Task.detached(priority: .userInitiated) { extensionEntries(for: next, projectName: projectName) }.value
            guard epoch == generation, !Task.isCancelled else { return }
            fetchedAt[key] = Date()
            update(key) {
                $0.inventory = inventory
                $0.error = nil
                $0.loading = false
            }
            entriesBySource[key] = built
        case let .failure(failure):
            // A cancelled read is not a failed source.
            if Task.isCancelled || failure is CancellationError {
                update(key) { $0.loading = false }
            } else {
                update(key) {
                    $0.error = failure.riffetMessage
                    $0.loading = false
                }
            }
        }
        scheduleRebuild()
    }

    /// The first inventory is drawn at once; later ones within a short window are folded into one
    /// rebuild.
    private func scheduleRebuild() {
        guard rebuildTask == nil else { return }
        let delay: Duration = entries.isEmpty ? .zero : .milliseconds(120)
        rebuildTask = Task { @MainActor [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard let self, self.rebuildTask != nil else { return }
            self.rebuildTask = nil
            self.rebuild()
        }
    }

    /// Runs a pending rebuild now (the end of a load).
    private func flushRebuild() {
        guard rebuildTask != nil else { return }
        rebuildTask?.cancel()
        rebuildTask = nil
        rebuild()
    }

    /// A manual refresh: capabilities and every inventory are read again.
    func refresh() {
        guard !operationBusy else { return }
        refreshTask?.cancel()
        if !quietKeys.isEmpty { quietKeys = [] }
        for key in capabilityCheckedAt.keys { capabilityCheckedAt[key] = nil }
        for index in sources.indices {
            sources[index].capabilities = nil
            sources[index].capabilityError = nil
        }
        recomputeBatch()
        refreshTask = Task {
            await loadAll(force: true)
            guard !Task.isCancelled else { return }
            await ensureCapabilities(neededCapabilityKeys)
        }
    }

    func retry(_ key: String) {
        guard !operationBusy else { return }
        Task { await load([key]) }
    }

    /// The page went away: reads in flight are dropped; what was read stays for the next visit.
    func stop() {
        refreshTask?.cancel()
        generation += 1
        for index in sources.indices where sources[index].loading { sources[index].loading = false }
        if !quietKeys.isEmpty { quietKeys = [] }
        flushRebuild()
    }

    func ensureCapabilities(_ keys: [String]) async {
        guard let api else { return }
        for key in keys {
            guard let source = source(key), !capabilityInFlight.contains(key) else { continue }
            // Failures are cached for the same minute: an unsupported source must not retry on every render.
            if let checked = capabilityCheckedAt[key], Date().timeIntervalSince(checked) < Self.capabilityTTL { continue }
            let epoch = generation
            capabilityInFlight.insert(key)
            defer { capabilityInFlight.remove(key) }
            do {
                let capabilities = try await api.extensionCapabilities(context: source.context)
                guard epoch == generation, !Task.isCancelled else { return }
                update(key) {
                    $0.capabilities = capabilities
                    $0.capabilityError = nil
                }
            } catch {
                guard epoch == generation, !Task.isCancelled else { return }
                update(key) {
                    $0.capabilities = nil
                    $0.capabilityError = error.riffetMessage
                }
            }
            capabilityCheckedAt[key] = Date()
            refilter()
        }
    }

    func checkRuntime(_ context: ExtensionContext) async {
        guard let api, !operationBusy, !editorBusy, !dirty else { return }
        operationBusy = true
        error = nil
        defer { operationBusy = false }
        do {
            let report = try await api.extensionRuntime(context: context)
            runtime[extensionContextKey(context)] = report
            refilter()
        } catch {
            self.error = error.riffetMessage
        }
    }

    // MARK: Filters and selection

    func setFilters(_ change: (inout ExtensionFilters) -> Void) {
        let before = filters
        change(&filters)
        normalizeSelection()
        guard filters != before else { return }
        // A selection made under other filters is dropped, like the web page.
        checked = []
        page = 1
        refilter()
    }

    func selectBackend(_ backend: NativeBackendId) {
        setFilters { $0.backend = backend }
    }

    func selectKind(_ kind: String) {
        setFilters { $0.kind = kind }
    }

    private func normalizeSelection() {
        if !sources.contains(where: { $0.backendId == filters.backend }) {
            filters.backend = sources.first?.backendId
        }
        filters.profileKey = currentSource?.key
        if filters.kind == nil { filters.kind = "skill" }
    }

    func setPage(_ next: Int) {
        let clamped = min(max(next, 1), pageCount)
        guard clamped != page else { return }
        page = clamped
        checked = []
        updatePage()
        recomputeBatch()
    }

    func resetFilters() {
        setFilters {
            $0.query = ""
            $0.scope = nil
            $0.origin = .all
            $0.status = .all
            $0.sort = .standard
        }
    }

    func toggleChecked(_ key: String) {
        guard pagedRows.contains(where: { $0.id == key }) else { return }
        if checked.contains(key) { checked.remove(key) } else { checked.insert(key) }
        recomputeBatch()
    }

    func setAllChecked(_ value: Bool) {
        checked = value ? Set(pagedRows.map(\.id)) : []
        recomputeBatch()
    }

    func clearChecked() {
        guard !checked.isEmpty else { return }
        checked = []
        recomputeBatch()
    }

    var allChecked: Bool { !pagedRows.isEmpty && Set(pagedRows.map(\.id)).isSubset(of: checked) }

    func open(_ key: String) {
        guard let entry = entriesByKey[key] else {
            error = String(localized: "目录中未找到此扩展，请刷新后重试。")
            return
        }
        selectedSnapshot = entry
        selectedKey = key
        creation = nil
        error = nil
    }

    func closeInspector() {
        selectedKey = nil
        selectedSnapshot = nil
        creation = nil
        dirty = false
    }

    func beginCreate(_ sourceKey: String) {
        guard let source = currentSource, source.key == sourceKey,
              let targets = source.inventory?.createTargets.filter({ $0.kind == filters.kind }), !targets.isEmpty else {
            error = String(localized: "当前配置没有可新建的位置。")
            return
        }
        selectedKey = nil
        selectedSnapshot = nil
        creation = ExtensionCreation(context: source.context, profileName: source.profileName, targets: targets)
        error = nil
    }

    var creatableSources: [ExtensionSource] {
        guard let source = currentSource,
              source.inventory?.createTargets.contains(where: { $0.kind == filters.kind }) == true else { return [] }
        return [source]
    }

    /// Moves to a filter combination from the overview (web `browse`).
    func browse(kind: String? = nil, backend: NativeBackendId? = nil, status: ExtensionStatusFilter = .all) {
        checked = []
        page = 1
        filters = ExtensionFilters(kind: kind)
        filters.backend = backend
        filters.status = status
        normalizeSelection()
        refilter()
    }

    // MARK: Actions

    /// One action on an item (or a profile, for install, reload and an MCP login).
    func run(context: ExtensionContext, item: ExtensionItem?, action: String, target: String? = nil, scope: String? = nil) async -> ExtensionActionReport {
        guard let api else { return ExtensionActionReport(success: false, text: String(localized: "尚未连接服务器。")) }
        guard !operationBusy, !editorBusy, !dirty else { return ExtensionActionReport(success: false, text: String(localized: "正在处理，请稍候。")) }
        operationBusy = true
        error = nil
        defer { operationBusy = false }
        var attempted = false
        do {
            var hash: String?
            if let item { hash = try await ExtensionOps.skillManifestHash(api: api, context: context, item: item) }
            let request = ExtensionOps.request(action: action, item: target == nil ? item : nil, target: target, scope: scope ?? ExtensionOps.itemScope(item), expectedHash: hash)
            attempted = true
            let result = try await api.extensionAction(context: context, input: request)
            // Even a command that fails may have written part of its configuration.
            await changed([extensionContextKey(context)])
            var text = ExtensionOps.summary(result)
            var url: URL?
            if result.success, let link = ExtensionOps.authorizationURL(result) {
                url = link
                text = String(localized: "已生成授权链接，需在服务器所在的电脑上完成认证。")
            }
            return ExtensionActionReport(success: result.success, text: result.success ? text : String(localized: "操作失败，配置可能已部分修改。"), authorizationURL: url, details: result.success ? nil : text)
        } catch {
            if attempted {
                // The outcome is unknown: read the directory again and never retry the write.
                await changed([extensionContextKey(context)])
                return ExtensionActionReport(success: false, text: String(localized: "操作结果未确认，配置可能已部分修改，请核对后再操作。"), details: error.riffetMessage)
            }
            return ExtensionActionReport(success: false, text: String(localized: "操作失败"), details: error.riffetMessage)
        }
    }

    /// Reads every selected Skill's manifest, then describes the batch for confirmation.
    func prepareBatch(enable: Bool) async -> ExtensionBatchPlan? {
        guard let api, !operationBusy, !editorBusy, !dirty else { return nil }
        let action = enable ? "enable" : "disable"
        let checkedEntries = checked.compactMap { entriesByKey[$0] }
        let targets = checkedEntries.filter { entry in
            let actions = ExtensionRules.actions(for: entry.item, capabilities: source(entry.sourceKey)?.capabilities)
            guard actions.contains(action) else { return false }
            return enable ? entry.item.enabled?.boolValue != true : entry.item.enabled?.boolValue != false
        }.sorted { $0.key < $1.key }
        guard !targets.isEmpty else { return nil }
        operationBusy = true
        error = nil
        defer { operationBusy = false }
        do {
            var requests: [(entry: ExtensionEntry, request: ExtensionActionRequest)] = []
            for entry in targets {
                let hash = try await ExtensionOps.skillManifestHash(api: api, context: entry.context, item: entry.item)
                requests.append((entry, ExtensionOps.request(action: action, item: entry.item, target: nil, scope: nil, expectedHash: hash)))
            }
            let contexts = Set(targets.map { backendTitle($0.backendId) }).sorted()
            var notes = [String(localized: "\(contexts.joined(separator: String(localized: "、")))。")]
            if targets.contains(where: { $0.item.kind == "skill" }) { notes.append(String(localized: "技能开关写入当前 Agent 配置，其他项目也可能受影响。")) }
            let skipped = checkedEntries.count - targets.count
            if skipped > 0 { notes.append(String(localized: "\(skipped) 项不支持此操作或无需变更，将跳过。")) }
            notes.append(String(localized: "现有会话的生效时机由原生 Agent 决定。"))
            return ExtensionBatchPlan(
                enable: enable,
                requests: requests,
                skipped: skipped,
                title: String(localized: "\(enable ? String(localized: "启用") : String(localized: "停用")) \(targets.count) 个扩展？"),
                message: notes.joined(separator: "\n")
            )
        } catch {
            self.error = String(localized: "无法确认扩展版本，未执行批量操作：\(error.riffetMessage)")
            return nil
        }
    }

    /// Native configuration locks are profile wide: writes run one at a time and are never retried.
    func runBatch(_ plan: ExtensionBatchPlan) async {
        guard let api, !operationBusy else { return }
        operationBusy = true
        error = nil
        defer {
            operationBusy = false
            batchProgress = nil
        }
        var failures: [String] = []
        var effects: [String] = []
        var successes = 0
        var contexts: [String] = []
        for (index, item) in plan.requests.enumerated() {
            batchProgress = (index, plan.requests.count)
            let label = item.entry.item.name
            let contextKey = extensionContextKey(item.entry.context)
            if !contexts.contains(contextKey) { contexts.append(contextKey) }
            do {
                let result = try await api.extensionAction(context: item.entry.context, input: item.request)
                if result.success {
                    successes += 1
                    if !result.applyEffect.isEmpty, !effects.contains(result.applyEffect) { effects.append(result.applyEffect) }
                } else {
                    failures.append(String(localized: "\(label)：\(result.output ?? result.diagnostics?.joined(separator: " ") ?? (result.applyEffect.isEmpty ? String(localized: "操作未完成") : result.applyEffect))"))
                }
            } catch {
                failures.append(String(localized: "\(label)：\(error.riffetMessage)"))
            }
        }
        banner = ExtensionBanner(
            success: failures.isEmpty,
            title: failures.isEmpty ? String(localized: "\(successes) 项已\(plan.enable ? String(localized: "启用") : String(localized: "停用"))") : String(localized: "\(successes) 项完成，\(failures.count) 项失败"),
            text: (failures + effects).joined(separator: "\n")
        )
        checked = []
        recomputeBatch()
        await changed(contexts)
    }

    /// The files changed: slash caches and the runtime reports are stale, and the affected sources are read again.
    func changed(_ contextKeys: [String]) async {
        for key in contextKeys { runtime[key] = nil }
        for key in contextKeys { capabilityCheckedAt[key] = nil }
        refilter()
        await load(contextKeys.filter { source($0) != nil })
    }

    // MARK: Derived data

    private func update(_ key: String, _ change: (inout ExtensionSource) -> Void) {
        guard let index = sources.firstIndex(where: { $0.key == key }) else { return }
        change(&sources[index])
    }

    private func rebuild() {
        if rebuildTask != nil {
            rebuildTask?.cancel()
            rebuildTask = nil
        }
        entries = sources.flatMap { entriesBySource[$0.key] ?? [] }
        entriesByKey = Dictionary(entries.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        var next = ExtensionStats()
        next.total = entries.count
        for entry in entries {
            next.kinds[entry.kind, default: 0] += 1
            next.backends[entry.backendId, default: 0] += 1
            switch entry.enabled {
            case true?: next.enabled += 1
            case false?: next.disabled += 1
            default: next.unknown += 1
            }
        }
        if next != stats { stats = next }
        let kept = checked.intersection(entriesByKey.keys)
        if kept != checked { checked = kept }
        refilter()
    }

    private func status(of entry: ExtensionEntry) -> ExtensionStatus {
        // A source's key is its context key. Without a runtime report the status follows the
        // configured state alone (`ExtensionRules.status` with no runtime entries).
        guard !runtime.isEmpty, let report = runtime[entry.sourceKey] else {
            switch entry.enabled {
            case false?: return .disabled
            case true?: return .enabled
            case nil: return .discovered
            }
        }
        return ExtensionRules.status(for: entry.item, runtime: ExtensionRules.runtimeEntries(for: entry.item, ambiguousNativeId: entry.ambiguousNativeId, report: report))
    }

    private func refilter() {
        let filters = self.filters
        let words = filters.query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        var counts: [String: Int] = [:]
        var attention = 0
        var matched: [(entry: ExtensionEntry, status: ExtensionStatus)] = []
        for entry in entries {
            if let backend = filters.backend, entry.backendId != backend { continue }
            if let profile = filters.profileKey, entry.sourceKey != profile { continue }
            if let scope = filters.scope, entry.scope != scope { continue }
            switch filters.origin {
            case .all: break
            case .own: if entry.fromPlugin { continue }
            case .plugin: if !entry.fromPlugin { continue }
            }
            let status = status(of: entry)
            counts[entry.kind, default: 0] += 1
            if status == .attention { attention += 1 }
            if let kind = filters.kind, entry.kind != kind { continue }
            if !words.allSatisfy({ entry.search.contains($0) }) { continue }
            switch filters.status {
            case .all: break
            case .enabled: if entry.enabled != true { continue }
            case .disabled: if entry.enabled != false { continue }
            case .unknown: if entry.enabled != nil { continue }
            case .attention: if status != .attention { continue }
            }
            matched.append((entry, status))
        }
        switch filters.sort {
        case .standard: break
        case .name:
            matched.sort { $0.entry.name.localizedStandardCompare($1.entry.name) == .orderedAscending }
        case .kind:
            let order = Dictionary(ExtensionText.kindOrder.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
            let last = order.count
            matched.sort {
                let left = order[$0.entry.kind] ?? last
                let right = order[$1.entry.kind] ?? last
                return left != right ? left < right : $0.entry.name.localizedStandardCompare($1.entry.name) == .orderedAscending
            }
        }
        filtered = matched.map(\.entry)
        let nextRows = matched.map { match in
            let entry = match.entry
            return ExtensionRow(
                id: entry.key,
                name: entry.name,
                subtitle: entry.subtitle,
                kind: entry.kind,
                agent: entry.agent,
                profile: entry.profileName,
                source: entry.sourceLabel,
                scopeAndKind: entry.scopeAndKind,
                scope: entry.scope,
                skillSource: entry.kind != "skill" ? nil : entry.item.ownerPluginId != nil ? String(localized: "插件提供")
                    : entry.scope == "builtin" ? String(localized: "内置") : entry.scope == "project" ? String(localized: "项目级") : nil,
                readOnlyReason: entry.kind == "skill" ? entry.item.readOnlyReason : nil,
                canDelete: entry.kind == "skill" && ExtensionRules.actions(
                    for: entry.item,
                    capabilities: source(entry.sourceKey)?.capabilities,
                    inventoryFailed: source(entry.sourceKey)?.error != nil
                ).contains("uninstall"),
                status: match.status
            )
        }
        if nextRows != rows { rows = nextRows }
        updatePage()
        if counts != kindCounts { kindCounts = counts }
        if attention != attentionCount { attentionCount = attention }
        recomputeBatch()
    }

    /// Keeps the page inside the rows (a refresh can shrink them) and slices it once, not per `body`.
    private func updatePage() {
        let clamped = min(max(page, 1), pageCount)
        if clamped != page { page = clamped }
        let start = (clamped - 1) * Self.pageSize
        let next = Array(rows[min(start, rows.count)..<min(start + Self.pageSize, rows.count)])
        if next != pagedRows { pagedRows = next }
        let retained = checked.intersection(next.map(\.id))
        if retained != checked { checked = retained }
    }

    private func recomputeBatch() {
        var next = ExtensionBatchSummary()
        var keys: Set<String> = []
        for key in checked {
            guard let entry = entriesByKey[key] else { continue }
            next.selected += 1
            keys.insert(entry.sourceKey)
            let actions = ExtensionRules.actions(for: entry.item, capabilities: source(entry.sourceKey)?.capabilities)
            if actions.contains("enable"), entry.enabled != true { next.enable += 1 }
            if actions.contains("disable"), entry.enabled != false { next.disable += 1 }
        }
        checkedSourceKeys = keys
        if next != batch { batch = next }
    }
}

/// The sources one `load` still has to read, handed out one at a time to its workers.
@MainActor
private final class SourceQueue {
    private var pending: ArraySlice<(String, ExtensionContext)>

    init(_ contexts: [(String, ExtensionContext)]) { pending = contexts[...] }

    func take() -> (String, ExtensionContext)? { pending.popFirst() }
}
