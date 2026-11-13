import SwiftUI
import RiffetKit

/// What a node holds, beside the canvas: the canvas shows how a conversation is shaped, this panel what was said and done at one
/// place in it. Everything it shows is the engine's detail for the node (texts in the reader's language); the answer is rendered by
/// the transcript's markdown, a change by the changes panel's diff.
struct CanvasInspector: View {
    let controller: CanvasController
    @Environment(\.palette) private var palette

    var body: some View {
        if let node = controller.selectedNode {
            let detail = controller.detail
            VStack(spacing: 0) {
                header(node, detail)
                Rectangle().fill(palette.lineSoft).frame(height: 1)
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) { content(node, detail) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16).padding(.vertical, 12)
                    }
                    .onChange(of: controller.focusIndex) { _, index in
                        guard let index, let key = detail?.steps?[safe: index]?.key else { return }
                        withAnimation { proxy.scrollTo(key, anchor: .center) }
                    }
                }
            }
            .frame(width: 400)
            .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
            .elevation(.pop)
            .padding(12)
            .environment(\.conversationProjectId, controller.projectId)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
    }

    private func title(_ node: CanvasNode, _ detail: CanvasNodeDetail?) -> String {
        if let title = detail?.title, !title.isEmpty { return title }
        let s = controller.strings
        switch node.kind {
        case .user: return s["prompt"] ?? ""
        case .agent: return s["answer"] ?? ""
        case .change: return s["outputs"] ?? ""
        case .artifacts: return s["artifacts"] ?? ""
        default: return ""
        }
    }

    private func header(_ node: CanvasNode, _ detail: CanvasNodeDetail?) -> some View {
        let s = controller.strings
        let isActor: Bool = { if case .actor = node.kind { true } else { false } }()
        return HStack(spacing: 2) {
            Text(verbatim: title(node, detail))
                .font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !isActor {
                Button { controller.open(node) } label: { Image(icon: "arrow.up.right.square") }
                    .buttonStyle(IconButtonStyle(size: 26)).help(s["openInChat"] ?? "")
            }
            if let forking = controller.canFork(node) {
                Button { controller.fork(node) } label: { if forking { Spinner() } else { Image(icon: "arrow.triangle.branch") } }
                    .buttonStyle(IconButtonStyle(size: 26)).disabled(forking).help(s["forkFromHere"] ?? "")
            }
            Button { controller.deselect() } label: { Image(icon: "xmark") }
                .buttonStyle(IconButtonStyle(size: 26)).help(s["close"] ?? "")
        }
        .padding(.leading, 16).padding(.trailing, 8)
        .frame(height: 44)
    }

    @ViewBuilder
    private func content(_ node: CanvasNode, _ detail: CanvasNodeDetail?) -> some View {
        if let detail {
            let session = controller.nodeSession(node) ?? ""
            switch node.kind {
            case .user:
                if let text = detail.text, !text.isEmpty { body(text) }
                images(detail.images ?? [], session: session)
                if let others = detail.others, others > 0 { muted("+\(others)") }
                ForEach(Array((detail.steers ?? []).enumerated()), id: \.offset) { _, steer in
                    body(steer).padding(.leading, 10).overlay(alignment: .leading) { Rectangle().fill(palette.line).frame(width: 2) }
                }
            case .signal:
                ForEach(Array((detail.arrivals ?? []).enumerated()), id: \.offset) { _, arrival in
                    HStack(spacing: 8) {
                        Text(verbatim: arrival.title).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(2)
                        Spacer(minLength: 0)
                        Text(verbatim: arrival.status).font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                    }
                }
            case .agent:
                facts(detail.facts)
                if let summary = detail.summary, !summary.isEmpty {
                    Text(verbatim: summary).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
                }
                if let answer = detail.answer, !answer.isEmpty {
                    MarkdownView(source: answer)
                } else {
                    muted(controller.strings[detail.running == true ? "running" : "noBody"] ?? "")
                }
                if let timeline = detail.timeline { CanvasTimeline(controller: controller, session: session, tree: timeline, depth: 0) }
            case .actor:
                facts(detail.facts)
                if let command = detail.command, !command.isEmpty { code(command) }
                if let lane = detail.lane { lanePanel(detail, lane: lane, session: session) }
            case .change:
                ForEach(Array((detail.edits ?? []).enumerated()), id: \.offset) { _, edit in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: edit.path).font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(palette.fg2).lineLimit(1).truncationMode(.head)
                            .onTapGesture { controller.openPath(edit.path) }
                        FullDiffView(before: edit.before, after: edit.after)
                            .frame(height: Self.diffHeight(edit.before, edit.after))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(palette.lineSoft, lineWidth: 1))
                    }
                }
                ForEach(Array((detail.commands ?? []).enumerated()), id: \.offset) { _, entry in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            Text(verbatim: entry.path).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg2).lineLimit(1).truncationMode(.head)
                            Spacer(minLength: 0)
                            Text(verbatim: controller.strings["byCommand"] ?? "").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                        }
                        ForEach(Array(entry.commands.enumerated()), id: \.offset) { _, command in code(command) }
                    }
                }
            case .artifacts:
                ForEach(Array((detail.items ?? []).enumerated()), id: \.offset) { _, item in artifact(item, session: session) }
            case .tools:
                ForEach(Array((detail.steps ?? []).enumerated()), id: \.element.key) { index, step in
                    callRow(step, focused: controller.focusIndex == index)
                }
            default:
                EmptyView()
            }
        } else {
            HStack { Spinner() }.frame(maxWidth: .infinity).padding(.top, 24)
        }
    }

    // MARK: Pieces

    private func body(_ text: String) -> some View {
        Text(verbatim: text).font(.riffet(size: S(13))).foregroundStyle(palette.fg).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func muted(_ text: String) -> some View {
        Text(verbatim: text).font(.riffet(size: S(13))).foregroundStyle(palette.fg4)
    }

    @ViewBuilder
    private func facts(_ facts: [String]?) -> some View {
        let shown = (facts ?? []).filter { !$0.isEmpty }
        if !shown.isEmpty {
            Text(verbatim: shown.joined(separator: "    ")).font(.riffet(size: S(11)).monospacedDigit()).foregroundStyle(palette.fg3)
        }
    }

    private func code(_ text: String, limit: CGFloat? = nil, tone: Color? = nil) -> some View {
        ScrollView(limit == nil ? [] : .vertical) {
            Text(verbatim: text).font(.riffet(size: S(11.5), design: .monospaced)).foregroundStyle(tone ?? palette.fg2).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .frame(maxHeight: limit)
        .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func images(_ ids: [String], session: String) -> some View {
        let _ = controller.imageRevision
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 8)], spacing: 8) {
            ForEach(ids, id: \.self) { id in
                thumb(controller.image(id), height: 72)
                    .onTapGesture { controller.openViewer(key: id, name: "", session: session, path: nil, inline: nil) }
            }
        }
    }

    @ViewBuilder
    private func thumb(_ image: CGImage?, height: CGFloat) -> some View {
        if let image {
            Image(decorative: image, scale: 2).resizable().scaledToFill().frame(maxWidth: .infinity).frame(height: height).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 7, style: .continuous).fill(palette.bgMuted).frame(height: height)
        }
    }

    private func artifact(_ item: CanvasNodeDetail.Artifact, session: String) -> some View {
        let _ = controller.imageRevision
        return VStack(alignment: .leading, spacing: 6) {
            if item.kind == "image" {
                thumb(controller.image(item.key), height: 160)
                    .onTapGesture { controller.openViewer(key: item.key, name: item.name, session: session, path: item.path, inline: item.src) }
            } else {
                Button { if let path = item.path { controller.openPath(path) } } label: {
                    Image(icon: "globe").frame(maxWidth: .infinity).frame(height: 64)
                        .foregroundStyle(palette.fg4)
                        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(palette.lineStrong, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            Text(verbatim: item.path ?? item.name).font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
        }
    }

    private func callRow(_ step: CanvasNodeDetail.Call, focused: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: step.name ?? "").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(step.failed == true ? palette.danger : palette.fg2)
                if let title = step.title, title != step.arg {
                    Text(verbatim: title).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Spacer(minLength: 0)
                }
                Text(verbatim: step.duration).font(.riffet(size: S(11)).monospacedDigit()).foregroundStyle(palette.fg4)
            }
            if let arg = step.arg, !arg.isEmpty { code(arg) }
            if let output = step.output, !output.isEmpty { code(output, limit: 224, tone: palette.fg3) }
        }
        .padding(focused ? 8 : 0)
        .background(focused ? palette.accentSoft.opacity(0.5) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .id(step.key)
    }

    @ViewBuilder
    private func lanePanel(_ detail: CanvasNodeDetail, lane: String, session: String) -> some View {
        switch detail.laneState {
        case "loading":
            Spinner()
        case "open":
            if let answer = detail.answer, !answer.isEmpty { MarkdownView(source: answer) }
            if let timeline = detail.timeline { CanvasTimeline(controller: controller, session: session, tree: timeline, depth: 0) }
        default:
            Button { controller.toggleLane(session: session, lane: lane, open: true) } label: {
                Label { Text(verbatim: controller.strings["showSteps"] ?? "") } icon: { Image(icon: "chevron.down") }
            }
            .buttonStyle(ChipButtonStyle())
        }
    }

    /// A line is about 17 points; the diff scrolls beyond what fits in 320.
    private static func diffHeight(_ before: String, _ after: String) -> CGFloat {
        let lines = max(before.split(separator: "\n", omittingEmptySubsequences: false).count, after.split(separator: "\n", omittingEmptySubsequences: false).count)
        return min(320, max(96, CGFloat(lines) * 17 + 24))
    }
}

/// The steps of an answer on one time axis: what ran side by side, and what outlived the rest. A subagent's steps open in place.
struct CanvasTimeline: View {
    let controller: CanvasController
    let session: String
    let tree: CanvasStepTree
    let depth: Int
    @Environment(\.palette) private var palette

    var body: some View {
        if let steps = tree.steps, !steps.isEmpty {
            VStack(spacing: 0) {
                ForEach(steps.prefix(200), id: \.key) { step in
                    row(step)
                    if let open = step.open, depth < 3 {
                        if open.loading == true { Spinner().padding(.vertical, 4).padding(.leading, 24).frame(maxWidth: .infinity, alignment: .leading) }
                        else { CanvasTimeline(controller: controller, session: session, tree: open, depth: depth + 1) }
                    }
                }
                if depth == 0, let total = tree.total {
                    HStack {
                        Text(verbatim: "0")
                        Spacer()
                        Text(verbatim: total)
                    }
                    .font(.riffet(size: S(10)).monospacedDigit()).foregroundStyle(palette.fg4)
                    .padding(.leading, 158).padding(.top, 4)
                }
            }
            .padding(.top, depth == 0 ? 12 : 0)
            .overlay(alignment: .top) { if depth == 0 { Rectangle().fill(palette.lineSoft).frame(height: 1) } }
        }
    }

    private func row(_ step: CanvasStep) -> some View {
        HStack(spacing: 8) {
            Group {
                if let lane = step.lane {
                    Button { controller.toggleLane(session: session, lane: lane, open: step.open == nil) } label: { label(step) }
                        .buttonStyle(.plain)
                } else {
                    label(step)
                }
            }
            .frame(width: 150, alignment: .leading)
            ZStack(alignment: .leading) {
                Capsule().fill(palette.bgMuted).frame(height: 6)
                GeometryReader { geometry in
                    Capsule().fill(color(step))
                        .frame(width: max(3, geometry.size.width * (step.b - step.a) / 100), height: 6)
                        .offset(x: geometry.size.width * step.a / 100, y: (geometry.size.height - 6) / 2)
                        .opacity(step.running == true ? 0.6 : 1)
                }
            }
            .frame(height: 22)
            .help("\(step.label) · \(step.duration)")
        }
        .frame(height: 22)
    }

    private func label(_ step: CanvasStep) -> some View {
        HStack(spacing: 4) {
            if step.lane != nil {
                Image(icon: "chevron.down").font(.system(size: S(8))).rotationEffect(.degrees(step.open == nil ? -90 : 0))
            }
            if step.kind == "subagent" { Image(icon: "sparkles").font(.system(size: S(10))).foregroundStyle(palette.accent) }
            else if step.kind == "background" { Image(icon: "terminal").font(.system(size: S(10))).foregroundStyle(palette.success) }
            Text(verbatim: step.label).lineLimit(1)
        }
        .font(.riffet(size: S(11))).foregroundStyle(palette.fg3)
        .padding(.leading, CGFloat(depth) * 10)
    }

    private func color(_ step: CanvasStep) -> Color {
        if step.failed == true { return palette.danger }
        if let tool = step.tool {
            switch tool {
            case "read", "search": return palette.fg4.opacity(0.7)
            case "edit": return palette.fg2
            case "execute": return palette.fg3
            case "fetch": return palette.fg3.opacity(0.8)
            default: return palette.fg4
            }
        }
        switch step.kind {
        case "thought": return palette.fg4.opacity(0.5)
        case "commentary": return palette.fg3.opacity(0.6)
        case "answer": return palette.fg2
        case "plan": return palette.fg3.opacity(0.7)
        case "status": return palette.danger.opacity(0.7)
        case "subagent": return palette.accent.opacity(0.7)
        case "background": return palette.fg3.opacity(0.7)
        default: return palette.fg4.opacity(0.4)
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
