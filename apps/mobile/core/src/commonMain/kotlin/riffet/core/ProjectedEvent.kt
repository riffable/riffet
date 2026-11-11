package riffet.core

import riffet.contracts.WorkbenchEvent
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * A [WorkbenchEvent] plus the identity under which it is displayed.
 *
 * The TS original (`apps/web/src/app/session/projectEvents.ts`) declares this as
 * `interface ProjectedEvent extends WorkbenchEvent { projectionKey; sourceEvents }`. Kotlin has no
 * intersection types, so the base event is composed and its fields are re-exposed as getters: the
 * call sites (`event.data`, `event.sequence`, `event.runId`, ...) read identically to the TS.
 */
data class ProjectedEvent(
    val base: WorkbenchEvent,
    val projectionKey: String,
    val sourceEvents: List<WorkbenchEvent>,
    /** The authoritative lane turn, retained when decoding a server-folded row. */
    val turn: String? = null,
) {
    val sequence: Long get() = base.sequence
    val sessionId: String get() = base.sessionId
    val runId: String? get() = base.runId
    val type: String get() = base.type
    val data: JsonObject get() = base.data
    val raw: JsonElement? get() = base.raw
    val createdAt: String get() = base.createdAt
    val nativeId: String? get() = base.nativeId
    val nativeAliases: List<String>? get() = base.nativeAliases
    val nativeTurnId: String? get() = base.nativeTurnId
}
