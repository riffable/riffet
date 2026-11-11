import SwiftUI
import RiffetKit

/// Warms a CLI for the home page's choice, so the first message starts faster (`nativePrewarm` in
/// `ProjectHome.tsx`). Only once there is something to send, and only when the backend supports it;
/// each change of choice cancels the pending request, and a failure is silent: the send works either way.
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

    let workbench: Workbench
    let composer: ComposerModel
    /// Nil while there is no project or the backend does not warm up.
    let request: Request?

    private struct Trigger: Equatable {
        let request: Request?
        let hasDraft: Bool
    }

    var body: some View {
        // Read here rather than in the home page, so typing re-evaluates this view and not the page.
        let trigger = Trigger(request: request, hasDraft: !composer.text.isEmpty || !workbench.references.isEmpty)
        Color.clear
            .frame(width: 0, height: 0)
            .task(id: trigger) {
                guard trigger.hasDraft, let request = trigger.request, let api = workbench.host.api else { return }
                try? await Task.sleep(for: .milliseconds(700))
                guard !Task.isCancelled else { return }
                _ = try? await api.prewarm(body: PrewarmBody(
                    projectId: request.projectId, backendId: nil, backendProfileId: request.profileId,
                    model: request.model, mode: request.mode, approval: request.approval, agentId: request.backend
                ))
            }
    }
}
