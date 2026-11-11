import SwiftUI
import RiffetKit

struct ConversationFeedbackValue: Equatable {
    let key: String
    let text: String
    var error = false
    var warning = true
    var retry = false
}

/// Retained text never owns a callback or delays Workbench's live state.
@MainActor @Observable
final class ConversationFeedback {
    struct Entry: Identifiable {
        let id = UUID()
        var value: ConversationFeedbackValue
        var current = true
        var recovered = false
        var presented = false
        let clock = FeedbackTiming(minimumVisibleMillis: 1500)
    }
    private(set) var entries: [Entry] = []
    private var scope: String?
    private var task: Task<Void, Never>?
    private var visible = false

    func update(scope: String, source: [ConversationFeedbackValue], visible: Bool, recovered: Set<String>) {
        task?.cancel()
        if self.scope != scope { entries = []; self.scope = scope }
        let now = ProcessInfo.processInfo.systemUptime * 1000
        let live = Dictionary(uniqueKeysWithValues: source.map { ($0.key, $0) })
        entries = entries.compactMap { old in
            var entry = old
            entry.clock.update(nowMillis: now, visible: visible && entry.presented)
            if let value = live[entry.value.key], value.text == entry.value.text {
                if !entry.current { entry.clock.restart(nowMillis: now) }
                entry.value = value; entry.current = true; entry.recovered = false
            } else {
                entry.current = false; entry.recovered = recovered.contains(entry.value.key)
            }
            return !entry.current && entry.clock.complete ? nil : entry
        }
        for value in source where !entries.contains(where: { $0.value.key == value.key && $0.value.text == value.text }) {
            let entry = Entry(value: value)
            entry.clock.update(nowMillis: now, visible: visible && entry.presented)
            entries.append(entry)
        }
        self.visible = visible
        schedule()
    }

    func presented(in scope: String) -> [Entry] { self.scope == scope ? entries : [] }

    func pause() {
        task?.cancel(); visible = false
        let now = ProcessInfo.processInfo.systemUptime * 1000
        entries.forEach { $0.clock.update(nowMillis: now, visible: false) }
    }

    func presentation(_ id: UUID, visible presented: Bool) {
        guard let index = entries.firstIndex(where: { $0.id == id }), entries[index].presented != presented else { return }
        task?.cancel()
        let now = ProcessInfo.processInfo.systemUptime * 1000
        entries[index].clock.update(nowMillis: now, visible: visible && presented)
        entries[index].presented = presented
        schedule()
    }

    private func schedule() {
        guard visible, let remaining = entries.filter({ !$0.current && $0.presented }).map({ $0.clock.remainingMillis }).min() else { return }
        task = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(max(1, remaining))) } catch { return }
            guard let self, !Task.isCancelled, self.visible else { return }
            let now = ProcessInfo.processInfo.systemUptime * 1000
            self.entries.forEach { $0.clock.update(nowMillis: now, visible: $0.presented) }
            self.entries.removeAll { !$0.current && $0.clock.complete }
            self.schedule()
        }
    }
}

/// A fresh tap renews the reading budget; cancellation cannot clear a later copy.
@MainActor @Observable
final class ConversationCopyFeedback {
    private(set) var copied = false
    private let clock = FeedbackTiming(minimumVisibleMillis: 2000)
    private var visible = false
    private var task: Task<Void, Never>?

    func copy() {
        let now = ProcessInfo.processInfo.systemUptime * 1000
        clock.restart(nowMillis: now)
        clock.update(nowMillis: now, visible: visible)
        copied = true
        schedule()
    }

    func visibility(_ visible: Bool) {
        clock.update(nowMillis: ProcessInfo.processInfo.systemUptime * 1000, visible: visible)
        self.visible = visible
        schedule()
    }

    private func schedule() {
        task?.cancel()
        guard visible, copied else { return }
        task = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(for: .milliseconds(max(1, self.clock.remainingMillis))) } catch { return }
            guard !Task.isCancelled, self.visible else { return }
            self.clock.update(nowMillis: ProcessInfo.processInfo.systemUptime * 1000, visible: true)
            if self.clock.complete { self.copied = false } else { self.schedule() }
        }
    }
}

private struct ConversationCopyVisibility: ViewModifier {
    let feedback: ConversationCopyFeedback
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.conversationFeedbackActive) private var active
    @State private var appeared = false
    @State private var fullFrame = false
    private var visible: Bool { active && appeared && fullFrame && scenePhase == .active }
    func body(content: Content) -> some View {
        content
            .background(ConversationFeedbackProbe { fullFrame = $0 })
            .onAppear { appeared = true }
            .onChange(of: visible, initial: true) { _, value in feedback.visibility(value) }
            .onDisappear { appeared = false; feedback.visibility(false) }
    }
}

extension EnvironmentValues {
    @Entry var conversationFeedbackActive = true
}

extension View {
    func conversationCopyFeedback(_ feedback: ConversationCopyFeedback) -> some View {
        modifier(ConversationCopyVisibility(feedback: feedback))
    }
}

private struct ConversationFeedbackVisibility: ViewModifier {
    let feedback: ConversationFeedback
    let id: UUID
    let allowed: Bool
    @State private var fullFrame = false
    @State private var appeared = false
    @State private var entered = false
    private var presented: Bool { allowed && appeared && entered && fullFrame }
    func body(content: Content) -> some View {
        content
            .onAppear { appeared = true }
            .background(ConversationFeedbackProbe { fullFrame = $0 })
            .task(id: appeared) {
                guard appeared else { return }
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                guard !Task.isCancelled else { return }
                entered = true
            }
            .onChange(of: presented, initial: true) { _, value in feedback.presentation(id, visible: value) }
            .onDisappear { appeared = false; entered = false; feedback.presentation(id, visible: false) }
    }
}

extension View {
    func conversationFeedbackVisibility(_ feedback: ConversationFeedback, id: UUID, visible: Bool = true) -> some View {
        modifier(ConversationFeedbackVisibility(feedback: feedback, id: id, allowed: visible))
    }
}

/// UIKit conversion is deliberate: each transcript cell has its own SwiftUI global space.
private struct ConversationFeedbackProbe: UIViewRepresentable {
    var onVisibility: (Bool) -> Void
    func makeUIView(context: Context) -> Probe { Probe() }
    func updateUIView(_ view: Probe, context: Context) { view.onVisibility = onVisibility; view.measure() }
    final class Probe: UIView {
        var onVisibility: ((Bool) -> Void)?
        private var reported: Bool?
        private weak var observedScroll: UIScrollView?
        private var scrollObservation: NSKeyValueObservation?
        override func didMoveToWindow() { super.didMoveToWindow(); observeViewport(); measure() }
        override func didMoveToSuperview() { super.didMoveToSuperview(); observeViewport(); measure() }
        override func layoutSubviews() { super.layoutSubviews(); observeViewport(); measure() }
        private func observeViewport() {
            guard window != nil else { scrollObservation = nil; observedScroll = nil; return }
            var parent = superview
            while let view = parent, !(view is UIScrollView) { parent = view.superview }
            let scroll = parent as? UIScrollView
            guard scroll !== observedScroll else { return }
            scrollObservation = nil
            observedScroll = scroll
            scrollObservation = scroll?.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { [weak self] in self?.measure() }
            }
        }
        func measure() {
            let visible: Bool
            if let window, bounds.width > 0, bounds.height > 0 {
                let frame = convert(bounds, to: window)
                var available = window.bounds.inset(by: window.safeAreaInsets)
                var parent = superview
                while let ancestor = parent, ancestor !== window {
                    if ancestor.clipsToBounds { available = available.intersection(ancestor.convert(ancestor.bounds, to: window)) }
                    parent = ancestor.superview
                }
                let intersection = frame.intersection(available)
                visible = !intersection.isNull && intersection.width + 1 >= frame.width && intersection.height + 1 >= frame.height
            } else { visible = false }
            guard visible != reported else { return }
            reported = visible
            DispatchQueue.main.async { [weak self] in self?.onVisibility?(visible) }
        }
    }
}

/// Measure the unclamped text without adding its height to the floating preview.
struct ConversationFeedbackText: View {
    let text: String
    let preview: Bool
    var onDetails: () -> Void
    @State private var previewHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text).font(.caption).lineLimit(preview ? 3 : nil).textSelection(.enabled)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { previewHeight = $0 }
                .background(alignment: .top) {
                    if preview {
                        Text(text).font(.caption).fixedSize(horizontal: false, vertical: true)
                            .hidden().accessibilityHidden(true)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                    }
                }
            if preview && fullHeight > previewHeight + 1 {
                Button("详情", action: onDetails).font(.caption)
            }
        }
    }
}
