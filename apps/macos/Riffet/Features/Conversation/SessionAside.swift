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
                SessionWorkActions(workbench: workbench, inline: true)
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
        return InfoSection(title: String(localized: "计划"), meta: todos.isEmpty ? goal.map { goalStatusLabel(action: $0.action) } : todoProgress(entries: todos)) {
            if let goal {
                let blocked = goal.action == "blocked"
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(goal.objective).font(.riffet(size: S(13))).foregroundStyle(blocked ? palette.warning : palette.fg2).lineLimit(4)
                    if blocked, let reason = goal.blockedReason, !reason.isEmpty {
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
        let shown = outputsExpanded ? outputs : Array(outputs.prefix(Self.outputLimit))
        return InfoSection(title: String(localized: "产出"), count: outputs.count) {
            ForEach(shown, id: \.path) { output in
                let path = stripRoot(text: output.path, root: root)
                Button {
                    FileOpener.activate(path: path, line: nil, projectId: session.projectId, workbench: workbench)
                } label: {
                    HStack(spacing: Space.sm) {
                        Text((path as NSString).lastPathComponent).font(.riffet(size: S(12), design: .monospaced))
                            .foregroundStyle(palette.fg2).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: Space.xs)
                        HStack(spacing: 6) {
                            if output.created && output.removed == 0 { Text("新建").foregroundStyle(palette.fg4) }
                            if output.added > 0 { Text(verbatim: "+\(output.added)").foregroundStyle(palette.success) }
                            if output.removed > 0 { Text(verbatim: "−\(output.removed)").foregroundStyle(palette.danger) }
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
