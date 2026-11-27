import SwiftUI
import RiffetKit

/// The open transcript's scroll state, handed up to the overview column (the transcript owns it).
@MainActor
@Observable
final class TranscriptScrollLink {
    var scroll: TranscriptScrollState?
}

/// Puts the overview column (`SessionAside`) beside the conversation, and decides from the width
/// alone whether it shows: never from what the conversation holds, so a plan or a file arriving
/// cannot add or remove it. The conversation keeps one place in the stack either way.
struct SessionAsideHost: ViewModifier {
    let workbench: Workbench
    let session: Session
    let link: TranscriptScrollLink
    /// Whether the style and the reader's setting allow the column at all.
    let allowed: Bool
    /// The conversation's width that leaves the reading column its room beside the column.
    let needed: CGFloat
    @Binding var fits: Bool

    func body(content: Content) -> some View {
        HStack(spacing: 0) {
            content
            if allowed && fits {
                SessionAside(workbench: workbench, session: session, link: link)
                    .frame(width: SessionAside.width)
            }
        }
        .onGeometryChange(for: Bool.self) { $0.size.width >= needed } action: { fits = $0 }
    }
}

/// The wide layout's side column (the web's `SessionAside`): what the agent set out to do, where the
/// conversation has been, what runs beside it and what it produced.
struct SessionAside: View {
    static let width: CGFloat = 248
    private static let limit = 6
    private static let outputLimit = 8

    let workbench: Workbench
    let session: Session
    let link: TranscriptScrollLink
    @Environment(\.palette) private var palette
    @State private var planExpanded = false
    @State private var outputsExpanded = false

    var body: some View {
        let goal = workbench.goal
        let todos = workbench.todos
        let scroll = link.scroll.flatMap { $0.sessionId == session.id ? $0 : nil }
        let outputs = workbench.outputs
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if goal != nil || !todos.isEmpty { plan(goal: goal, todos: todos) }
                if let scroll, !scroll.turns.isEmpty { turns(scroll) }
                SessionWorkActions(workbench: workbench)
                if !outputs.isEmpty { self.outputs(outputs) }
            }
            // The first section's hairline is pulled out of the scroll view's top edge.
            .padding(.top, -1)
            .padding(.leading, Space.xs)
            .padding(.trailing, Space.md)
            .padding(.bottom, Space.lg)
        }
        .scrollIndicators(.hidden)
        .padding(.top, Space.sm)
    }

    // MARK: Plan

    private func plan(goal: SessionGoal?, todos: [TodoEntry]) -> some View {
        let settled: (TodoEntry) -> Bool = { $0.status == .completed }
        let folds = todos.count > Self.limit && !planExpanded
        let shown = folds ? Array(todos.filter { !settled($0) }.prefix(Self.limit)) : todos
        let hidden = folds ? todos.filter { !settled($0) }.count - shown.count : 0
        return InfoSection(title: String(localized: "计划"), meta: todos.isEmpty ? goal.map { goalStatusLabel(goal: $0) } : todoProgress(entries: todos)) {
            if let goal {
                let blocked = goal.status == "blocked"
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(goal.objective).font(.riffet(size: S(13))).foregroundStyle(blocked ? palette.warning : palette.fg2).lineLimit(4)
                    if blocked, let reason = goal.reason, !reason.isEmpty {
                        Text(reason).font(.riffet(size: S(12))).foregroundStyle(palette.warning).lineLimit(3)
                    }
                }
                .padding(.horizontal, Space.sm)
                .padding(.vertical, Space.xs)
            }
            VStack(alignment: .leading, spacing: 5) {
                ForEach(shown.indices, id: \.self) { TodoRow(entry: shown[$0]) }
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
            if hidden > 0 {
                foldButton(String(localized: "还有 \(hidden) 项")) { planExpanded = true }
            } else if planExpanded, todos.count > Self.limit {
                foldButton(String(localized: "收起")) { planExpanded = false }
            }
        }
    }

    // MARK: Turns

    private func turns(_ scroll: TranscriptScrollState) -> some View {
        let turns = scroll.turns
        let active = scroll.activeTurn
        return InfoSection(title: String(localized: "本会话"), count: turns.count) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(turns.indices, id: \.self) { index in
                            Button {
                                scroll.controller?.scroll(to: nativeString(turns[index].rowKey), center: false, animated: true)
                            } label: {
                                HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                                    Text("\(index + 1)").font(.riffet(size: S(11)).monospacedDigit())
                                        .foregroundStyle(index == active ? palette.accent : palette.fg4)
                                        .frame(width: 16, alignment: .leading)
                                    Text(turns[index].preview).font(.riffet(size: S(13), weight: index == active ? .medium : .regular))
                                        .foregroundStyle(index == active ? palette.fg : palette.fg3).lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, Space.sm)
                                .frame(height: 26)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(HoverRowStyle(radius: 8))
                            .id(index)
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .frame(maxHeight: 240)
                .fixedSize(horizontal: false, vertical: true)
                .onChange(of: active) { _, active in proxy.scrollTo(active) }
            }
        }
    }

    // MARK: Outputs

    private func outputs(_ outputs: [SessionOutput]) -> some View {
        let root = workbench.project(session.projectId)?.cwd
        let paths = outputs.map { stripRoot(text: $0.path, root: root) }
        let labels = shortOutputLabels(paths)
        let shown = outputsExpanded ? outputs : Array(outputs.prefix(Self.outputLimit))
        return InfoSection(title: String(localized: "产出"), count: outputs.count) {
            ForEach(Array(shown.enumerated()), id: \.element.path) { index, output in
                let path = paths[index]
                let name = (path as NSString).lastPathComponent
                let label = labels[index]
                let status = output.status ?? (output.created ? "created" : "modified")
                Button {
                    FileOpener.activate(path: path, line: nil, projectId: session.projectId, workbench: workbench)
                } label: {
                    HStack(spacing: Space.sm) {
                        Image(icon: FileSymbols.symbol(name))
                            .font(RiffetFont.caption)
                            .foregroundStyle(palette.fg4)
                            .frame(width: 16)
                            .accessibilityHidden(true)
                        Text(label).font(.riffet(size: S(12), design: .monospaced))
                            .foregroundStyle(status == "deleted" ? palette.fg4 : palette.fg2)
                            .strikethrough(status == "deleted")
                            .lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: Space.xs)
                        HStack(spacing: 6) {
                            if status == "created" { Text("新建").foregroundStyle(palette.fg4) }
                            if status == "deleted" { Text("已删除").foregroundStyle(palette.fg4) }
                            if output.binary { Text("二进制").foregroundStyle(palette.fg4) }
                            if !output.binary && output.added > 0 { Text(verbatim: "+\(output.added)").foregroundStyle(palette.success) }
                            if !output.binary && output.removed > 0 { Text(verbatim: "−\(output.removed)").foregroundStyle(palette.danger) }
                        }
                        .font(.riffet(size: S(11)).monospacedDigit())
                        .fixedSize()
                    }
                    .padding(.horizontal, Space.sm)
                    .frame(height: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(HoverRowStyle(radius: 8))
                .help(path)
            }
            if outputs.count > Self.outputLimit {
                foldButton(outputsExpanded ? String(localized: "收起") : String(localized: "还有 \(outputs.count - Self.outputLimit) 个文件")) { outputsExpanded.toggle() }
            }
        }
    }

    /// Shows the file name when unique, or adds parent segments when multiple outputs share a basename.
    private func shortOutputLabels(_ paths: [String]) -> [String] {
        let split = paths.map { $0.split(separator: "/").map(String.init) }
        var counts: [String: Int] = [:]
        for parts in split {
            if let base = parts.last { counts[base, default: 0] += 1 }
        }
        return zip(paths, split).map { path, parts in
            guard let base = parts.last else { return path }
            if (counts[base] ?? 0) <= 1 || parts.count <= 1 { return base }
            return parts.suffix(2).joined(separator: "/")
        }
    }

    private func foldButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.sm)
            .frame(height: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverRowStyle(radius: 8))
    }
}
