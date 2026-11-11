import SwiftUI

struct ConversationView: View {
    @Environment(DemoStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showingDetails = false
    @State private var readingAnchor: UUID?
    @State private var didRestorePosition = false
    @State private var userHasScrolled = false
    @State private var isAtBottom = true
    @State private var approvalIsVisible = false
    @State private var hasUnreadContent = false
    @State private var isSending = false

    let sessionID: UUID
    var focusApproval = false

    var body: some View {
        if let session = store.session(sessionID) {
            conversation(session)
        } else {
            ContentUnavailableView("会话不可用", systemImage: "bubble.left")
        }
    }

    private func conversation(_ session: DemoSession) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 26) {
                    Text("\(store.project(session.projectID).name) · \(session.agent)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.bottom, 4)
                    ForEach(session.messages) { message in
                        VStack(alignment: .leading, spacing: 22) {
                            MessageView(message: message)
                            if session.hasToolRun, session.toolAfterMessageID == message.id {
                                ToolExecutionView()
                            }
                            if session.hasApproval, session.approvalAfterMessageID == message.id {
                                ApprovalView(session: session, project: store.project(session.projectID)) {
                                    store.decide($0, for: sessionID)
                                }
                                .id("approval")
                                .onScrollVisibilityChange(threshold: 0.2) { approvalIsVisible = $0 }
                            }
                        }
                        .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .scrollTargetLayout()
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 16)
            }
            .accessibilityIdentifier("conversationScroll")
            .background(Color(uiColor: .systemBackground))
            .scrollDismissesKeyboard(.interactively)
            .scrollPosition(id: $readingAnchor, anchor: .top)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 72
            } action: { _, nearBottom in
                isAtBottom = nearBottom
                if nearBottom { hasUnreadContent = false }
            }
            .onScrollPhaseChange { _, phase in
                if phase == .interacting { userHasScrolled = true }
                if phase == .idle, didRestorePosition, userHasScrolled { savePosition() }
            }
            .onChange(of: readingAnchor) { _, _ in
                if didRestorePosition, userHasScrolled { savePosition() }
            }
            .onChange(of: session.messages.last?.id) { _, _ in
                guard didRestorePosition, !isSending else { return }
                if isAtBottom { scrollToBottom(proxy) } else { hasUnreadContent = true }
            }
            .task(id: sessionID) {
                // Save only after user interaction; initial layout must not
                // overwrite an anchor from the previous visit.
                let saved = store.readingAnchor(for: sessionID)
                await Task.yield()
                if focusApproval, session.needsAttention {
                    if let parent = session.approvalAfterMessageID {
                        proxy.scrollTo(parent, anchor: .bottom)
                        await Task.yield()
                    }
                    proxy.scrollTo("approval", anchor: .center)
                } else if let saved, session.messages.contains(where: { $0.id == saved }) {
                    proxy.scrollTo(saved, anchor: .top)
                } else {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                await Task.yield()
                didRestorePosition = true
            }
            .onDisappear {
                if didRestorePosition, userHasScrolled { savePosition() }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if session.needsAttention, !session.archived, !approvalIsVisible {
                        Button { revealApproval(in: session, using: proxy) } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "hand.raised")
                                Text("等待确认")
                                Spacer(minLength: 12)
                                Text("查看")
                                Image(systemName: "chevron.up")
                            }
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 20)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .accessibilityLabel("等待确认，查看请求")
                        .accessibilityIdentifier("pendingApprovalLink")
                    }
                    if hasUnreadContent, !isAtBottom {
                        Button { scrollToBottom(proxy) } label: {
                            Label("有新内容", systemImage: "arrow.down")
                                .font(.subheadline.weight(.medium))
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .accessibilityIdentifier("latestContent")
                    }
                    if session.archived {
                        HStack {
                            Label("会话已归档", systemImage: "archivebox").foregroundStyle(.secondary)
                            Spacer()
                            Button("恢复会话") { store.restore(sessionID) }
                        }
                        .font(.subheadline).padding(.horizontal, 20).frame(minHeight: 60)
                    } else {
                        MessageComposer(text: draft, placeholder: "继续这项任务…") { send(using: proxy) }
                    }
                }
                .background(.bar)
                .overlay(alignment: .top) { Divider() }
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                NavigationLink { SessionChangesView(showsLoginExample: session.hasToolRun) } label: {
                    Image(systemName: "doc.text.magnifyingglass")
                }
                .accessibilityLabel("查看变更")
                Menu {
                    Button("会话详情", systemImage: "info.circle") { showingDetails = true }
                    Button(session.pinned ? "取消置顶" : "置顶会话", systemImage: session.pinned ? "pin.slash" : "pin") {
                        store.togglePin(sessionID)
                    }
                    .disabled(session.archived)
                    Divider()
                    Button("插入演示进度", systemImage: "text.append") { store.appendDemoUpdate(to: sessionID) }
                        .accessibilityIdentifier("insertDemoUpdate")
                        .disabled(session.archived)
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("会话操作")
                .accessibilityIdentifier("conversationMenu")
            }
        }
        .toolbar(.hidden, for: .bottomBar)
        .sheet(isPresented: $showingDetails) {
            SessionDetailsView(session: session, project: store.project(session.projectID))
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private var draft: Binding<String> {
        Binding(get: { store.draft(for: sessionID) }, set: { store.setDraft($0, for: sessionID) })
    }

    private func savePosition() {
        store.setReadingAnchor(isAtBottom ? nil : readingAnchor, for: sessionID)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        hasUnreadContent = false
        scroll(proxy, to: "bottom", anchor: .bottom)
    }

    private func revealApproval(in session: DemoSession, using proxy: ScrollViewProxy) {
        Task { @MainActor in
            // Register the enclosing lazy row before requesting its card's ID.
            if let parent = session.approvalAfterMessageID {
                proxy.scrollTo(parent, anchor: .bottom)
                await Task.yield()
            }
            scroll(proxy, to: "approval", anchor: .center)
        }
    }

    private func scroll<ID: Hashable>(_ proxy: ScrollViewProxy, to id: ID, anchor: UnitPoint) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: anchor) }
    }

    private func send(using proxy: ScrollViewProxy) {
        isSending = true
        guard store.send(store.draft(for: sessionID), to: sessionID) else { isSending = false; return }
        store.setDraft("", for: sessionID)
        let sentID = store.session(sessionID)?.messages.last(where: \.isUser)?.id
        hasUnreadContent = false
        Task { @MainActor in
            await Task.yield()
            if let sentID { scroll(proxy, to: sentID, anchor: .top) }
            await Task.yield()
            isSending = false
        }
    }
}

private struct MessageView: View {
    let message: DemoMessage

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.isUser { Spacer(minLength: 32) }
            Text(message.text)
                .font(.body)
                .lineSpacing(5)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(message.isUser ? 15 : 0)
                .background {
                    if message.isUser {
                        RoundedRectangle(cornerRadius: 20).fill(Color(uiColor: .secondarySystemBackground))
                    }
                }
        }
    }
}

private struct ToolExecutionView: View {
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 9) {
                Text("src/features/auth/LoginForm.tsx")
                Text("src/features/auth/LoginForm.test.tsx")
                Text("检查了网络错误处理和重试入口。").font(.subheadline)
            }
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .padding(.vertical, 10)
        } label: {
            Label("已读取 2 个文件", systemImage: "checkmark.circle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(minHeight: 44)
        }
        .tint(.secondary)
    }
}

private struct ApprovalView: View {
    let session: DemoSession
    let project: DemoProject
    let onDecision: (ApprovalDecision) -> Void

    private var decision: ApprovalDecision? { session.decision }

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            Label(decisionTitle, systemImage: decisionSymbol)
                .font(.headline)
            Text(session.approvalTitle ?? "确认这次操作").font(.body.weight(.medium))
            Text(session.approvalReason ?? "请检查命令和运行位置，再决定是否允许本次操作。")
                .font(.subheadline).foregroundStyle(.secondary)
            Text(session.approvalCommand ?? "未提供命令")
                .font(.system(.subheadline, design: .monospaced))
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            Text("\(project.name) · Mac Studio").font(.footnote).foregroundStyle(.secondary)
            if decision == nil, !session.archived {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { actions }
                    VStack(spacing: 8) { actions }
                }
            } else if decision == nil {
                Text("恢复会话后可以处理这条请求。")
                    .font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text(decision == .allowed ? "已记录本次允许。演示中不会运行命令。" : "已记录不执行，你可以继续调整任务。")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .accessibilityIdentifier("approvalResult")
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("approvalCard")
    }

    private var decisionTitle: String {
        switch decision {
        case nil: "需要你确认"
        case .allowed: "已允许本次"
        case .denied: "已选择不执行"
        }
    }

    private var decisionSymbol: String {
        switch decision {
        case nil: "hand.raised"
        case .allowed: "checkmark.circle"
        case .denied: "xmark.circle"
        }
    }

    @ViewBuilder private var actions: some View {
        Button("允许本次") { onDecision(.allowed) }
            .buttonStyle(.borderedProminent).controlSize(.large).frame(minHeight: 44)
            .accessibilityIdentifier("approveOnce")
        Button("不执行") { onDecision(.denied) }
            .buttonStyle(.bordered).controlSize(.large).frame(minHeight: 44)
            .accessibilityIdentifier("declineApproval")
    }
}

private struct SessionDetailsView: View {
    @Environment(\.dismiss) private var dismiss
    let session: DemoSession
    let project: DemoProject

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("会话详情").font(.headline)
                Spacer()
                Button("完成") { dismiss() }.frame(minHeight: 44)
            }
            .padding(.horizontal, 20).padding(.top, 20)
            Form {
                Section("会话") {
                    Text(session.title)
                    LabeledContent("Agent", value: session.agent)
                    LabeledContent("状态", value: session.status.rawValue)
                }
                Section("运行位置") {
                    LabeledContent("设备", value: "Mac Studio")
                    LabeledContent("项目", value: project.name)
                    Text(project.path).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Section {
                    Text("交互演示 · 会话、进度和审批保存在当前 App 中，没有连接电脑或执行命令。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

private struct SessionChangesView: View {
    let showsLoginExample: Bool
    private let lines: [(String, String)] = [
        ("context", "  async function submit() {"),
        ("context", "    try {"),
        ("context", "      await signIn(values)"),
        ("context", "    } catch (error) {"),
        ("removed", "−     setError('登录失败')"),
        ("added", "+     setError(readableError(error))"),
        ("added", "+     setCanRetry(true)"),
        ("context", "    }"),
        ("context", "  }")
    ]

    var body: some View {
        Group {
            if showsLoginExample { exampleDiff }
            else {
                ContentUnavailableView("暂无示例变更", systemImage: "doc.text.magnifyingglass", description: Text("这段会话尚未提供文件变更。"))
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("变更")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var exampleDiff: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("示例变更").font(.subheadline).foregroundStyle(.secondary)
                Text("保留输入，说明失败原因").font(.title2.weight(.semibold))
                Text("网络异常时显示可理解的提示，并提供重试入口。以下内容用于体验手机上的单列差异阅读。")
                    .foregroundStyle(.secondary)
                Label("LoginForm.tsx", systemImage: "doc.text").font(.headline)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line.1)
                            .font(.system(.footnote, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(background(for: line.0))
                            .accessibilityLabel((line.0 == "added" ? "新增 " : line.0 == "removed" ? "删除 " : "") + line.1)
                    }
                }
                .textSelection(.enabled)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(20)
        }
    }

    private func background(for kind: String) -> Color {
        switch kind {
        case "added": Color.green.opacity(0.13)
        case "removed": Color.red.opacity(0.11)
        default: .clear
        }
    }
}

#Preview("会话内容") {
    let store = DemoStore(persist: false)
    NavigationStack { ConversationView(sessionID: store.sessions[0].id) }.environment(store)
}
