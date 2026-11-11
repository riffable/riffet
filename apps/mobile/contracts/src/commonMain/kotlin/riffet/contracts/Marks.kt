package riffet.contracts

import kotlinx.serialization.Serializable

/*
 * Saved replies (收藏), mirroring `Mark*` in packages/contracts/src/index.ts; see docs/MARKS.md.
 * `kind`, `color`, `state` and `backendId` stay strings: a value a newer server adds must not drop
 * the whole list.
 */

/** The ways back to the marked message: its native id when marked, its aliases, run and sequence. */
@Serializable
data class MarkAnchor(
    val messageId: String,
    val aliases: List<String>? = null,
    val runId: String? = null,
    val nativeTurnId: String? = null,
    val sequence: Long? = null,
    /** Native history generation at the time; a different one means positional ids may have shifted. */
    val generation: String? = null,
) {
    /** Every id the message was known by when it was marked. */
    val ids: List<String> get() = listOf(messageId) + aliases.orEmpty()
}

/** A W3C TextQuoteSelector over the message's rendered plain text; the offsets are hints only. */
@Serializable
data class MarkQuote(
    val exact: String,
    val prefix: String,
    val suffix: String,
    val start: Int? = null,
    val end: Int? = null,
)

@Serializable
data class MarkSnapshot(
    /** The whole message (or the turn's answer) as plain text, capped by the server. */
    val text: String,
    val sessionTitle: String,
    /** When the marked message was written. */
    val at: String,
)

/** What an `image` or `file` mark saved; an image's copy is kept by the server (`/api/marks/:id/asset`). */
@Serializable
data class MarkAsset(
    val name: String,
    val path: String? = null,
    val mimeType: String? = null,
    val bytes: Long? = null,
    val stored: Boolean? = null,
    /** For a file: what the agent did with it, e.g. `写入` or `+12 −3`. */
    val detail: String? = null,
)

@Serializable
data class Mark(
    val id: String,
    val sessionId: String,
    val projectId: String,
    val backendId: String? = null,
    /** `message`, `span`, `image` or `file`. */
    val kind: String,
    val anchor: MarkAnchor,
    /** Present exactly when [kind] is `span`. */
    val quote: MarkQuote? = null,
    /** Present exactly when [kind] is `image` or `file`. */
    val asset: MarkAsset? = null,
    val snapshot: MarkSnapshot,
    val note: String? = null,
    /** `yellow`, `green`, `blue` or `red`. */
    val color: String? = null,
    /** `orphaned` once the message can no longer be found, including after its conversation is deleted. */
    val state: String,
    val createdAt: String,
    val updatedAt: String,
) {
    val isMessage: Boolean get() = kind == "message"
    val isSpan: Boolean get() = kind == "span"
    val isAsset: Boolean get() = kind == "image" || kind == "file"
    val orphaned: Boolean get() = state == "orphaned"

    /** What a list shows of it: the highlighted words, the saved file, or the start of the answer. */
    val excerpt: String get() = quote?.exact ?: asset?.path ?: asset?.name ?: snapshot.text
}

/** `POST /api/marks`. [id] is client-generated and makes the request idempotent. */
@Serializable
data class MarkCreateRequest(
    val id: String,
    val sessionId: String,
    val kind: String,
    val anchor: MarkAnchor,
    val quote: MarkQuote? = null,
    val asset: MarkCreateAsset? = null,
    val snapshot: MarkCreateSnapshot,
    val note: String? = null,
    val color: String? = null,
)

/** An image's [data] is the picture, base64, at most 10 MiB; the server keeps it. */
@Serializable
data class MarkCreateAsset(
    val name: String,
    val path: String? = null,
    val mimeType: String? = null,
    val detail: String? = null,
    val data: String? = null,
)

@Serializable
data class MarkCreateSnapshot(val text: String, val at: String)

/** `GET /api/marks` filters; every one is optional and [q] searches snapshot, quote and note. */
data class MarkListQuery(
    val sessionId: String? = null,
    val projectId: String? = null,
    /** Sent as repeated `kind` parameters; empty lists every kind. */
    val kinds: List<String> = emptyList(),
    val state: String? = null,
    val q: String? = null,
    val limit: Int = 50,
    val cursor: String? = null,
)

/** Newest first. */
@Serializable
data class MarkListPage(val marks: List<Mark>, val nextCursor: String? = null, val total: Int)

/** `GET /api/marks/:id/locate`: where the message is now; `found: false` also marks it orphaned. */
@Serializable
data class MarkLocation(
    val found: Boolean,
    val mark: Mark,
    val messageId: String? = null,
    val runId: String? = null,
    val sequence: Long? = null,
)

/** `GET /api/marks/:id/prompt`: the user message that led to the marked answer, when it is known. */
@Serializable
data class MarkPrompt(val text: String? = null)
