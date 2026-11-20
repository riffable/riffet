import AppKit
import Foundation
import Observation
import WidgetKit
import RiffetKit

/// Keeps the desktop widget's data file current. The widget is a sandboxed extension that cannot
/// ask the app anything, and an App Group is not reliable under ad-hoc signing, so the app writes a
/// small JSON snapshot into its own Application Support folder, which the widget may read through a
/// read-only sandbox exception (docs/MACOS.md, "原生能力").
///
/// The list changes on every frame of a running turn, so writes are throttled to one per two seconds
/// and skipped when the snapshot did not change; the widget's own timer shows the elapsed time. An
/// unchanged snapshot is still rewritten every few minutes so the widget can tell a quiet app from a
/// gone one (`WidgetSnapshot.generatedAt`). No workbench (not connected, server stopped) is written as
/// offline, once.
@MainActor
enum WidgetSnapshotWriter {
    private static var written: WidgetSnapshot?
    private static var writtenAt = Date.distantPast
    private static var scheduled = false
    private static let heartbeat: TimeInterval = 5 * 60

    static func start() {
        observe()
        Timer.scheduledTimer(withTimeInterval: heartbeat, repeats: true) { _ in
            MainActor.assumeIsolated { schedule() }
        }
        // A sleeping Mac stops the heartbeat, and the file is stale by the time it wakes: write now and
        // make the widget read it, not after the next heartbeat.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                guard let snapshot = current() else { return }
                write(snapshot, force: true)
            }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { write(WidgetSnapshot(offline: true)) }
        }
    }

    /// `onChange` fires once, before the change lands; observe again on the next turn.
    private static func observe() {
        withObservationTracking {
            _ = AppModel.shared.workbench?.list
        } onChange: {
            Task { @MainActor in observe() }
        }
        schedule()
    }

    private static func schedule() {
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            MainActor.assumeIsolated {
                scheduled = false
                if let snapshot = current() { write(snapshot) }
            }
        }
    }

    /// What the widget should show now: offline without a workbench, nothing before the list loads.
    private static func current() -> WidgetSnapshot? {
        guard let workbench = AppModel.shared.workbench else { return WidgetSnapshot(offline: true) }
        return workbench.list.loaded ? snapshot(workbench) : nil
    }

    private static func snapshot(_ workbench: Workbench) -> WidgetSnapshot {
        let waiting = workbench.waitingSessions
        let running = workbench.activeSessions.filter { $0.state != .waiting }
            .sorted { (ServerTime.date($0.activeSince) ?? .distantFuture) > (ServerTime.date($1.activeSince) ?? .distantFuture) }
        func row(_ session: Session, _ state: String) -> WidgetSnapshot.Row {
            WidgetSnapshot.Row(
                id: session.id, title: session.shownTitle.ifEmpty(String(localized: "新会话")), project: workbench.project(session.projectId)?.name ?? "",
                state: state, since: state == "running" ? ServerTime.date(session.activeSince) : nil
            )
        }
        return WidgetSnapshot(
            waiting: waiting.count, running: running.count,
            rows: Array((waiting.map { row($0, "waiting") } + running.map { row($0, "running") }).prefix(3))
        )
    }

    private static func write(_ snapshot: WidgetSnapshot, force: Bool = false) {
        let changed = written.map { !$0.sameContent(as: snapshot) } ?? true
        // The heartbeat timer and the delay after it make the gap a little over `heartbeat`, so the
        // comparison leaves room: at exactly the boundary a write would be skipped for a whole period.
        let elapsed = Date.now.timeIntervalSince(writtenAt)
        guard force || changed || elapsed >= heartbeat - 30 else { return }
        // Only what the widget shows differently spends WidgetKit's daily reload budget; a heartbeat
        // just keeps the file fresh for the widget's own refresh.
        let reload = force || changed
        var snapshot = snapshot
        snapshot.generatedAt = .now
        guard let data = snapshot.encoded() else { return }
        do {
            try FileManager.default.createDirectory(at: WidgetSnapshot.directory, withIntermediateDirectories: true)
            try data.write(to: WidgetSnapshot.fileURL, options: .atomic)
        } catch {
            return
        }
        written = snapshot
        writtenAt = .now
        if reload { WidgetCenter.shared.reloadAllTimelines() }
    }
}
