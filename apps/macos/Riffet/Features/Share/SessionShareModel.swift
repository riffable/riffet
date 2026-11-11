import Foundation
import RiffetKit

enum SessionSharePurpose: String, Identifiable {
    case link, pdf
    var id: String { rawValue }
}

@MainActor
@Observable
final class SessionShareModel {
    private(set) var status: ShareStatus?
    private(set) var draft: ShareDraft?
    private(set) var turns: ShareTurnCatalog?
    private(set) var busy = false
    private(set) var generating = false
    private(set) var checking = true
    private(set) var loadingTurns = false
    private(set) var progress = ""
    private(set) var error = ""
    private(set) var turnsError = ""
    var previewReady = false
    var previewFailed = false
    var previewExpired = false
    var previewRevision = 0
    private(set) var purpose: SessionSharePurpose = .link
    var canPreview: Bool { api != nil && (purpose == .pdf || status?.actions.preview == true) }

    @ObservationIgnored private var api: RiffetApi?
    @ObservationIgnored private var sessionId = ""
    @ObservationIgnored private var lifetime = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var statusRead = 0
    @ObservationIgnored private var action: Task<Void, Never>?
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var turnRead: Task<Void, Never>?

    func connect(api: RiffetApi?, sessionId: String, purpose: SessionSharePurpose = .link) async {
        disconnect()
        self.api = api
        self.sessionId = sessionId
        self.purpose = purpose
        status = nil
        turns = nil
        checking = purpose == .link
        guard api != nil else {
            checking = false
            error = String(localized: "未连接")
            return
        }
        guard purpose == .link else { return }
        let epoch = lifetime
        await refresh()
        guard epoch == lifetime, !Task.isCancelled else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self, self.lifetime == epoch else { return }
                let activeOperation = self.status?.share?.operation.map { $0 != "uncertain" } ?? false
                if !self.busy, activeOperation || self.status?.blocker?.code == "SHARE_BUSY" {
                    await self.refresh()
                }
            }
        }
    }

    func disconnect() {
        lifetime += 1
        generation += 1
        action?.cancel()
        poll?.cancel()
        turnRead?.cancel()
        action = nil
        poll = nil
        turnRead = nil
        api = nil
        busy = false
        generating = false
        loadingTurns = false
        draft = nil
        previewReady = false
        previewFailed = false
        previewExpired = false
        error = ""
    }

    func refresh(fresh: Bool = false) async {
        guard purpose == .link, let api else { return }
        let epoch = lifetime
        statusRead += 1
        let read = statusRead
        do {
            let value = try await api.shareStatus(sessionId: sessionId, fresh: fresh)
            guard epoch == lifetime, read == statusRead, !Task.isCancelled else { return }
            status = value
            error = ""
        } catch {
            guard epoch == lifetime, read == statusRead, !Task.isCancelled else { return }
            self.error = (error.riffetStatus == 404 || error.riffetCode == "NOT_FOUND") ? String(localized: "分享服务暂不可用") : error.riffetMessage
        }
        if epoch == lifetime, read == statusRead { checking = false }
    }

    func loadTurns() {
        guard let api, !loadingTurns else { return }
        loadingTurns = true
        turnsError = ""
        let epoch = lifetime
        turnRead = Task {
            do {
                let value = try await api.shareTurns(sessionId: sessionId)
                guard epoch == lifetime, !Task.isCancelled else { return }
                turns = value
            } catch {
                guard epoch == lifetime, !Task.isCancelled else { return }
                turnsError = error.riffetMessage
            }
            if epoch == lifetime { loadingTurns = false }
        }
    }

    func clearDraft() {
        guard !busy else { return }
        draft = nil
        previewReady = false
        previewFailed = false
        previewExpired = false
    }

    /// A draft is bound to the publisher it was captured for, so changing the default drops it.
    func setDefaultPublisher(_ id: String) {
        guard let api, status?.share == nil, status?.capability.publisher?.id != id, !busy else { return }
        clearDraft()
        perform { _, _ in _ = try await api.setDefaultSharePublisher(id: id) }
    }

    func cancelGeneration() {
        generation += 1
        action?.cancel()
        action = nil
        busy = false
        generating = false
        progress = ""
        Task { await refresh() }
    }

    func generate(selection: ShareSelection, appearance: ShareAppearanceRequest, author: Bool) {
        guard let api, canPreview, !busy else { return }
        draft = nil
        previewReady = false
        previewFailed = false
        previewExpired = false
        generating = true
        perform { epoch, request in
            let body = ShareDraftRequest(selection: selection, appearance: appearance, author: author ? KotlinBoolean(bool: true) : nil)
            let progress: (ShareDraftProgress) -> Void = { stage in
                Task { @MainActor in
                    guard self.lifetime == epoch, self.generation == request else { return }
                    self.progress = Self.progressLabel(stage.stage)
                }
            }
            let value: ShareDraft
            if self.purpose == .pdf {
                value = try await api.sharePrintDraft(sessionId: self.sessionId, body: body, onProgress: progress)
            } else {
                value = try await api.shareDraft(sessionId: self.sessionId, body: body, onProgress: progress)
            }
            guard self.lifetime == epoch, self.generation == request, !Task.isCancelled else { return }
            self.draft = value
            self.previewRevision += 1
        }
    }

    func publish(days: Int) {
        guard let api, let draft, previewReady, status?.actions.publish == true, !busy else { return }
        perform { _, _ in _ = try await api.publishShare(sessionId: self.sessionId, draftId: draft.id, expiryDays: Int32(days)) }
    }

    func remove() {
        guard let api, let share = status?.share, status?.actions.remove == true, !busy else { return }
        perform { _, _ in _ = try await api.removeShare(id: share.id) }
    }

    func reconcile() {
        guard let api, let share = status?.share, status?.actions.reconcile == true, !busy else { return }
        perform { _, _ in _ = try await api.reconcileShare(id: share.id) }
    }

    func retry() {
        guard let api, let share = status?.share, status?.actions.retry == true, !busy else { return }
        perform { _, _ in _ = try await api.retryShare(id: share.id) }
    }

    private func perform(_ operation: @escaping @MainActor (Int, Int) async throws -> Void) {
        generation += 1
        statusRead += 1
        let request = generation
        let epoch = lifetime
        busy = true
        error = ""
        progress = ""
        action = Task {
            guard epoch == lifetime, request == generation, !Task.isCancelled else { return }
            do {
                try await operation(epoch, request)
            } catch {
                guard epoch == lifetime, request == generation, !Task.isCancelled else { return }
                self.error = error.riffetMessage
            }
            guard epoch == lifetime, request == generation, !Task.isCancelled else { return }
            let operationError = error
            await refresh()
            guard epoch == lifetime, request == generation, !Task.isCancelled else { return }
            busy = false
            generating = false
            progress = ""
            if error.isEmpty { error = operationError }
        }
    }

    private static func progressLabel(_ stage: String) -> String {
        switch stage {
        case "auth": String(localized: "正在检查登录…")
        case "history": String(localized: "正在读取会话…")
        case "resources": String(localized: "正在整理附件…")
        case "finalizing": String(localized: "正在完成预览…")
        default: String(localized: "正在准备预览…")
        }
    }
}
