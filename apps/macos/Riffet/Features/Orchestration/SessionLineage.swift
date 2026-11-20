import SwiftUI
import RiffetKit

/// The row comparing the parallel attempts this conversation is one of, above its transcript.
/// Where it was forked or handed off from is not here either: those lines are rows of the transcript
/// itself (`LineageSpec`, `HandedOffSpec`), so they scroll with the history like the web's `lead`.
struct SessionOriginBar: View {
    let workbench: Workbench
    let session: Session

    var body: some View {
        if let origin = session.origin, origin.kind == "attempt", let groupId = origin.groupId {
            AttemptStrip(workbench: workbench, session: session, groupId: groupId)
        }
    }
}

/// What a lineage line shows of another conversation.
struct SessionGlance: Equatable {
    var title: String
    var agent: String?

    @MainActor init?(of id: String, in list: SessionListState) {
        guard let session = list.sessions.first(where: { $0.id == id }) else { return nil }
        title = session.shownTitle
        agent = session.agent.map(backendLabel)
    }
}

/// Runs `update` with `read(list)` now and again whenever the session list changes it. A view that needs a
/// few values from the list reads them here instead of in its `body`, so it is not re-evaluated for every
/// other change the list makes while a conversation streams.
@MainActor
func watchSessionList<T: Equatable>(_ workbench: Workbench, read: @MainActor (SessionListState) -> T, update: @MainActor (T) -> Void) async {
    let (ticks, tick) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
    tick.yield()
    var last: T?
    for await _ in ticks {
        // `onChange` fires once, before the change lands; the next tick re-arms it.
        let value = withObservationTracking { read(workbench.list) } onChange: { tick.yield() }
        if value != last {
            last = value
            update(value)
        }
    }
}
