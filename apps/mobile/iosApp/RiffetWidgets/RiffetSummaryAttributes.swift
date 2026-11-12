import ActivityKit

/// The summary Live Activity (docs/IOS.md). Servers start and update it over APNs by this type's
/// name, so the name and the content state's keys are part of the push contract.
struct RiffetSummaryAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// Conversations waiting for the reader.
        var waiting: Int
        var running: Int
        /// Finished conversations not opened since.
        var unseen: Int
    }
}
