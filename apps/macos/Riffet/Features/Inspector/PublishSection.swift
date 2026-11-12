import SwiftUI
import RiffetKit

/// What the section last reported, in the colour of how it went.
private struct PublishNotice: Equatable {
    let text: String
    let failed: Bool
    var details: String?
}

/// gh being absent or signed out is a setup state, not an error worth reporting each time the panel opens.
func githubSetupHint(_ error: Error) -> String? {
    switch error.riffetCode {
    case "GH_UNAVAILABLE":
        return "Install the GitHub CLI (gh) to create PRs and see CI"
    case "GH_OPERATION_FAILED":
        let pattern = "auth|login|token|not a git|no git remotes|none of the git remotes"
        if gitMessage(error).range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil {
            return "Run gh auth login, or add a GitHub remote, to create PRs"
        }
        return nil
    default:
        return nil
    }
}

private func openLink(_ raw: String) {
    guard let url = URL(string: raw), url.scheme == "http" || url.scheme == "https" else { return }
    NSWorkspace.shared.open(url)
}

/// The branch row of the changes page, which opens into where the work goes next: push, the pull
/// request with its checks, and, in an isolated copy, merging back into the project it was cut from.
/// Folded by default so the file list stays the first thing the panel is for; the folded row still
/// carries the sync count and the PR number.
struct PublishSection: View {
    let workbench: Workbench
    let project: Project
    /// The project's status; the branch's sync count follows its revision. It also keeps the branch
    /// and pull request read last, so a reopened panel shows them while it asks again.
    let git: GitStatusModel
    /// The open conversation of this project, for "Ask Agent to Fix".
    let sessionId: String?
    /// A worktree's branch landed in the project it was cut from; `removed` when the copy is gone.
    let onMerged: (_ originProjectId: String, _ removed: Bool) -> Void

    @Environment(\.palette) private var palette
    @Environment(\.inspectorPanelVisible) private var visible
    @State private var pullLoading = false
    @State private var expanded = false
    @State private var checksOpen = false
    @State private var busy: Action?
    @State private var notice: PublishNotice?
    @State private var into: String?
    @State private var showPullRequest = false
    @State private var showMerge = false

    private enum Action { case push, pull, fix }

    private var pending: Bool { pullRequest?.checks.state == "pending" }

    private var status: GitStatus? { git.status }
    private var branch: BranchInfo? {
        get { git.branch }
        nonmutating set { git.branch = newValue }
    }
    private var pullRequest: PullRequestInfo? {
        get { git.pullRequest }
        nonmutating set { git.pullRequest = newValue }
    }
    private var pullUnavailable: String? {
        get { git.pullUnavailable }
        nonmutating set { git.pullUnavailable = newValue }
    }
    /// The pull request is asked for again on its own only once this long has passed.
    private static let pullFreshness: TimeInterval = 30

    var body: some View {
        VStack(spacing: 0) {
            header
            if expanded, let branch { details(branch) }
        }
        .task(id: "\(project.id)|\(git.revision)") { await refreshBranch() }
        // The PR asks GitHub, so only once the branch is published. A failed request leaves no PR data and
        // is retried only by an explicit refresh or a branch change, not by watching for the absence.
        .task(id: "\(project.id)|\(branch?.branch ?? "")|\(branch?.upstream ?? "")") {
            if branch?.upstream != nil {
                await refreshPull()
            } else {
                if pullRequest != nil { pullRequest = nil }
                if pullUnavailable != nil { pullUnavailable = nil }
                pullLoading = false
            }
        }
        // Checks still running are worth watching while someone has the section open and on screen.
        .task(id: "\(project.id)|\(expanded)|\(pending)|\(visible)") {
            guard expanded, pending, visible else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled else { return }
                await refreshPull(force: true)
            }
        }
        .task(id: "\(expanded)|\(project.worktree?.originProjectId ?? "")") {
            guard expanded, let origin = project.worktree?.originProjectId, into == nil, let api = workbench.host.api else { return }
            let name = (try? await api.gitBranch(projectId: origin))?.branch
            guard !Task.isCancelled else { return }
            into = name ?? ""
        }
        .sheet(isPresented: $showPullRequest) {
            if let branch {
                PullRequestSheet(workbench: workbench, projectId: project.id, branch: branch) { result in
                    pullRequest = result.pullRequest
                    pullUnavailable = nil
                    self.branch = result.branch
                    expanded = true
                    notice = PublishNotice(text: result.pullRequest.map { "Created PR #\($0.number)" } ?? "Created PR", failed: false)
                }
            }
        }
        .sheet(isPresented: $showMerge) {
            if let worktree = project.worktree {
                MergeWorktreeSheet(workbench: workbench, projectId: project.id, branch: worktree.branch, into: into, dirty: status?.entries.isEmpty == false) { result in
                    let removed = result.removedWorktree?.boolValue == true
                    if !removed {
                        notice = PublishNotice(text: mergeSummary(result), failed: false)
                        Task { await refreshBranch() }
                    }
                    onMerged(worktree.originProjectId, removed)
                }
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Space.sm) {
            if let branch {
                Button { expanded.toggle() } label: { headerLabel(branch) }
                    .buttonStyle(HoverRowStyle())
                    .help(expanded ? plain("Collapse") : plain("Push, PR and merge"))
            } else {
                HStack(spacing: Space.sm) {
                    Image(icon: "arrow.triangle.branch").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    Text(status?.branch ?? "—").font(.riffet(size: S(13), weight: .medium, design: .monospaced)).foregroundStyle(palette.fg).lineLimit(1)
                    worktreeBadge
                }
                .padding(.horizontal, 6)
            }
            Spacer(minLength: Space.sm)
            if let branch, branch.behind > 0 {
                Button { Task { await pull() } } label: {
                    HStack(spacing: 4) {
                        if busy == .pull { Spinner(size: .mini) }
                        Text(verbatim: GitCopy.pull)
                    }
                }
                .buttonStyle(ChipButtonStyle())
                .disabled(busy != nil)
            } else if let status {
                Text(verbatim: status.entries.isEmpty ? "No changes" : GitCopy.files(status.entries.count)).font(.riffet(size: S(12))).foregroundStyle(palette.fg4).lineLimit(1).fixedSize()
                DiffCounts(added: status.added?.int64Value, removed: status.removed?.int64Value)
            }
        }
        .padding(.leading, Space.sm)
        .padding(.trailing, Space.sm)
        .frame(height: 40)
    }

    private func headerLabel(_ branch: BranchInfo) -> some View {
        HStack(spacing: 5) {
            Image(icon: "chevron.right")
                .font(.riffet(size: S(9), weight: .semibold))
                .foregroundStyle(palette.fg4)
                .rotationEffect(.degrees(expanded ? 90 : 0))
            Image(icon: "arrow.triangle.branch").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
            Text(branch.branch).font(.riffet(size: S(13), weight: .medium, design: .monospaced)).foregroundStyle(palette.fg).lineLimit(1)
            if branch.ahead > 0 {
                Label("\(branch.ahead)", icon: "arrow.up")
                    .labelStyle(.titleAndIcon)
                    .font(.riffet(size: S(11), design: .monospaced))
                    .foregroundStyle(palette.fg2)
                    .fixedSize()
            }
            if branch.behind > 0 {
                Label("\(branch.behind)", icon: "arrow.down")
                    .labelStyle(.titleAndIcon)
                    .font(.riffet(size: S(11), design: .monospaced))
                    .foregroundStyle(palette.warning)
                    .fixedSize()
            }
            if let pr = pullRequest {
                HStack(spacing: 4) {
                    if pr.state == "MERGED" {
                        Image(icon: "arrow.triangle.merge").font(.riffet(size: S(10))).foregroundStyle(palette.accent)
                    } else {
                        Circle().fill(checkTint(pr.checks.state)).frame(width: 6, height: 6)
                    }
                    Text("#\(pr.number)").font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(palette.fg2)
                }
                .padding(.horizontal, 5)
                .frame(height: 18)
                .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .fixedSize()
            }
            worktreeBadge
        }
        .padding(.horizontal, 6)
        .frame(height: 28)
    }

    @ViewBuilder
    private var worktreeBadge: some View {
        if project.worktree != nil {
            GitMetaBadge(text: "Worktree", tint: palette.accent)
                .help("\(worktreeBranchLabel(project.worktree?.branch))\n\(tildePath(path: project.cwd))")
                .fixedSize()
        }
    }

    // MARK: Details

    private func details(_ branch: BranchInfo) -> some View {
        let noRemote = branch.remotes.isEmpty
        let synced = branch.upstream != nil && branch.ahead == 0 && branch.behind == 0
        // Without an upstream git needs to be told where; `origin` or a lone remote is the obvious answer.
        let remoteChoice = branch.upstream == nil && branch.remotes.count > 1 && !branch.remotes.contains("origin")
        return VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                Text(verbatim: branch.upstream ?? (noRemote ? "No remote" : "Not published"))
                    .font(.riffet(size: S(12), design: .monospaced))
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: Space.xs)
                if synced {
                    Text(verbatim: "Up to date").font(.riffet(size: S(12))).foregroundStyle(palette.success)
                } else if branch.upstream != nil {
                    Text(verbatim: [branch.ahead > 0 ? "\(branch.ahead) ahead" : "", branch.behind > 0 ? "\(branch.behind) behind" : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.fg3)
                }
            }
            FlowLayout(spacing: Space.xs) {
                if !noRemote { pushControl(branch, remoteChoice: remoteChoice) }
                if !noRemote, pullUnavailable == nil {
                    if let pr = pullRequest {
                        Button { openLink(pr.url) } label: { actionLabel("arrow.up.right.square", "Open #\(pr.number)") }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                    } else {
                        Button { showPullRequest = true } label: { actionLabel("arrow.triangle.pull", "Create PR") }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                            .disabled(busy != nil || pullLoading || branch.head == nil)
                    }
                }
                if project.worktree != nil {
                    Button { showMerge = true } label: { actionLabel("arrow.triangle.merge", "Merge into \(into.flatMap { $0.isEmpty ? nil : $0 } ?? "origin")") }
                        .buttonStyle(SolidButtonStyle(kind: .secondary))
                        .disabled(busy != nil)
                }
                if !noRemote, pullUnavailable == nil {
                    Button { Task { await refreshPull(explicit: true) } } label: {
                        if pullLoading { Spinner(size: .mini) } else { Image(icon: "arrow.clockwise").font(.riffet(size: S(12))) }
                    }
                    .buttonStyle(IconButtonStyle())
                    .help(plain("Refresh PR status"))
                    .disabled(pullLoading)
                }
            }
            if let pullUnavailable {
                Text(pullUnavailable).font(.riffet(size: S(12))).foregroundStyle(palette.fg4).fixedSize(horizontal: false, vertical: true)
            }
            if let notice {
                if notice.failed, let details = notice.details {
                    GitInlineError(message: details, summary: notice.text)
                } else {
                    Text(notice.text)
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(notice.failed ? palette.danger : palette.success)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            if let pr = pullRequest { pullRequestCard(pr) }
        }
        .padding(Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
        .padding(.horizontal, Space.sm)
        .padding(.bottom, Space.sm)
    }

    private func actionLabel(_ symbol: String, _ title: String) -> some View {
        HStack(spacing: 5) {
            Image(icon: symbol).font(.riffet(size: S(12)))
            Text(verbatim: title).lineLimit(1)
        }
    }

    @ViewBuilder
    private func pushControl(_ branch: BranchInfo, remoteChoice: Bool) -> some View {
        if remoteChoice {
            ChoiceMenu(options: branch.remotes.map { remote in ChoiceOption(title: remote, selected: false) { Task { await push(remote) } } }) {
                pushLabel(GitCopy.pushTo)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 28)
                    .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgElevated))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
                    .opacity(busy == nil ? 1 : 0.5)
            }
            .disabled(busy != nil)
        } else {
            Button { Task { await push(nil) } } label: { pushLabel(branch.upstream != nil ? GitCopy.push : "Publish Branch") }
                .buttonStyle(SolidButtonStyle(kind: .secondary))
                .disabled(busy != nil || branch.head == nil || (branch.upstream != nil && branch.ahead == 0))
                .help(branch.upstream != nil && branch.ahead == 0 ? plain("Nothing to push") : plain("Push the current branch"))
        }
    }

    private func pushLabel(_ title: String) -> some View {
        HStack(spacing: 5) {
            if busy == .push { Spinner(size: .mini) } else { Image(icon: "arrow.up.to.line").font(.riffet(size: S(12))) }
            Text(verbatim: title).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
        }
    }

    private func pullRequestCard(_ pr: PullRequestInfo) -> some View {
        let items = pr.checks.items
        let passed = items.filter { $0.state == "success" }.count
        let failed = items.filter { $0.state == "failure" }.count
        let running = items.filter { $0.state == "pending" }.count
        return VStack(alignment: .leading, spacing: Space.sm) {
            Button { openLink(pr.url) } label: {
                Text(pr.title)
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .help(pr.url)
            FlowLayout(spacing: 5) {
                switch pr.state {
                case "MERGED": GitMetaBadge(text: "Merged", tint: palette.accent)
                case "CLOSED": GitMetaBadge(text: "Closed", tint: palette.danger)
                default: GitMetaBadge(text: pr.isDraft ? "Draft" : "Open", tint: pr.isDraft ? palette.fg3 : palette.success)
                }
                if pr.state == "OPEN", let review = pr.reviewDecision, let label = reviewLabel(review) {
                    GitMetaBadge(text: label.text, tint: label.tint)
                }
                if pr.mergeable == "CONFLICTING" { GitMetaBadge(text: "Conflicts", tint: palette.danger) }
            }
            Text("\(pr.baseRefName) ← \(pr.headRefName)")
                .font(.riffet(size: S(11), design: .monospaced))
                .foregroundStyle(palette.fg4)
                .lineLimit(1)
                .truncationMode(.middle)
            if pr.checks.state != "none" {
                Button { checksOpen.toggle() } label: {
                    HStack(spacing: 6) {
                        Circle().fill(checkTint(pr.checks.state)).frame(width: 6, height: 6)
                        Text(verbatim: "Checks \(passed)/\(items.count) passed\(running > 0 ? " · \(running) running" : "")\(failed > 0 ? " · \(failed) failed" : "")")
                            .font(.riffet(size: S(12)))
                            .foregroundStyle(palette.fg2)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Image(icon: "chevron.right")
                            .font(.riffet(size: S(9), weight: .semibold))
                            .foregroundStyle(palette.fg4)
                            .rotationEffect(.degrees(checksOpen ? 90 : 0))
                    }
                    .padding(.horizontal, 4)
                    .frame(height: 24)
                }
                .buttonStyle(HoverRowStyle())
                if checksOpen {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(items.prefix(40).enumerated()), id: \.offset) { _, item in
                            HStack(spacing: 6) {
                                checkIcon(item.state)
                                if let url = item.url, !url.isEmpty {
                                    Button { openLink(url) } label: { Text(item.name).lineLimit(1).truncationMode(.tail) }
                                        .buttonStyle(.plain)
                                        .help(url)
                                } else {
                                    Text(item.name).lineLimit(1).truncationMode(.tail)
                                }
                                Spacer(minLength: 0)
                            }
                            .font(.riffet(size: S(12)))
                            .foregroundStyle(palette.fg2)
                            .frame(height: 22)
                            .padding(.horizontal, 4)
                        }
                        if items.count > 40 {
                            Text(verbatim: "\(items.count - 40) more").font(.riffet(size: S(11))).foregroundStyle(palette.fg4).padding(.horizontal, 4)
                        }
                    }
                }
            }
            if failed > 0, pr.state == "OPEN" {
                Button { Task { await fixChecks(pr) } } label: {
                    HStack(spacing: 5) {
                        if busy == .fix { Spinner(size: .mini) } else { Image(icon: "sparkles").font(.riffet(size: S(12))) }
                        Text(verbatim: "Ask Agent to Fix")
                    }
                }
                .buttonStyle(ChipButtonStyle())
                .disabled(sessionId == nil || busy != nil)
                .help(sessionId == nil ? plain("Open a conversation of this project first") : plain("Send the failed checks to the current conversation"))
            }
        }
        .padding(Space.sm + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
    }

    @ViewBuilder
    private func checkIcon(_ state: String) -> some View {
        switch state {
        case "success": Image(icon: "checkmark").font(.riffet(size: S(10), weight: .bold)).foregroundStyle(palette.success).frame(width: 12)
        case "failure": Image(icon: "xmark").font(.riffet(size: S(10), weight: .bold)).foregroundStyle(palette.danger).frame(width: 12)
        case "pending": Spinner(size: .mini).frame(width: 12)
        default: Image(icon: "circle.dashed").font(.riffet(size: S(10))).foregroundStyle(palette.fg4).frame(width: 12)
        }
    }

    private func checkTint(_ state: String) -> Color {
        switch state {
        case "success": palette.success
        case "failure": palette.danger
        case "pending": palette.warning
        default: palette.fg4
        }
    }

    private func reviewLabel(_ decision: String) -> (text: String, tint: Color)? {
        switch decision {
        case "APPROVED": ("Approved", palette.success)
        case "CHANGES_REQUESTED": ("Changes requested", palette.danger)
        case "REVIEW_REQUIRED": ("Review required", palette.warning)
        default: nil
        }
    }

    // MARK: Actions

    private func refreshBranch() async {
        guard let api = workbench.host.api else { return }
        do {
            let info = try await api.gitBranch(projectId: project.id)
            guard !Task.isCancelled else { return }
            if branch != info { branch = info }
        } catch {
            guard !Task.isCancelled else { return }
            if branch != nil { branch = nil }
        }
    }

    /// Asks GitHub about the branch's PR. Unless `explicit` or `force`, a reading of the same branch
    /// and upstream from the last `pullFreshness` seconds stands.
    private func refreshPull(explicit: Bool = false, force: Bool = false) async {
        guard let api = workbench.host.api else { return }
        let key = "\(branch?.branch ?? "")|\(branch?.upstream ?? "")"
        if !explicit, !force, let checked = git.pullChecked, checked.key == key,
           Date.now.timeIntervalSince(checked.at) < Self.pullFreshness {
            return
        }
        pullLoading = true
        defer { pullLoading = false }
        do {
            let result = try await api.pullRequest(projectId: project.id)
            guard !Task.isCancelled else { return }
            if pullRequest != result.pullRequest { pullRequest = result.pullRequest }
            if pullUnavailable != nil { pullUnavailable = nil }
            if branch != result.branch { branch = result.branch }
            git.pullChecked = ("\(result.branch.branch)|\(result.branch.upstream ?? "")", .now)
        } catch {
            guard !Task.isCancelled else { return }
            git.pullChecked = (key, .now)
            if pullRequest != nil { pullRequest = nil }
            if let hint = githubSetupHint(error) {
                pullUnavailable = hint
            } else {
                pullUnavailable = nil
                if expanded || explicit { notice = PublishNotice(text: "Couldn't read PR status", failed: true, details: gitMessage(error)) }
            }
        }
    }

    private func push(_ remote: String?) async {
        guard let api = workbench.host.api, busy == nil else { return }
        busy = .push
        notice = nil
        do {
            let result = try await api.gitPush(projectId: project.id, remote: remote)
            branch = result.branch
            notice = PublishNotice(text: "Pushed to \(result.branch.upstream ?? remote ?? "remote")", failed: false)
            busy = nil
            await refreshPull(force: true)
        } catch {
            let message = gitMessage(error)
            let rejected = message.range(of: "non-fast-forward|rejected|fetch first", options: [.regularExpression, .caseInsensitive]) != nil
            notice = PublishNotice(text: rejected ? GitCopy.pullDiverged : "Push failed", failed: true, details: message)
            busy = nil
        }
    }

    private func pull() async {
        guard let api = workbench.host.api, busy == nil else { return }
        busy = .pull
        notice = nil
        do {
            let result = try await api.gitPull(projectId: project.id)
            branch = result.branch
            git.apply(result.status, force: true)
        } catch {
            expanded = true
            if let message = gitErrorMessage(error) {
                notice = PublishNotice(text: message, failed: true)
            } else {
                notice = PublishNotice(text: "Pull failed", failed: true, details: gitMessage(error))
            }
        }
        busy = nil
    }

    /// The failed checks, phrased as one message to the open conversation (the web does the same).
    private func fixChecks(_ pr: PullRequestInfo) async {
        guard sessionId != nil, busy == nil else { return }
        busy = .fix
        notice = nil
        let failed = pr.checks.items.filter { $0.state == "failure" }
        let lines = failed.map { item in "- \(item.name)\(item.url.flatMap { $0.isEmpty ? nil : ": \($0)" } ?? "")" }
        let text = (["CI checks failed on PR #\(pr.number). Find the cause and fix it:"] + lines + ["", "You can read the failure logs with `gh pr checks` and `gh run view --log-failed`. After fixing, run the related checks locally and tell me the result."]).joined(separator: "\n")
        let sent = await workbench.send(text, attachments: [])
        notice = PublishNotice(text: sent ? "Sent to the Agent" : "Couldn't send to the Agent", failed: !sent)
        busy = nil
    }
}

func mergeSummary(_ result: MergeResult) -> String {
    result.merged
        ? "Merged \(result.commits == 1 ? "1 commit" : "\(result.commits) commits")\(result.strategy == "squash" ? " (squashed)" : "") into \(result.into)"
        : "\(result.into) already has every commit of this branch"
}

// MARK: Pull request sheet

private struct PullRequestSheet: View {
    let workbench: Workbench
    let projectId: String
    let branch: BranchInfo
    let created: (PullRequestStatus) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var title = ""
    @State private var text = ""
    @State private var base = ""
    @State private var draft = false
    @State private var busy = false
    @State private var error: String?
    @State private var errorSummary: String?

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: "Create Pull Request").font(.riffet(size: S(15), weight: .semibold))
                Text(verbatim: !branch.upstream.isNilOrEmpty && branch.ahead == 0 ? "From \(branch.branch)." : "\(branch.branch) is pushed first.")
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            field("Title") { GitField(placeholder: "Filled in from the commits", text: $title) }
            field("Description") { GitTextArea(placeholder: trimmedTitle.isEmpty ? "Add a title first" : "Optional", text: $text, lines: 3...8).disabled(trimmedTitle.isEmpty) }
            HStack(alignment: .bottom, spacing: Space.md) {
                field("Base") { GitField(placeholder: "Default branch", text: $base) }
                Toggle(isOn: $draft) { Text(verbatim: "Draft") }.toggleStyle(.switch).controlSize(.small).fixedSize().padding(.bottom, 4)
            }
            if let error { GitInlineError(message: error, summary: errorSummary).clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous)) }
            HStack {
                Spacer()
                Button(GitCopy.cancel) { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(SolidButtonStyle(kind: .secondary)).disabled(busy)
                Button { Task { await submit() } } label: {
                    HStack(spacing: 5) {
                        if busy { Spinner(size: .mini) }
                        Text(verbatim: "Create")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(SolidButtonStyle(kind: .primary))
                .disabled(busy)
            }
        }
        .padding(Space.xl)
        .frame(width: 440)
        .interactiveDismissDisabled(busy)
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg3)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func submit() async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        error = nil
        errorSummary = nil
        let target = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = CreatePullRequestBody(
            title: trimmedTitle.isEmpty ? nil : trimmedTitle,
            body: trimmedTitle.isEmpty ? nil : text,
            base: target.isEmpty ? nil : target,
            draft: KotlinBoolean(bool: draft),
            remote: nil
        )
        do {
            let result = try await api.createPullRequest(projectId: projectId, body: body)
            dismiss()
            created(result)
        } catch {
            errorSummary = githubSetupHint(error) ?? "Couldn't create PR"
            self.error = gitMessage(error)
        }
        busy = false
    }
}

private extension Optional where Wrapped == String {
    var isNilOrEmpty: Bool { self?.isEmpty ?? true }
}

// MARK: Merge sheet

/// Merging an isolated copy's branch back into the branch its origin project has checked out.
private struct MergeWorktreeSheet: View {
    let workbench: Workbench
    let projectId: String
    let branch: String
    let into: String?
    /// The copy has uncommitted changes, which are committed first under [pending].
    let dirty: Bool
    let merged: (MergeResult) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var strategy = "squash"
    @State private var message = ""
    @State private var pending = ""
    @State private var remove = false
    @State private var busy = false
    @State private var error: String?
    @State private var errorSummary: String?
    @State private var conflicts: [String]?

    private var target: String { into.flatMap { $0.isEmpty ? nil : $0 } ?? "the origin's current branch" }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: "Merge into \(target)").font(.riffet(size: S(15), weight: .semibold))
                Text(verbatim: "Merges \(worktreeBranchLabel(branch)) into the origin project. A conflict abandons the whole merge.")
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SegmentedTrack(selection: $strategy) {
                Text(verbatim: "Squash into one commit").tag("squash")
                Text(verbatim: "Keep all commits").tag("merge")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: "Commit message").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg3)
                GitField(placeholder: strategy == "squash" ? "Squash \(branch)" : "Merge \(branch) into \(into ?? "…")", text: $message)
            }
            if dirty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: "Uncommitted changes").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg3)
                    GitField(placeholder: "WIP on \(branch)", text: $pending)
                    Text(verbatim: "Committed first with this message.").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
            }
            Toggle(isOn: $remove) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: "Remove the worktree after merging").font(.riffet(size: S(13))).foregroundStyle(palette.fg)
                    Text(verbatim: "The branch is kept; the project of this directory is archived.").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            if let conflicts {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: "Conflicts, merge abandoned").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.danger)
                    Text(verbatim: "Have the Agent merge \(target) into the worktree and resolve the conflicts first.").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    ForEach(conflicts.prefix(8), id: \.self) { path in
                        Text(path).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg2).lineLimit(1).truncationMode(.middle)
                    }
                    if conflicts.count > 8 { Text(verbatim: GitCopy.moreFiles(conflicts.count - 8)).font(.riffet(size: S(12))).foregroundStyle(palette.fg4) }
                }
                .padding(Space.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
            }
            if let error { GitInlineError(message: error, summary: errorSummary).clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous)) }
            HStack {
                Spacer()
                Button(GitCopy.cancel) { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(SolidButtonStyle(kind: .secondary)).disabled(busy)
                Button { Task { await submit() } } label: {
                    HStack(spacing: 5) {
                        if busy { Spinner(size: .mini) }
                        Text(verbatim: "Merge")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(SolidButtonStyle(kind: .primary))
                .disabled(busy)
            }
        }
        .padding(Space.xl)
        .frame(width: 440)
        .interactiveDismissDisabled(busy)
    }

    private func submit() async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        error = nil
        errorSummary = nil
        conflicts = nil
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let wip = pending.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = MergeBody(
            strategy: strategy,
            message: text.isEmpty ? nil : text,
            commitPending: dirty ? (wip.isEmpty ? "WIP on \(branch)" : wip) : nil,
            removeWorktree: remove
        )
        do {
            let result = try await api.mergeWorktree(projectId: projectId, body: body)
            dismiss()
            merged(result)
        } catch {
            switch error.riffetCode {
            case "MERGE_CONFLICT": conflicts = Self.conflictPaths(error)
            case "MERGE_TARGET_DIRTY":
                errorSummary = "\(target) has uncommitted changes. Commit or stash them in the origin project first."
                self.error = gitMessage(error)
            default:
                errorSummary = dirty ? "Merge failed. The worktree's changes may have been committed." : "Merge failed"
                self.error = gitMessage(error)
            }
        }
        busy = false
    }

    /// `details.paths` of the server's conflict error, read from the details' JSON text.
    private static func conflictPaths(_ error: Error) -> [String] {
        guard let details = riffetHTTP(error)?.details,
              let data = String(describing: details).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        return object["paths"] as? [String] ?? []
    }
}
