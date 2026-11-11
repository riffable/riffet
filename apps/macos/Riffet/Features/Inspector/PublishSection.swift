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
        return String(localized: "安装 GitHub CLI（gh）后可创建 PR、查看 CI")
    case "GH_OPERATION_FAILED":
        let pattern = "auth|login|token|not a git|no git remotes|none of the git remotes"
        if error.riffetMessage.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil {
            return String(localized: "用 gh auth login 登录，或为仓库添加 GitHub 远端后可创建 PR")
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
    /// The open conversation of this project, for "让 Agent 修复 CI".
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

    private enum Action { case push, fix }

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
                    notice = PublishNotice(text: result.pullRequest.map { String(localized: "已创建 PR #\($0.number)") } ?? String(localized: "已创建 PR"), failed: false)
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
                    .help(expanded ? "收起" : "推送、PR 与合并")
            } else {
                HStack(spacing: Space.sm) {
                    Image(icon: "arrow.triangle.branch").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    Text(status?.branch ?? "—").font(.riffet(size: S(13), weight: .medium, design: .monospaced)).foregroundStyle(palette.fg).lineLimit(1)
                    worktreeBadge
                }
                .padding(.horizontal, 6)
            }
            Spacer(minLength: Space.sm)
            if let status {
                Text(status.entries.isEmpty ? "无改动" : "\(status.entries.count) 个文件").font(.riffet(size: S(12))).foregroundStyle(palette.fg4).lineLimit(1).fixedSize()
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
                Text(branch.upstream ?? (noRemote ? String(localized: "没有远端仓库") : String(localized: "尚未推送到远端")))
                    .font(.riffet(size: S(12), design: .monospaced))
                    .foregroundStyle(palette.fg3)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: Space.xs)
                if synced {
                    Text("已同步").font(.riffet(size: S(12))).foregroundStyle(palette.success)
                } else if branch.upstream != nil {
                    Text([branch.ahead > 0 ? String(localized: "领先 \(branch.ahead)") : "", branch.behind > 0 ? String(localized: "落后 \(branch.behind)") : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.fg3)
                }
            }
            if branch.behind > 0 {
                Text("远端有 \(branch.behind) 个新提交，推送前先在终端里同步。")
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            FlowLayout(spacing: Space.xs) {
                if !noRemote { pushControl(branch, remoteChoice: remoteChoice) }
                if !noRemote, pullUnavailable == nil {
                    if let pr = pullRequest {
                        Button { openLink(pr.url) } label: { actionLabel("arrow.up.right.square", String(localized: "打开 #\(pr.number)")) }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                    } else {
                        Button { showPullRequest = true } label: { actionLabel("arrow.triangle.pull", String(localized: "创建 PR")) }
                            .buttonStyle(SolidButtonStyle(kind: .secondary))
                            .disabled(busy != nil || pullLoading || branch.head == nil)
                    }
                }
                if project.worktree != nil {
                    Button { showMerge = true } label: { actionLabel("arrow.triangle.merge", String(localized: "合并到 \(into.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "原项目"))")) }
                        .buttonStyle(SolidButtonStyle(kind: .secondary))
                        .disabled(busy != nil)
                }
                if !noRemote, pullUnavailable == nil {
                    Button { Task { await refreshPull(explicit: true) } } label: {
                        if pullLoading { Spinner(size: .mini) } else { Image(icon: "arrow.clockwise").font(.riffet(size: S(12))) }
                    }
                    .buttonStyle(IconButtonStyle())
                    .help("刷新 PR 状态")
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
            Text(title).lineLimit(1)
        }
    }

    @ViewBuilder
    private func pushControl(_ branch: BranchInfo, remoteChoice: Bool) -> some View {
        if remoteChoice {
            ChoiceMenu(options: branch.remotes.map { remote in ChoiceOption(title: remote, selected: false) { Task { await push(remote) } } }) {
                pushLabel(String(localized: "推送到…"))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 28)
                    .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgElevated))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
                    .opacity(busy == nil ? 1 : 0.5)
            }
            .disabled(busy != nil)
        } else {
            Button { Task { await push(nil) } } label: { pushLabel(branch.upstream != nil ? String(localized: "推送") : String(localized: "发布分支")) }
                .buttonStyle(SolidButtonStyle(kind: .secondary))
                .disabled(busy != nil || branch.head == nil || (branch.upstream != nil && branch.ahead == 0))
                .help(branch.upstream != nil && branch.ahead == 0 ? "没有可推送的提交" : "推送当前分支")
        }
    }

    private func pushLabel(_ title: String) -> some View {
        HStack(spacing: 5) {
            if busy == .push { Spinner(size: .mini) } else { Image(icon: "arrow.up.to.line").font(.riffet(size: S(12))) }
            Text(title).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
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
                case "MERGED": GitMetaBadge(text: String(localized: "已合并"), tint: palette.accent)
                case "CLOSED": GitMetaBadge(text: String(localized: "已关闭"), tint: palette.danger)
                default: GitMetaBadge(text: pr.isDraft ? String(localized: "草稿") : String(localized: "开放"), tint: pr.isDraft ? palette.fg3 : palette.success)
                }
                if pr.state == "OPEN", let review = pr.reviewDecision, let label = reviewLabel(review) {
                    GitMetaBadge(text: label.text, tint: label.tint)
                }
                if pr.mergeable == "CONFLICTING" { GitMetaBadge(text: String(localized: "有冲突"), tint: palette.danger) }
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
                        Text("检查 \(passed)/\(items.count) 通过\(running > 0 ? String(localized: " · \(running) 运行中") : "")\(failed > 0 ? String(localized: " · \(failed) 失败") : "")")
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
                            Text("另 \(items.count - 40) 项").font(.riffet(size: S(11))).foregroundStyle(palette.fg4).padding(.horizontal, 4)
                        }
                    }
                }
            }
            if failed > 0, pr.state == "OPEN" {
                Button { Task { await fixChecks(pr) } } label: {
                    HStack(spacing: 5) {
                        if busy == .fix { Spinner(size: .mini) } else { Image(icon: "sparkles").font(.riffet(size: S(12))) }
                        Text("让 Agent 修复")
                    }
                }
                .buttonStyle(ChipButtonStyle())
                .disabled(sessionId == nil || busy != nil)
                .help(sessionId == nil ? "打开这个项目的一个会话后可用" : "把失败的检查发给当前会话")
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
        case "APPROVED": (String(localized: "已批准"), palette.success)
        case "CHANGES_REQUESTED": (String(localized: "需要修改"), palette.danger)
        case "REVIEW_REQUIRED": (String(localized: "待审阅"), palette.warning)
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
                if expanded || explicit { notice = PublishNotice(text: String(localized: "无法读取 PR 状态"), failed: true, details: error.riffetMessage) }
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
            notice = PublishNotice(text: String(localized: "已推送到 \(result.branch.upstream ?? remote ?? String(localized: "远端"))"), failed: false)
            busy = nil
            await refreshPull(force: true)
        } catch {
            let message = error.riffetMessage
            let rejected = message.range(of: "non-fast-forward|rejected|fetch first", options: [.regularExpression, .caseInsensitive]) != nil
            notice = PublishNotice(text: rejected ? String(localized: "远端有新提交，请先 pull 或 rebase。") : String(localized: "推送失败"), failed: true, details: message)
            busy = nil
        }
    }

    /// The failed checks, phrased as one message to the open conversation (the web does the same).
    private func fixChecks(_ pr: PullRequestInfo) async {
        guard sessionId != nil, busy == nil else { return }
        busy = .fix
        notice = nil
        let failed = pr.checks.items.filter { $0.state == "failure" }
        let lines = failed.map { item in "- \(item.name)\(item.url.flatMap { $0.isEmpty ? nil : "：\($0)" } ?? "")" } // i18n-ignore: 发给 Agent 的消息正文
        let text = (["PR #\(pr.number) 的 CI 检查失败了，请定位原因并修复："] + lines + ["", "可以用 `gh pr checks` 和 `gh run view --log-failed` 读取失败日志。修好后在本地跑一遍相关检查，再告诉我结果。"]).joined(separator: "\n") // i18n-ignore: 发给 Agent 的消息正文
        let sent = await workbench.send(text, attachments: [])
        notice = PublishNotice(text: sent ? String(localized: "已让 Agent 修复 CI") : String(localized: "无法发送给 Agent"), failed: !sent)
        busy = nil
    }
}

func mergeSummary(_ result: MergeResult) -> String {
    result.merged
        ? String(localized: "已把 \(result.commits) 个提交\(result.strategy == "squash" ? String(localized: "压缩") : "")合并到 \(result.into)")
        : String(localized: "\(result.into) 已包含这个分支的全部提交")
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
                Text("创建 Pull Request").font(.riffet(size: S(15), weight: .semibold))
                Text("\(!branch.upstream.isNilOrEmpty && branch.ahead == 0 ? String(localized: "从 \(branch.branch) 发起。") : String(localized: "会先把 \(branch.branch) 推送到远端。"))标题留空时用提交记录自动填写。")
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            field(String(localized: "标题")) { GitField(placeholder: String(localized: "自动填写"), text: $title) }
            field(String(localized: "描述")) { GitTextArea(placeholder: trimmedTitle.isEmpty ? String(localized: "填写标题后可编辑") : String(localized: "可选"), text: $text, lines: 3...8).disabled(trimmedTitle.isEmpty) }
            HStack(alignment: .bottom, spacing: Space.md) {
                field(String(localized: "目标分支")) { GitField(placeholder: String(localized: "仓库默认分支"), text: $base) }
                Toggle("草稿", isOn: $draft).toggleStyle(.switch).controlSize(.small).fixedSize().padding(.bottom, 4)
            }
            if let error { GitInlineError(message: error, summary: errorSummary).clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous)) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(SolidButtonStyle(kind: .secondary)).disabled(busy)
                Button { Task { await submit() } } label: {
                    HStack(spacing: 5) {
                        if busy { Spinner(size: .mini) }
                        Text("创建")
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
            errorSummary = githubSetupHint(error) ?? String(localized: "无法创建 PR")
            self.error = error.riffetMessage
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

    private var target: String { into.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "原项目的当前分支") }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text("合并到 \(target)").font(.riffet(size: S(15), weight: .semibold))
                Text("把 \(worktreeBranchLabel(branch)) 合并进原项目。遇到冲突会整体放弃，不会在原项目里留下半合并的文件。")
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SegmentedTrack(selection: $strategy) {
                Text("压缩为一个提交").tag("squash")
                Text("保留全部提交").tag("merge")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("提交说明").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg3)
                GitField(placeholder: strategy == "squash" ? "Squash \(branch)" : "Merge \(branch) into \(into ?? "…")", text: $message)
            }
            if dirty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("未提交的改动").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg3)
                    GitField(placeholder: "WIP on \(branch)", text: $pending)
                    Text("Worktree 里还有未提交的改动，会先用这条说明提交。").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
            }
            Toggle(isOn: $remove) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("合并后移除 Worktree").font(.riffet(size: S(13))).foregroundStyle(palette.fg)
                    Text("分支会保留；这个目录对应的项目会被归档，并回到原项目。").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            if let conflicts {
                VStack(alignment: .leading, spacing: 4) {
                    Text("有冲突，已放弃合并").font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.danger)
                    Text("可以让 Agent 在 Worktree 里先合入 \(target) 并解决冲突，再回来合并。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    ForEach(conflicts.prefix(8), id: \.self) { path in
                        Text(path).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg2).lineLimit(1).truncationMode(.middle)
                    }
                    if conflicts.count > 8 { Text("另 \(conflicts.count - 8) 个文件").font(.riffet(size: S(12))).foregroundStyle(palette.fg4) }
                }
                .padding(Space.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
            }
            if let error { GitInlineError(message: error, summary: errorSummary).clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous)) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(SolidButtonStyle(kind: .secondary)).disabled(busy)
                Button { Task { await submit() } } label: {
                    HStack(spacing: 5) {
                        if busy { Spinner(size: .mini) }
                        Text("合并")
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
                errorSummary = String(localized: "\(target) 有未提交的改动，先在原项目里提交或暂存它们")
                self.error = error.riffetMessage
            default:
                errorSummary = dirty ? String(localized: "合并失败，可能已提交 Worktree 中的改动。") : String(localized: "合并失败")
                self.error = error.riffetMessage
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
