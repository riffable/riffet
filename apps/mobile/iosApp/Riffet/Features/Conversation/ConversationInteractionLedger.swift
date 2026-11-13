import Foundation
import Observation
import RiffetKit

/// Request results belong at the point where a dialog appeared, even as output continues to grow.
/// This ledger survives navigation for this app run; the server's transcript remains authoritative.
@MainActor @Observable
final class ConversationInteractionLedger {
    static let shared = ConversationInteractionLedger()
    struct Record: Identifiable {
        let id: String
        var interaction: NativeInteraction
        let afterRow: String?
        var result: String?
        var confirmed = false
        var waiting = true
    }
    private var bySession: [String: [Record]] = [:]
    func records(for key: String) -> [Record] {
        var records = bySession[key] ?? []
        guard let separator = key.lastIndex(of: "|") else { return records }
        let server = String(key[..<separator]), session = String(key[key.index(after: separator)...])
        for interaction in InteractionDrafts.shared.pendingInteractions(server: server, session: session) {
            if let index = records.firstIndex(where: { $0.id == interaction.id }) {
                records[index].interaction = interaction
                records[index].waiting = true
                records[index].confirmed = false
                records[index].result = nil
            } else { records.append(Record(id: interaction.id, interaction: interaction, afterRow: nil)) }
        }
        return records
    }
    private func pending(_ interaction: NativeInteraction, for key: String) -> Bool {
        guard let separator = key.lastIndex(of: "|") else { return false }
        let server = key[..<separator], session = key[key.index(after: separator)...]
        return InteractionDrafts.shared.hasPendingSubmission(for: "\(server):\(session):\(interaction.id)")
    }
    func observe(_ interaction: NativeInteraction?, for key: String, after row: String?, authoritative: Bool) {
        var records = self.records(for: key)
        if let interaction {
            for index in records.indices where records[index].id != interaction.id && records[index].waiting && !pending(records[index].interaction, for: key) {
                records[index].waiting = false
                records[index].result = String(localized: "Agent 已不再等待此请求。请以当前会话进展为准。", bundle: .riffet)
            }
            if let index = records.firstIndex(where: { $0.id == interaction.id }) {
                if pending(records[index].interaction, for: key) {
                    // Keep the original receipt visible until the user synchronizes or retries.
                } else if records[index].interaction.revision != interaction.revision {
                    records[index].interaction = interaction
                    records[index].result = nil
                    records[index].confirmed = false
                    records[index].waiting = true
                } else {
                    // Same identity can gain display metadata without changing its decision.
                    records[index].interaction = interaction
                    if !records[index].confirmed {
                        records[index].waiting = true
                        records[index].result = nil
                    }
                }
            } else { records.append(Record(id: interaction.id, interaction: interaction, afterRow: row)) }
        } else if authoritative {
            for index in records.indices where records[index].waiting && !pending(records[index].interaction, for: key) {
                records[index].waiting = false
                if !records[index].confirmed { records[index].result = String(localized: "Agent 已不再等待此请求。它可能已在其他设备处理，请查看后续进展。", bundle: .riffet) }
            }
        }
        bySession[key] = records
    }
    func submitted(_ result: NativeInteractionResult, interaction: NativeInteraction, for key: String) {
        guard result.status != .uncertain else { return }
        var records = self.records(for: key)
        guard let index = records.firstIndex(where: { $0.id == interaction.id && $0.interaction.revision == interaction.revision }) else { return }
        records[index].waiting = false
        records[index].confirmed = true
        records[index].result = result.message ?? (result.status == .advanced ? String(localized: "回答已提交，服务器已确认。", bundle: .riffet) : String(localized: "操作已提交，服务器已确认。", bundle: .riffet))
        bySession[key] = records
    }
}
