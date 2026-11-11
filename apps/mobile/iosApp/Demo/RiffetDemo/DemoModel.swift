import SwiftUI
import Observation

enum SessionStatus: String, Codable {
    case approval = "等待确认", running = "运行中", completed = "已完成", ready = "就绪"

    var symbol: String {
        switch self {
        case .approval: "hand.raised.fill"
        case .running: "circle.dotted.circle"
        case .completed: "checkmark.circle"
        case .ready: "circle"
        }
    }

    var color: Color {
        switch self {
        case .approval: .orange
        case .running: .blue
        case .completed, .ready: .secondary
        }
    }
}

enum ApprovalDecision: String, Codable {
    case allowed = "已允许一次", denied = "已拒绝"
}

struct DemoMessage: Identifiable, Codable, Equatable {
    var id = UUID()
    let isUser: Bool
    let text: String
}

struct DemoProject: Identifiable {
    let id: String
    let name: String
    let path: String
    let symbol: String
}

struct DemoSession: Identifiable, Codable {
    let id: UUID
    let projectID: String
    var title: String
    let agent: String
    var status: SessionStatus
    var pinned: Bool
    var updated: String
    var summary: String
    var messages: [DemoMessage]
    var hasToolRun = false
    var hasApproval = false
    var decision: ApprovalDecision?
    var toolAfterMessageID: UUID?
    var approvalAfterMessageID: UUID?
    var approvalTitle: String?
    var approvalReason: String?
    var approvalCommand: String?
    var archived = false

    var needsAttention: Bool { hasApproval && decision == nil }
}

@MainActor @Observable
final class DemoStore {
    let projects = [
        DemoProject(id: "riffet", name: "riffet", path: "~/workspace/riffet", symbol: "folder"),
        DemoProject(id: "website", name: "website", path: "~/workspace/website", symbol: "globe"),
        DemoProject(id: "playground", name: "playground", path: "~/workspace/playground", symbol: "square.stack.3d.up")
    ]
    var sessions: [DemoSession] { didSet { save() } }
    var newTaskDraft: String = "" { didSet { save() } }
    var newTaskProjectID: String = "riffet" { didSet { save() } }
    var newTaskAgent: String = "Codex" { didSet { save() } }
    private var drafts: [String: String] = [:]
    private var readingAnchors: [String: UUID] = [:]
    private let persist: Bool
    // This namespace belongs only to the standalone Demo; it never reads production app data.
    private static let storageKey = "io.github.riffetai.iphone.demo.interaction-v2"

    private struct Snapshot: Codable {
        var sessions: [DemoSession]
        var drafts: [String: String]
        var readingAnchors: [String: UUID]
        var newTaskDraft: String
        var newTaskProjectID: String
        var newTaskAgent: String
    }

    init(persist: Bool = true) {
        self.persist = persist
        if persist,
           let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) {
            sessions = snapshot.sessions
            drafts = snapshot.drafts
            readingAnchors = snapshot.readingAnchors
            newTaskDraft = snapshot.newTaskDraft
            newTaskProjectID = snapshot.newTaskProjectID
            newTaskAgent = snapshot.newTaskAgent
        } else {
            sessions = Self.sampleSessions()
        }
    }

    func project(_ id: String) -> DemoProject { projects.first { $0.id == id } ?? projects[0] }
    func session(_ id: UUID) -> DemoSession? { sessions.first { $0.id == id } }
    func draft(for id: UUID) -> String { drafts[id.uuidString] ?? "" }

    func setDraft(_ text: String, for id: UUID) {
        guard session(id) != nil else { return }
        drafts[id.uuidString] = text.isEmpty ? nil : text
        save()
    }

    func readingAnchor(for id: UUID) -> UUID? { readingAnchors[id.uuidString] }

    func setReadingAnchor(_ messageID: UUID?, for id: UUID) {
        guard let session = session(id),
              messageID == nil || session.messages.contains(where: { $0.id == messageID }) else { return }
        readingAnchors[id.uuidString] = messageID
        save()
    }

    @discardableResult
    func startTask(text: String, projectID: String, agent: String) -> UUID? {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              projects.contains(where: { $0.id == projectID }) else { return nil }
        let firstLine = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? text
        let title = String(firstLine.prefix(24))
        let session = DemoSession(
            id: UUID(), projectID: projectID, title: title, agent: agent,
            status: .ready, pinned: false, updated: "刚刚", summary: "任务已保存在本机，尚未执行",
            messages: [
                DemoMessage(isUser: true, text: text),
                DemoMessage(isUser: false, text: "任务已保存在本机。这里是交互演示，没有连接 Mac 或执行任务。\n\n你可以返回列表、切换其他会话，再回来继续编辑；草稿和阅读位置会保留。")
            ]
        )
        sessions.insert(session, at: 0)
        newTaskDraft = ""
        newTaskProjectID = projectID
        newTaskAgent = agent
        return session.id
    }

    @discardableResult
    func send(_ text: String, to id: UUID) -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let index = sessions.firstIndex(where: { $0.id == id && !$0.archived }) else { return false }
        sessions[index].messages.append(DemoMessage(isUser: true, text: text))
        sessions[index].messages.append(DemoMessage(isUser: false, text: "已保存这条消息。这是本地演示回复，没有连接 Agent 或服务器。"))
        drafts[id.uuidString] = nil
        sessions[index].updated = "刚刚"
        if !sessions[index].needsAttention {
            sessions[index].summary = "消息已保存在本机，尚未执行"
            sessions[index].status = .ready
        }
        save()
        return true
    }

    func decide(_ decision: ApprovalDecision, for id: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == id && !$0.archived }),
              sessions[index].needsAttention else { return }
        // Approval stays where it was requested; recording a decision does not append content.
        sessions[index].decision = decision
        sessions[index].status = .ready
        sessions[index].summary = decision == .allowed
            ? "已记录允许；演示没有执行命令"
            : "已拒绝本次请求，可以继续补充要求"
        sessions[index].updated = "刚刚"
    }

    func appendDemoUpdate(to id: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == id && !$0.archived }) else { return }
        sessions[index].messages.append(DemoMessage(
            isUser: false,
            text: "手动追加的演示消息。你可以停留在历史内容中，确认阅读位置保持不动，再点新消息提示回到底部。此操作没有运行远端任务。"
        ))
        sessions[index].updated = "刚刚"
        if !sessions[index].needsAttention {
            sessions[index].summary = "新增一条手动演示消息"
        }
    }

    func togglePin(_ id: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == id && !$0.archived }) else { return }
        sessions[index].pinned.toggle()
    }

    func archive(_ id: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        sessions[index].archived = true
    }

    func restore(_ id: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        sessions[index].archived = false
    }

    func resetDemo() {
        sessions = Self.sampleSessions()
        drafts = [:]
        readingAnchors = [:]
        newTaskDraft = ""
        newTaskProjectID = "riffet"
        newTaskAgent = "Codex"
        save()
    }

    private func save() {
        guard persist else { return }
        let snapshot = Snapshot(
            sessions: sessions, drafts: drafts, readingAnchors: readingAnchors,
            newTaskDraft: newTaskDraft, newTaskProjectID: newTaskProjectID, newTaskAgent: newTaskAgent
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }

    private static func sampleSessions() -> [DemoSession] {
        func stableID(_ value: Int) -> UUID {
            UUID(uuidString: String(format: "A10B0000-0000-4000-8000-%012d", value))!
        }
        func messages(_ texts: [(Bool, String)], session: Int) -> [DemoMessage] {
            texts.enumerated().map { offset, item in
                DemoMessage(id: stableID(session * 100 + offset + 1), isUser: item.0, text: item.1)
            }
        }
        let loginMessages = messages([
            (true, "完善登录页的错误提示。网络异常时给出清晰的解释，并允许用户重试。"),
            (false, "这是一段本地样例会话，用于体验长历史、工具展开和审批定位。示例里的检查与修改没有在你的项目中执行。"),
            (false, "样例检查记录：登录页把请求失败统一显示为‘登录失败’，网络超时与账号信息错误没有区分。"),
            (true, "网络错误时保留已经输入的内容，不要清空表单。"),
            (false, "错误说明放在表单下方，重试入口保持可见。用户名与密码继续保留，用户不需要重新填写。"),
            (false, "提示文案建议：‘暂时无法连接，请检查网络后重试。’账号或密码错误则显示对应说明。"),
            (true, "重试时也要避免重复提交。"),
            (false, "样例方案：提交过程中禁用登录按钮，同时保留按钮上的加载状态。请求结束后恢复操作。"),
            (false, "验证范围包含网络超时、密码错误和重复点击三个场景。下面的工具记录可以展开查看命令与作用位置。"),
            (true, "先跑登录相关测试。"),
            (false, "运行测试前需要确认命令与作用项目。你可以允许一次，或拒绝后补充要求。下面的请求仅用于本地交互演示。"),
            (false, "你也可以先回看上面的方案。审批入口会保留，确认后卡片在原处显示结果。")
        ], session: 1)
        let historyMessages = messages([
            (true, "梳理会话时间线的长内容阅读体验。"),
            (false, "本地样例：时间线包含正文、工具结果和代码，阅读位置需要在页面往返时保留。"),
            (true, "新消息出现时不要打断回看。"),
            (false, "在底部阅读时继续跟随；向上回看后停留原位，给出可点击的新消息提示。"),
            (true, "如果查看文件再返回呢？"),
            (false, "保存最近可见的消息锚点。返回会话后恢复这条消息，避免每次从头或从末尾开始。"),
            (false, "长工具结果默认收起。展开不会改变该条记录在对话中的归属位置。"),
            (true, "草稿也要按会话保留。"),
            (false, "每个会话独立保存草稿。切换到其他项目写几句话，再回来，原来的输入应仍在。"),
            (true, "键盘弹出时如何处理？"),
            (false, "输入区使用底部安全区布局。阅读历史时不因为新内容出现而跳到输入区。"),
            (false, "测试建议：在这段历史中停留，打开右上角菜单，手动追加一条演示消息。"),
            (true, "还需要恢复新建任务没发出的内容。"),
            (false, "新任务编辑使用独立草稿；离开再回来可以继续。成功发送后清空，保留刚选过的项目与 Agent。"),
            (false, "这组样例没有审批请求，适合独立验证回看与新消息提示。所有内容保存在 Demo 自己的本地存储中。")
        ], session: 3)
        var result = [
            DemoSession(id: stableID(1), projectID: "riffet", title: "完善登录页的错误提示", agent: "Codex", status: .approval, pinned: true, updated: "刚刚", summary: "等待你确认运行登录测试", messages: loginMessages, hasToolRun: true, hasApproval: true, toolAfterMessageID: loginMessages[8].id, approvalAfterMessageID: loginMessages[10].id, approvalTitle: "运行登录相关测试", approvalReason: "验证网络超时、账号密码错误和重复提交三个场景。此请求是本地交互样例，不会执行命令。", approvalCommand: "pnpm test -- LoginForm"),
            DemoSession(id: stableID(2), projectID: "website", title: "检查图片压缩方案", agent: "Claude Code", status: .approval, pinned: false, updated: "8 分钟前", summary: "等待你确认安装图片处理工具", messages: messages([
                (true, "检查首页大图的加载耗时，并给出压缩建议。"),
                (false, "本地样例：准备安装图片处理工具以比较压缩效果。请先检查下方请求，演示不会实际安装任何内容。")
            ], session: 2), hasApproval: true, approvalAfterMessageID: stableID(202), approvalTitle: "安装图片处理工具", approvalReason: "添加 sharp 作为开发依赖，用于比较首页图片的压缩效果。真实操作会修改依赖清单和锁文件；本地演示不会安装任何内容。", approvalCommand: "pnpm add -D sharp"),
            DemoSession(id: stableID(3), projectID: "riffet", title: "打磨长会话阅读体验", agent: "Codex", status: .completed, pinned: true, updated: "20 分钟前", summary: "阅读位置、草稿与新消息提示的设计记录", messages: historyMessages)
        ]
        let recent: [(String, String, String, SessionStatus, String, String)] = [
            ("riffet", "优化项目列表加载", "Claude Code", .running, "25 分钟前", "正在检查分页和加载状态"),
            ("playground", "探索快捷指令入口", "Codex", .running, "40 分钟前", "正在梳理快捷指令的任务参数"),
            ("riffet", "整理发布说明", "Codex", .completed, "1 小时前", "已整理新增功能、修复和使用提示"),
            ("website", "修复深色模式对比度", "Cursor", .completed, "2 小时前", "已整理语义色和链接对比度建议"),
            ("riffet", "梳理断线重连状态", "Codex", .completed, "3 小时前", "保留发送队列与重新连接的交互记录"),
            ("website", "调整文章页排版", "Claude Code", .completed, "昨天", "正文行高、代码块和图片说明待你查看"),
            ("playground", "试试 Markdown 表格", "Codex", .ready, "昨天", "继续补充表格在窄屏下的展示要求"),
            ("riffet", "检查文件预览手势", "Codex", .completed, "昨天", "已记录返回手势与代码选择的冲突点"),
            ("website", "整理首页文案", "Cursor", .completed, "周二", "首页标题和功能说明已整理"),
            ("playground", "验证输入草稿恢复", "Claude Code", .ready, "周二", "输入未发送文字后，切换会话再回来"),
            ("riffet", "合并终端状态说明", "Codex", .completed, "周一", "已整理终端连接、退出与重连的说明")
        ]
        for (offset, item) in recent.enumerated() {
            let number = offset + 4
            result.append(DemoSession(
                id: stableID(number), projectID: item.0, title: item.1, agent: item.2,
                status: item.3, pinned: false, updated: item.4, summary: item.5,
                messages: messages([
                    (true, item.1 + "。"),
                    (false, item.5 + "。\n\n这是供体验界面使用的本地样例，没有远端任务在运行。你可以继续输入，或返回查看其他会话。")
                ], session: number)
            ))
        }
        return result
    }
}
