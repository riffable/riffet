import SwiftUI
import RiffetKit

// SwiftUI pieces outside the transcript list: the todo dock, the toolbar's background shells
// popover, the tag editor and image placeholders.

struct CopyButton: View {
    let text: String
    var help = String(localized: "复制")
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.covered) private var covered
    @State private var copied: FeedbackTiming?
    @State private var copyRevision = UUID()
    @State private var visibleProbes: Set<UUID> = []

    private var visible: Bool { scenePhase == .active && !covered && !visibleProbes.isEmpty }

    private struct CopyTask: Hashable {
        let revision: UUID
        let visible: Bool
        let text: String
    }

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(text, forType: .string) else { return }
            copied = FeedbackTiming(minimumVisibleMillis: feedbackMinimumVisibleMillis())
            copyRevision = UUID()
        } label: {
            Image(icon: copied != nil ? "checkmark" : "doc.on.doc").font(.riffet(size: S(11)))
        }
        .buttonStyle(IconButtonStyle(size: 20))
        .help(help)
        .background {
            FeedbackVisibilityProbe { id, visible in
                if visible { visibleProbes.insert(id) } else { visibleProbes.remove(id) }
            }
        }
        .task(id: CopyTask(revision: copyRevision, visible: visible, text: text)) {
            guard let clock = copied else { return }
            let revision = copyRevision
            let remaining = clock.update(nowMillis: ProcessInfo.processInfo.systemUptime * 1000, visible: visible)
            guard visible else { return }
            do { try await Task.sleep(for: .milliseconds(max(1, remaining))) } catch { return }
            guard !Task.isCancelled, revision == copyRevision else { return }
            _ = clock.update(nowMillis: ProcessInfo.processInfo.systemUptime * 1000, visible: visible)
            if clock.complete { copied = nil }
        }
        .onChange(of: text) { _, _ in copied = nil }
        .onDisappear {
            _ = copied?.update(nowMillis: ProcessInfo.processInfo.systemUptime * 1000, visible: false)
        }
    }
}


struct JobRowView: View {
    let job: NativeJob
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Button { open.toggle() } label: {
                HStack(spacing: Space.sm) {
                    Group {
                        if job.status == .running { Spinner(size: .mini) } else { Image(icon: "terminal").font(.riffet(size: S(12))) }
                    }
                    .frame(width: 16)
                    .foregroundStyle(job.status == .failed ? palette.danger : palette.fg4)
                    Text(job.title).font(.riffet(size: S(13), weight: .medium)).modifier(DisclosureText(danger: job.status == .failed)).lineLimit(1)
                    Spacer(minLength: Space.sm)
                    if job.status != .running { Circle().fill(dotColor).frame(width: 6, height: 6) }
                    Text(statusText).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    TimelineView(.periodic(from: .now, by: job.status == .running ? 1 : 3600)) { context in
                        Text(elapsed(context.date)).font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg4)
                    }
                    DisclosureChevron(open: open)
                }
                .frame(minHeight: 28)
            }
            .buttonStyle(DisclosureRowStyle())
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    if let output = job.output, !output.isEmpty {
                        ScrollView([.vertical, .horizontal]) {
                            Text(output)
                                .font(.riffet(size: S(12), design: .monospaced))
                                .foregroundStyle(palette.fg2)
                                .textSelection(.enabled)
                                .fixedSize()
                                .padding(Space.sm)
                        }
                        .defaultScrollAnchor(.bottomLeading)
                        .frame(maxHeight: 384)
                        .fixedSize(horizontal: false, vertical: true)
                        .background {
                            let shape = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            if DisplayPreferences.shared.style.block == .outlined {
                                shape.strokeBorder(palette.line)
                            } else {
                                shape.fill(palette.bgSubtle)
                            }
                        }
                    } else {
                        Text(job.status == .running ? "还没有输出…" : "没有输出").font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                    }
                    HStack(spacing: Space.sm) {
                        if let id = job.id { Text("shell \(id)").font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(palette.fg4) }
                        if let exit = job.exitCode?.int64Value, exit != 0 { Text("exit \(exit)").font(.riffet(size: S(12))).foregroundStyle(palette.danger) }
                        if job.truncated?.boolValue == true { Text("输出过大，只显示末尾").font(.riffet(size: S(12))).foregroundStyle(palette.fg4) }
                    }
                }
                .padding(.leading, 24)
                .padding(.bottom, Space.sm)
            }
        }
    }

    private var statusText: String {
        switch job.status {
        case .running: String(localized: "运行中")
        case .failed: String(localized: "失败")
        case .unknown: String(localized: "未完成")
        default: String(localized: "完成")
        }
    }

    private var dotColor: Color {
        switch job.status {
        case .running: palette.accent
        case .failed: palette.danger
        case .unknown: palette.fg4
        default: palette.success
        }
    }

    private func elapsed(_ now: Date) -> String {
        let started = ServerTime.date(job.startedAt)
        let running = job.status == .running && started != nil ? Int64(now.timeIntervalSince(started!) * 1000) : 0
        let millis = max(job.runningMs?.int64Value ?? 0, running)
        return millis < 1000 ? "" : formatDurationMs(millis: millis)
    }
}

struct PlanView: View {
    let entries: [TodoEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(entries.indices, id: \.self) { index in
                TodoRow(entry: entries[index])
            }
        }
    }
}

struct TodoRow: View {
    let entry: TodoEntry
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Image(icon: entry.status == .completed ? "checkmark.circle.fill" : entry.status == .inProgress ? "circle.dotted.circle" : "circle")
                .foregroundStyle(entry.status == .completed ? palette.success : entry.status == .inProgress ? palette.accent : palette.fg4)
                .font(.riffet(size: S(12)))
            Text(entry.content)
                .font(.riffet(size: S(13)))
                .foregroundStyle(entry.status == .completed ? palette.fg4 : palette.fg2)
                .strikethrough(entry.status == .completed, color: palette.fg4)
        }
    }
}

extension View {
    /// A soft sweep over a placeholder, like the web's `shimmer`; still when motion is reduced.
    func shimmering() -> some View { modifier(Shimmer()) }
}

private struct Shimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content
                .overlay {
                    GeometryReader { geometry in
                        LinearGradient(colors: [.clear, .white.opacity(0.5), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geometry.size.width * 0.4)
                            .offset(x: phase * geometry.size.width * 1.4)
                            .blendMode(.plusLighter)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
                .onAppear {
                    // motion-loop: loading placeholder shimmer, not composed under Reduce Motion
                    withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { phase = 1 } // perf-lint: allow only on an image placeholder in the file panel, while it loads
                }
        }
    }
}

/// Wraps its children onto as many lines as they need.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
