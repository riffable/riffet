import SwiftUI
import RiffetKit

// The 个人助理 tab (docs/ASSISTANT.md §3): the main conversation once it exists, else the new-session
// composer in the assistant's project with 记忆 / 规则 / 能力 under it.

extension Workbench {
    /// The server-owned project the assistant's conversations live in.
    var assistantProject: Project? { AssistantKt.assistantProject(projects: list.projects) }
    /// The one long conversation; a `mainSessionId` naming an archived or deleted session counts as none.
    var assistantMain: Session? { AssistantKt.assistantMain(project: assistantProject, sessions: list.sessions) }
}

/// Memory, rules and delegations as their pages read them; one per tab, read when the tab shows.
@MainActor @Observable
final class AssistantSetup {
    var instructions: AssistantInstructions?
    var memory: AssistantMemory?
    var memoryFailed = false
    var delegations: [AssistantDelegation]?
    /// The capability packs (docs/ASSISTANT.md §8.2); the installed ones with an entry show above the composer.
    var packs: [AssistantPack] = []

    /// Adds or removes a pack; throws what the server says.
    func setPack(_ api: RiffetApi, id: String, on: Bool) async throws {
        packs = on ? try await api.addAssistantPack(id: id) : try await api.removeAssistantPack(id: id)
    }

    func refresh(_ api: RiffetApi?) async {
        guard let api else { return }
        async let rules = try? api.assistantInstructions()
        async let notes = try? api.assistantMemory()
        async let follows = try? api.assistantDelegations()
        async let offered = try? api.assistantPacks()
        if let value = await rules { instructions = value }
        if let value = await notes { memory = value; memoryFailed = false } else if memory == nil { memoryFailed = true }
        if let value = await follows { delegations = value }
        if let value = await offered { packs = value }
    }
}

/// The installed packs with an entry, one chip each, above the assistant's composer; nothing shows until one is added in 设置.
struct AssistantPackEntries: View {
    let packs: [AssistantPack]
    let onPick: (String) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let entries = packs.filter { $0.installed && !($0.entry ?? "").isEmpty }
        if !entries.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(entries, id: \.id) { pack in
                        Button { if let entry = pack.entry { onPick(entry + " ") } } label: {
                            Text(pack.title).riffetFont(.label).foregroundStyle(palette.fg2).lineLimit(1)
                                .padding(.horizontal, RiffetMetrics.chipInset).frame(minHeight: RiffetMetrics.chipHeight)
                                .background(Capsule().fill(palette.press))
                                .frame(minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
                        }
                        .buttonStyle(RiffetDimPressStyle())
                    }
                }
                .padding(.horizontal, RiffetMetrics.pageInset)
            }
            .scrollClipDisabled()
        }
    }

    /// A pack's entry at the start of the draft; what was typed stays after it, on its own line.
    static func draft(_ entry: String, typed: String) -> String { typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? entry : entry + "\n" + typed }
}

/// What the three setup pages are, shared by the rows in the session info and the cards before a conversation.
enum AssistantPage: String, Identifiable {
    case memory, rules, abilities
    var id: String { rawValue }
    var title: String {
        switch self {
        case .memory: String(localized: "记忆", bundle: .riffet)
        case .rules: String(localized: "规则", bundle: .riffet)
        case .abilities: String(localized: "能力", bundle: .riffet)
        }
    }
    var symbol: String {
        switch self {
        case .memory: "brain"
        case .rules: "doc.text"
        case .abilities: "puzzlepiece.extension"
        }
    }
    @MainActor @ViewBuilder func destination(workbench: Workbench, setup: AssistantSetup) -> some View {
        switch self {
        case .memory: AssistantMemoryView(setup: setup)
        case .rules: AssistantRulesView(workbench: workbench, setup: setup)
        case .abilities: NativeExtensionsView(workbench: workbench, assistantProjectID: workbench.assistantProject?.id)
        }
    }
}

private func relativeText(_ value: String?) -> String? {
    guard let value, let date = ServerTime.date(value) else { return nil }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    formatter.locale = AppLocalization.shared.locale
    return formatter.localizedString(for: date, relativeTo: Date())
}

/// The setup rows of the session info: 记忆, 规则, 能力 and, once there is one, 委托.
struct AssistantSetupRows: View {
    let workbench: Workbench
    let setup: AssistantSetup

    var body: some View {
        let active = setup.delegations?.filter { $0.state == "active" }.count ?? 0
        ForEach([AssistantPage.memory, .rules, .abilities]) { page in
            NavigationLink { page.destination(workbench: workbench, setup: setup) } label: {
                SettingsRowLabel(title: page.title, symbol: page.symbol, value: value(page))
            }
        }
        if active > 0 {
            NavigationLink { AssistantDelegationsView(workbench: workbench, setup: setup) } label: {
                SettingsRowLabel(title: String(localized: "委托", bundle: .riffet), symbol: "repeat", value: "\(active)")
            }
        }
    }

    private func value(_ page: AssistantPage) -> String? {
        switch page {
        case .memory: relativeText(setup.memory?.updatedAt)
        case .rules: setup.instructions.map { $0.custom ? String(localized: "已修改", bundle: .riffet) : String(localized: "默认", bundle: .riffet) }
        case .abilities: nil
        }
    }
}

/// The tab's root.
struct AssistantRootView: View {
    let workbench: Workbench
    /// Opens another conversation (one a message references) in the tab's stack.
    let onOpenSession: (String) -> Void
    @State private var setup = AssistantSetup()
    /// The conversation just made, shown before the project's own `mainSessionId` arrives.
    @State private var started: String?
    @Environment(\.palette) private var palette

    private var mainID: String? {
        if let id = workbench.assistantMain?.id { return id }
        guard let id = started else { return nil }
        let held = workbench.list.sessions.first { $0.id == id }
        return held?.archivedAt == nil ? id : nil
    }

    var body: some View {
        Group {
            if let id = mainID {
                ConversationView(workbench: workbench, sessionID: id, assistant: setup).id(id)
            } else if workbench.assistantProject != nil {
                NewTaskView(workbench: workbench, onStart: { started = $0.id }, onOpenSession: onOpenSession, assistant: setup)
            } else {
                palette.bg.ignoresSafeArea().overlay { if !workbench.list.loaded { ProgressView() } }
                    .navigationTitle(String(localized: "个人助理", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
            }
        }
        .background(TabBarVisibility(hidden: false))
        .task { await setup.refresh(workbench.api) }
        // The model is told the time in the owner's zone (docs/ASSISTANT.md §5.1).
        .task(id: mainID) {
            let zone = TimeZone.current.identifier
            guard mainID != nil, let api = workbench.api, workbench.settings?.assistant?.timeZone != zone else { return }
            if let saved = try? await api.reportAssistantTimeZone(zone: zone) { workbench.store.applySavedSettings(settings: saved) }
        }
    }
}

/// What the assistant remembers, read-only: to change it, tell the assistant.
struct AssistantMemoryView: View {
    let setup: AssistantSetup
    @State private var expanded: String?
    @Environment(\.palette) private var palette

    private struct Note: Identifiable {
        let entry: AssistantMemoryEntry
        let title: String
        let note: String
        let body: String
        var id: String { entry.name }
    }

    var body: some View {
        let memory = setup.memory
        let notes = (memory?.entries ?? []).map(Self.describe)
        let profile = memory?.profile.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let index = notes.isEmpty ? (memory?.index.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") : ""
        RiffetList {
            if !profile.isEmpty {
                Section { Text(profile).riffetFont(.body).foregroundStyle(palette.fg) } header: { RiffetSectionTitle(String(localized: "关于你", bundle: .riffet)) }
            }
            if !notes.isEmpty || !index.isEmpty {
                Section {
                    if !index.isEmpty { Text(index).riffetFont(.body).foregroundStyle(palette.fg) }
                    ForEach(notes) { note in
                        Button { withAnimation { expanded = expanded == note.id ? nil : note.id } } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 8) {
                                    Text(note.title).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                                    Spacer(minLength: 8)
                                    if let time = relativeText(note.entry.modifiedAt) { Text(time).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
                                }
                                if expanded == note.id {
                                    if !note.body.isEmpty { Text(note.body).riffetFont(.body).foregroundStyle(palette.fg2).textSelection(.enabled) }
                                } else if !note.note.isEmpty {
                                    Text(note.note).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                } header: { RiffetSectionTitle(String(localized: "记下的事", bundle: .riffet)) }
            }
        }
        .overlay {
            if memory == nil { if setup.memoryFailed { Text("无法读取记忆").riffetFont(.body).foregroundStyle(palette.fg3) } else { ProgressView() } }
            else if profile.isEmpty && notes.isEmpty && index.isEmpty { Text("还没有记忆").riffetFont(.body).foregroundStyle(palette.fg3) }
        }
        .navigationTitle(String(localized: "记忆", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }

    /// A topic file's front matter names it and says what it holds; without one its first heading does, else the file name.
    private static func describe(_ entry: AssistantMemoryEntry) -> Note {
        var text = entry.text
        var fields: [String: String] = [:]
        if text.hasPrefix("---\n"), let close = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 4)..<text.endIndex) {
            for line in text[text.index(text.startIndex, offsetBy: 4)..<close.lowerBound].split(separator: "\n") {
                guard let colon = line.firstIndex(of: ":") else { continue }
                fields[String(line[..<colon])] = line[line.index(after: colon)...].trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"'")))
            }
            text = String(text[close.upperBound...])
        }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var heading: String?
        if text.hasPrefix("# ") {
            let end = text.firstIndex(of: "\n") ?? text.endIndex
            heading = String(text[text.index(text.startIndex, offsetBy: 2)..<end]).trimmingCharacters(in: .whitespaces)
            text = String(text[end...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let name = entry.name.hasSuffix(".md") ? String(entry.name.dropLast(3)) : entry.name
        let title = [fields["name"], heading].compactMap { $0 }.first { !$0.isEmpty } ?? name
        return Note(entry: entry, title: title, note: fields["description"] ?? "", body: text)
    }
}

/// `AGENTS.md`: a new conversation reads it, one already running keeps what it read.
struct AssistantRulesView: View {
    let workbench: Workbench
    let setup: AssistantSetup
    @State private var text = ""
    @State private var seeded = false
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    private var dirty: Bool { seeded && text != setup.instructions?.text }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $text).riffetFont(.mono).foregroundStyle(palette.fg).tint(palette.accent)
                .scrollContentBackground(.hidden).disabled(!seeded || busy)
                .padding(.horizontal, RiffetMetrics.pageInset)
            VStack(alignment: .leading, spacing: 4) {
                Text("下次启动时生效").riffetFont(.caption).foregroundStyle(palette.fg3)
                if let error { RiffetNotice(kind: .error, message: error) }
            }
            .padding(.horizontal, RiffetMetrics.pageInset).padding(.bottom, RiffetMetrics.pageInset)
        }
        .background(palette.bg)
        .overlay { if !seeded { ProgressView() } }
        .navigationTitle(String(localized: "规则", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if busy { ProgressView() } else {
                    Menu {
                        Button(String(localized: "恢复默认", bundle: .riffet), systemImage: "arrow.uturn.backward") { Task { await write(nil) } }
                            .disabled(setup.instructions?.custom != true)
                    } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel(String(localized: "恢复默认", bundle: .riffet))
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await write(text) } }.disabled(!dirty || busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .task(id: setup.instructions?.text) {
            // What is typed is not replaced by a later read.
            if !seeded || !dirty, let saved = setup.instructions { text = saved.text; seeded = true }
        }
    }

    private func write(_ value: String?) async {
        guard let api = workbench.api, !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            setup.instructions = try await api.saveAssistantInstructions(text: value)
            dismiss()
        } catch { self.error = error.riffetMessage }
    }
}

/// What the assistant follows over time; the owner can end one, and the assistant makes them.
struct AssistantDelegationsView: View {
    let workbench: Workbench
    let setup: AssistantSetup
    @State private var busy: String?
    @Environment(\.palette) private var palette

    var body: some View {
        let items = setup.delegations
        RiffetList {
            ForEach(items ?? [], id: \.id) { item in
                let active = item.state == "active"
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.goal).riffetFont(.body).foregroundStyle(active ? palette.fg : palette.fg3).lineLimit(2)
                        Text(trigger(item.trigger)).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if active {
                        Button(String(localized: "结束", bundle: .riffet)) { Task { await end(item) } }
                            .buttonStyle(.borderless).tint(palette.danger).disabled(busy == item.id)
                    } else {
                        Text("已结束").riffetFont(.caption).foregroundStyle(palette.fg3)
                    }
                }
            }
        }
        .overlay {
            if items == nil { ProgressView() }
            else if items?.isEmpty == true { Text("还没有委托").riffetFont(.body).foregroundStyle(palette.fg3) }
        }
        .navigationTitle(String(localized: "委托", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }

    private func trigger(_ trigger: AssistantDelegationTrigger) -> String {
        if trigger.kind == "task-status", let number = trigger.taskNumber?.intValue {
            let status = switch trigger.status {
            case "todo": String(localized: "待办", bundle: .riffet)
            case "doing": String(localized: "进行中", bundle: .riffet)
            case "watching": String(localized: "观测中", bundle: .riffet)
            case "review": String(localized: "待验收", bundle: .riffet)
            case "done": String(localized: "已完成", bundle: .riffet)
            case "cancelled": String(localized: "无需关注", bundle: .riffet)
            default: ""
            }
            return status.isEmpty ? "#\(number)" : "#\(number) · \(status)"
        }
        return switch trigger.kind {
        case "schedule": String(localized: "定时 \(trigger.cron ?? "")", bundle: .riffet)
        case "github-release": String(localized: "\(trigger.repo ?? "") 发版", bundle: .riffet)
        default: String(localized: "\(trigger.url ?? "") 有变化", bundle: .riffet)
        }
    }

    private func end(_ item: AssistantDelegation) async {
        guard let api = workbench.api, busy == nil else { return }
        busy = item.id
        defer { busy = nil }
        if let ended = try? await api.endAssistantDelegation(id: item.id) {
            setup.delegations = setup.delegations?.map { $0.id == ended.id ? ended : $0 }
        }
    }
}
