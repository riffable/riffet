import SwiftUI
import RiffetKit

/// Holds a warm CLI for the home page's choice, so the first message starts faster. The lifecycle is
/// `PrewarmLease`, shared with the iPhone and Android pages and the same as the web page's: asked for
/// when the page opens, renewed while it stays open, released when it closes or the choice changes,
/// unless a send handed it to the new conversation.
struct PrewarmWatcher: View {
    /// What a warm-up is for; two equal values need only one request.
    struct Request: Equatable {
        let projectId: String
        let backend: String
        let profileId: String?
        let model: String?
        let mode: String?
        let approval: String?
    }

    let lease: PrewarmLease
    let api: RiffetApi?
    /// Nil while there is no project or the backend does not warm up.
    let request: Request?

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .onAppear { lease.hold(api: api, body: Self.body(request)) }
            .onChange(of: request) { _, request in lease.hold(api: api, body: Self.body(request)) }
            .onChange(of: api == nil) { _, _ in lease.hold(api: api, body: Self.body(request)) }
            .onDisappear { lease.close() }
    }

    private static func body(_ request: Request?) -> PrewarmBody? {
        guard let request else { return nil }
        return PrewarmBody(
            projectId: request.projectId, backendId: nil, backendProfileId: request.profileId,
            model: request.model, mode: request.mode, approval: request.approval, agentId: request.backend, claimId: nil
        )
    }
}
