import AppIntents
import Foundation
import RiffetKit

/// What a Focus lets through, as the reader set it up in System Settings > Focus > Focus Filters.
/// The system calls `perform()` when a Focus with the filter turns on or changes, and once more with
/// every parameter at its default when the Focus ends, so the default has to mean "no filtering":
/// that is why this is a three-way choice with "全部提醒" first, not a Bool that defaults to on.
enum FocusScope: String, AppEnum {
    case all, waitingOnly, muteCompletions

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "提醒范围")
    static let caseDisplayRepresentations: [FocusScope: DisplayRepresentation] = [
        .all: "全部提醒",
        .waitingOnly: "只提醒等待确认",
        .muteCompletions: "静音完成通知",
    ]
}

struct RiffetFocusFilter: SetFocusFilterIntent {
    static let title: LocalizedStringResource = "Riffet 通知"
    static let description = IntentDescription("专注模式开启时，只让 Riffet 发出选定的会话通知。")

    @Parameter(title: "提醒范围", default: .all) var scope: FocusScope

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "Riffet：\(FocusScope.caseDisplayRepresentations[scope]?.title ?? "全部提醒")")
    }

    func perform() async throws -> some IntentResult {
        FocusFilter.scope = scope
        return .result()
    }
}

/// The filter's current value, kept in `UserDefaults` for `NotificationCenterBridge` to read (the
/// intent may run before the workbench exists, so it cannot go through the app's model).
enum FocusFilter {
    private static let key = "riffet.focus-scope"

    static var scope: FocusScope {
        get { UserDefaults.standard.string(forKey: key).flatMap(FocusScope.init(rawValue:)) ?? .all }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }

    /// Whether a notification of this kind may be shown under the active Focus.
    static func allows(_ kind: SessionAlertKind) -> Bool {
        switch scope {
        case .all: true
        case .waitingOnly: kind == .waiting
        case .muteCompletions: kind != .finished
        }
    }

    /// Reads the filter the system holds now: a Focus that turned on or off while the app was not
    /// running never reached `perform()`.
    static func sync() {
        Task { if let current = try? await RiffetFocusFilter.current { scope = current.scope } }
    }
}
