import Foundation

// The render model `canvas-layout.js` returns: the canvas's layout with every value the cards read
// already derived, so the renderers only paint. Coordinates are canvas points; times are epoch
// milliseconds. Cards refer to one another by their index in `nodes`, to sessions by `si` and to
// turns by `ti`. Optional fields are absent from the JSON when they have their default.

enum CanvasLevel: String, Codable, Sendable {
    case summary, detail
}

/// An enum that reads an unknown raw value as `fallback` instead of failing the whole layout.
protocol Tolerant: RawRepresentable, Decodable where RawValue == String {
    static var fallback: Self { get }
}

extension Tolerant {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.fallback
    }
}

struct CanvasRect: Decodable, Sendable, Equatable {
    var x: Double, y: Double, w: Double, h: Double
}

/// A conversation of the family, with the fields a card draws; the backend is an id for the host to name.
struct CanvasSession: Decodable, Sendable, Equatable {
    var id: String
    var title: String
    var backend: String?
    var model: String?
    var live: Bool?
}

/// What a turn is for the host: opening it in the conversation, forking from it, its token count.
struct CanvasTurn: Decodable, Sendable, Equatable {
    var si: Int
    var id: String
    var status: String
    var runId: String?
    var nativeId: String?
    var tokens: Int?

    var isRunning: Bool { status == "running" }
}

// MARK: - Nodes

enum CanvasTrack: String, Sendable, Tolerant {
    case shell, explore, web, ask, other
    static var fallback: CanvasTrack { .other }
}

enum CanvasPromptVariant: String, Sendable, Tolerant {
    case prompt, brief, scheduled, command
    static var fallback: CanvasPromptVariant { .prompt }
}

/// One thing on the plane. `kind` carries what is specific to it; unknown kinds keep their box so a newer script never breaks an older app.
struct CanvasNode: Decodable, Sendable, Identifiable {
    var id: String
    var x: Double, y: Double, w: Double, h: Double
    /// When it came to be, for replay.
    var t: Double
    /// Index into `turns`; headers have none.
    var ti: Int?
    /// Changes whenever what the card draws changes (position excluded), so a bitmap is redrawn only then.
    var v: String
    var kind: Kind

    enum Kind: Sendable {
        case header(Header)
        case user(User)
        case signal(Signal)
        case agent(Agent)
        case actor(Actor)
        case fold(Fold)
        case change(Change)
        case artifacts(Artifacts)
        case tools(Tools)
        case unknown(String)
    }

    private enum Key: String, CodingKey { case id, kind, x, y, w, h, t, ti, v }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        id = try c.decode(String.self, forKey: .id)
        x = try c.decode(Double.self, forKey: .x)
        y = try c.decode(Double.self, forKey: .y)
        w = try c.decode(Double.self, forKey: .w)
        h = try c.decode(Double.self, forKey: .h)
        t = try c.decode(Double.self, forKey: .t)
        ti = try c.decodeIfPresent(Int.self, forKey: .ti)
        v = try c.decode(String.self, forKey: .v)
        let name = try c.decode(String.self, forKey: .kind)
        switch name {
        case "header": kind = .header(try Header(from: decoder))
        case "user": kind = .user(try User(from: decoder))
        case "signal": kind = .signal(try Signal(from: decoder))
        case "agent": kind = .agent(try Agent(from: decoder))
        case "actor": kind = .actor(try Actor(from: decoder))
        case "fold": kind = .fold(try Fold(from: decoder))
        case "change": kind = .change(try Change(from: decoder))
        case "artifacts": kind = .artifacts(try Artifacts(from: decoder))
        case "tools": kind = .tools(try Tools(from: decoder))
        default: kind = .unknown(name)
        }
    }

    var rect: CanvasRect { CanvasRect(x: x, y: y, w: w, h: h) }

    struct Header: Decodable, Sendable {
        var si: Int
        var title: String
        var live: Bool?
        /// `fork` or `handoff` when this row branched from another.
        var fork: String?
        var written: Written?
        struct Written: Decodable, Sendable { var files: Int, added: Int, removed: Int }
    }

    /// The reader's message in whichever form it came.
    struct User: Decodable, Sendable {
        var variant: CanvasPromptVariant
        /// `fork`, `handoff`, `schedule` or `template` on a row's first turn.
        var origin: String?
        /// Clipped to what the card can show; the whole text is in `detail`.
        var text: String
        var lines: Int
        /// Attachment ids of up to six images; the host resolves them to URLs.
        var images: [String]?
        var others: Int?
        var steers: [String]?
    }

    /// A turn no one typed: a background task reported back, or the agent carried on alone.
    struct Signal: Decodable, Sendable {
        var arrivals: [Arrival]?
        struct Arrival: Decodable, Sendable { var id: String, title: String, status: String, at: Double }
    }

    /// A `/compact` turn's pin on the spine.
    struct Fold: Decodable, Sendable { var tokens: String }

    struct Agent: Decodable, Sendable {
        var end: Double
        /// Its rows are not read yet.
        var pending: Bool?
        var running: Bool?
        var errored: Bool?
        var stopped: Bool?
        /// How long it ran, as of the layout's clock.
        var elapsed: String?
        var diff: Diff?
        /// Summary level: the one-sentence summary or the plain-text preview, and what the turn did.
        var previewLines: Int?
        var summary: String?
        var preview: String?
        var activity: [Activity]?
        var subagents: Int?
        var background: Int?
        /// Detail level: the opened answer.
        var blocks: [CanvasBlock]?
        /// There is text to copy.
        var copy: Bool?

        struct Diff: Decodable, Sendable { var added: Int, removed: Int }
        struct Activity: Decodable, Sendable { var tool: String, count: Int }
    }

    /// A subagent or background task as a bar on the row's clock.
    struct Actor: Decodable, Sendable {
        var end: Double
        var start: Double
        var subagent: Bool
        var name: String
        var note: String?
        var running: Bool?
        var failed: Bool?
        /// Bar length from the node's left, and where the dotted run on to its report ends.
        var bar: Double
        var report: Double?
        /// Its own calls ticked along the bar.
        var marks: [CanvasMark]
        var conclusion: String?
        var lane: String?
        var elapsed: String?
    }

    /// What an answer wrote under one directory, as a ledger.
    struct Change: Decodable, Sendable {
        /// Index of the answer it hangs from.
        var agent: Int
        var base: String
        var count: Int
        var added: Int
        var removed: Int
        /// Some file has a diff to count; the rule is grey when none does.
        var edits: Bool?
        var share: Int
        var counted: Bool
        var files: [File]
        /// Paths of the files past the ones shown, for linking a hover across ledgers.
        var hidden: [String]?

        struct File: Decodable, Sendable {
            var path: String
            var name: String
            var dir: String?
            var added: Int
            var removed: Int
            var created: Bool?
            var deleted: Bool?
            /// False for a write the shell made, which has no counts.
            var edits: Bool?
            var preview: [CanvasDiffLine]?
        }
    }

    struct Artifacts: Decodable, Sendable {
        var agent: Int
        var items: [Item]
        /// How many more there are than fit across the column.
        var more: Int

        struct Item: Decodable, Sendable {
            var key: String
            /// `image` or `page`.
            var kind: String
            var name: String
            /// The file, for the host to load; absent for an image the agent wrote inline (see `detail`).
            var path: String?
            var inline: Bool?
        }
    }

    /// An answer's calls of one kind as marks on its turn's clock, a few named beneath.
    struct Tools: Decodable, Sendable {
        var agent: Int
        var track: CanvasTrack
        /// `stroke`, `ring`, `diamond`, `pin` or `square`.
        var glyph: String
        var count: Int
        var marks: [CanvasMark]
        var callouts: [Callout]

        struct Callout: Decodable, Sendable {
            /// The step it names.
            var i: Int
            var x: Double
            var row: Int
            var side: String
            var w: Double
            var text: String
            var mono: Bool?
            var aside: String?
            var failed: Bool?

            var isLeft: Bool { side == "left" }
        }
    }
}

/// One call on a strip or bar, in the step order of its node.
struct CanvasMark: Decodable, Sendable, Equatable {
    var x: Double
    var x2: Double
    /// When the call began and ended, for replay: milliseconds after the node's `t`.
    var start: Double
    var end: Double
    var failed: Bool
    var running: Bool
    /// An explore call drawn as a tick (a read) where the others are rings.
    var tick: Bool

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        x = try c.decode(Double.self)
        x2 = try c.decode(Double.self)
        start = try c.decode(Double.self)
        end = try c.decode(Double.self)
        let flags = try c.decode(Int.self)
        failed = flags & 1 != 0
        running = flags & 2 != 0
        tick = flags & 4 != 0
    }
}

enum CanvasDiffLineType: String, Sendable, Tolerant {
    case add = "a", del = "d", same = "s", gap = "g"
    static var fallback: CanvasDiffLineType { .same }
}

/// A line of a ledger's preview: added, removed, unchanged, or a gap between hunks.
struct CanvasDiffLine: Decodable, Sendable, Equatable {
    var type: CanvasDiffLineType
    var text: String

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        type = try c.decode(CanvasDiffLineType.self)
        text = try c.decode(String.self)
    }
}

// MARK: - Answer blocks

/// One block of an answer opened at the detail level; `h` is the height the layout allotted it.
enum CanvasBlock: Decodable, Sendable {
    case thought(text: String, h: Double)
    case commentary(text: String, h: Double)
    case plan(title: String, entries: [PlanEntry], hidden: Int, h: Double)
    case actor(background: Bool, label: String, duration: String, h: Double)
    case calls(items: [Call], failed: Bool, h: Double)
    case compaction(text: String, h: Double)
    case status(text: String, h: Double)
    case answer(text: String, lines: Int, h: Double)
    case unknown(h: Double)

    struct PlanEntry: Decodable, Sendable { var text: String, status: String }
    /// A tool and how many times a run of calls used it; `tool` is the transcript's kind for its icon.
    struct Call: Decodable, Sendable { var name: String, tool: String, count: Int }

    private enum Key: String, CodingKey { case kind, text, h, title, entries, hidden, background, label, duration, items, failed, lines }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let h = try c.decodeIfPresent(Double.self, forKey: .h) ?? 0
        switch try c.decode(String.self, forKey: .kind) {
        case "thought": self = .thought(text: try c.decode(String.self, forKey: .text), h: h)
        case "commentary": self = .commentary(text: try c.decode(String.self, forKey: .text), h: h)
        case "plan": self = .plan(title: try c.decode(String.self, forKey: .title), entries: try c.decode([PlanEntry].self, forKey: .entries), hidden: try c.decode(Int.self, forKey: .hidden), h: h)
        case "actor": self = .actor(background: try c.decode(Bool.self, forKey: .background), label: try c.decode(String.self, forKey: .label), duration: try c.decode(String.self, forKey: .duration), h: h)
        case "calls": self = .calls(items: try c.decode([Call].self, forKey: .items), failed: try c.decode(Bool.self, forKey: .failed), h: h)
        case "compaction": self = .compaction(text: try c.decode(String.self, forKey: .text), h: h)
        case "status": self = .status(text: try c.decode(String.self, forKey: .text), h: h)
        case "answer": self = .answer(text: try c.decode(String.self, forKey: .text), lines: try c.decode(Int.self, forKey: .lines), h: h)
        default: self = .unknown(h: h)
        }
    }
}

// MARK: - Ground and edges

enum CanvasEdgeKind: String, Sendable, Tolerant {
    case prompt, reply, fork
    static var fallback: CanvasEdgeKind { .reply }
}

struct CanvasEdge: Decodable, Sendable {
    var kind: CanvasEdgeKind
    /// Indexes into `nodes`; -1 is the slot for the next question.
    var from: Int
    var to: Int
    var t: Double
    /// The SVG path, and its two ends.
    var path: String
    var x1: Double, y1: Double, x2: Double, y2: Double
    /// A reply across a long silence: how it is said, and where.
    var gap: String?
    var mid: [Double]?
}

/// The project frame around a row.
struct CanvasFrame: Decodable, Sendable {
    var si: Int
    var x: Double, y: Double, w: Double, h: Double
    var project: String?
    var branch: String?
}

/// When a turn began, above its column; the date where a new day starts.
struct CanvasGutterMark: Decodable, Sendable {
    var ti: Int
    var x: Double, y: Double
    var t: Double
    var day: Bool?
}

enum CanvasTrackKind: String, Sendable, Tolerant {
    case write, artifacts, actors, shell, explore, web, ask, other
    static var fallback: CanvasTrackKind { .other }
}

/// One track of a row, with its name already in the reader's language.
struct CanvasTrackBand: Decodable, Sendable {
    var id: String
    var si: Int
    var kind: CanvasTrackKind
    var name: String
    /// A directory outside the project: its line is dotted and its name is a path.
    var external: Bool?
    var x: Double, w: Double, y: Double, h: Double
    /// Where the track's line runs.
    var line: Double
}

/// Where the context was compacted; `tokens` is the size before and after for one made mid-turn.
struct CanvasSeam: Decodable, Sendable {
    var id: String
    var x: Double, top: Double, bottom: Double
    var t: Double
    var tokens: String?
}

/// A slot (the next question) or a column to follow: a box with an id.
struct CanvasSlot: Decodable, Sendable {
    var id: String
    var x: Double, y: Double, w: Double, h: Double
}

/// What the host may fetch next.
struct CanvasWants: Decodable, Sendable {
    var lanes: [Lane]
    var summaries: [Summary]
    struct Lane: Decodable, Sendable { var id: String, sid: String, lane: String }
    struct Summary: Decodable, Sendable { var id: String, sid: String, turn: String }
}

/// The canvas's pixel constants (`ROW`, `CHANGE`, `ART`, `STRIP`, `BAR` of `flow.ts`), which the layout's sizes are made of.
struct CanvasMetrics: Decodable, Sendable {
    var row: [String: Double]
    var change: [String: Double]
    var art: [String: Double]
    var strip: [String: Double]
    var bar: [String: Double]
}

struct CanvasLayout: Decodable, Sendable {
    var level: CanvasLevel
    /// Every conversation of the family has its outline.
    var ready: Bool
    /// Some conversation is at work: the host keeps time and asks again.
    var live: Bool
    var bounds: CanvasRect
    var sessions: [CanvasSession]
    var turns: [CanvasTurn]
    var nodes: [CanvasNode]
    var edges: [CanvasEdge]
    var frames: [CanvasFrame]
    var gutter: [CanvasGutterMark]
    var tracks: [CanvasTrackBand]
    var seams: [CanvasSeam]
    /// The slot for the next question, when asked for.
    var next: CanvasSlot?
    /// The focus conversation's newest column, where the camera follows; its id changes as the column grows.
    var latest: CanvasSlot?
    var wants: CanvasWants?
    var metrics: CanvasMetrics

    static func decode(_ json: String) throws -> CanvasLayout {
        try JSONDecoder().decode(CanvasLayout.self, from: Data(json.utf8))
    }
}

// MARK: - Detail and tip

/// A step of the timing tree, its bar as percentages of the group's span; an opened subagent nests.
struct CanvasStep: Decodable, Sendable {
    var key: String
    var label: String
    /// `thought`, `tool`, `subagent`, `background`, ...
    var kind: String
    /// `read`, `search`, `edit`, `execute`, `fetch` or `other` for a tool.
    var tool: String?
    var failed: Bool?
    var running: Bool?
    var duration: String
    var a: Double
    var b: Double
    var lane: String?
    var open: CanvasStepTree?
}

struct CanvasStepTree: Decodable, Sendable {
    var total: String?
    var steps: [CanvasStep]?
    var loading: Bool?
}

/// The inspector's content for one node; which fields are present depends on its kind.
struct CanvasNodeDetail: Decodable, Sendable {
    var title: String
    var copy: String
    // user
    var text: String?
    var images: [String]?
    var others: Int?
    var steers: [String]?
    // signal
    var arrivals: [CanvasNode.Signal.Arrival]?
    // agent and actor
    var facts: [String]?
    var summary: String?
    /// The full markdown of the answer.
    var answer: String?
    var running: Bool?
    var timeline: CanvasStepTree?
    // actor
    var command: String?
    var lane: String?
    /// `closed`, `loading` or `open`.
    var laneState: String?
    // change
    var edits: [Edit]?
    var commands: [Commands]?
    // artifacts
    var items: [Artifact]?
    // tools
    var steps: [Call]?

    struct Edit: Decodable, Sendable { var path: String, index: Int, before: String, after: String }
    struct Commands: Decodable, Sendable { var path: String, commands: [String] }
    struct Artifact: Decodable, Sendable {
        var key: String
        var kind: String
        var name: String
        var path: String?
        var inline: Bool?
        /// The data of an inline image.
        var src: String?
    }
    struct Call: Decodable, Sendable {
        var key: String
        var name: String?
        var title: String?
        var duration: String
        var arg: String?
        var output: String?
        var failed: Bool?
    }
}

/// The tooltip of one call of a strip or bar.
struct CanvasTip: Decodable, Sendable {
    var name: String
    /// The transcript's kind for the icon.
    var tool: String
    /// How long it took, or that it is running or failed.
    var time: String
    var failed: Bool?
    var words: String?
    var code: String?
    var tail: [String]
}

/// Which turns to read rows for after an outline arrived, and from which position.
struct CanvasOutlineDiff: Decodable, Sendable {
    var turns: [String]
    var from: Double
}

// MARK: - Input

/// The fields of a conversation the canvas reads.
struct CanvasSessionInput: Encodable, Sendable {
    struct Origin: Encodable, Sendable {
        var kind: String
        var sessionId: String?
        var runId: String?
    }
    var id: String
    var projectId: String
    var kind: String
    var title: String
    var state: String
    var createdAt: String
    var backendId: String?
    var model: String?
    var origin: Origin?
    var archivedAt: String?
}

struct CanvasProjectInput: Encodable, Sendable {
    var id: String
    var cwd: String?
    var name: String?
    var branch: String?
}
