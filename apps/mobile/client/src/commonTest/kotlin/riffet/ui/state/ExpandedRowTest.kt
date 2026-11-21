package riffet.ui.state

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import riffet.contracts.RiffetJson
import riffet.contracts.TimelineRow

/**
 * `GET /api/sessions/:id/blobs/:blobRef` for a cut tool row answers the server's row content
 * (`timeline/budget.ts`): the row without the lane's `seq` and `rev`. The full row must still replace
 * the cut one, or an Edit cut to its old text reads as a deletion of the whole file.
 */
class ExpandedRowTest {
    private fun event(newText: String) =
        """{"type":"tool_call","data":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","content":[{"type":"diff","path":"a.kt","oldText":"a\nb","newText":"$newText"}]},"createdAt":"2026-11-21T01:00:00Z","lastAt":"2026-11-21T01:00:01Z","sourceIds":["s1"]}"""

    @Test
    fun aToolRowContentBlobReplacesTheCutRow() {
        val held = RiffetJson.instance.decodeFromString(TimelineRow.serializer(),
            """{"key":"tool:t1","pos":7,"turn":"turn-1","seq":42,"rev":3,"kind":"tool","truncated":{"blobRef":"h","bytes":9000},"event":${event("")}}""")
        val blob = """{"key":"tool:t1","pos":7,"turn":"turn-1","kind":"tool","event":${event("a\nc")}}"""

        val full = assertNotNull(expandedRow(held, blob))
        assertEquals(42, full.seq)
        assertEquals(3, full.rev)
        assertNull(full.truncated)
        val diff = full.event.data["content"]!!.jsonArray[0].jsonObject
        assertEquals("a\nc", diff["newText"]!!.jsonPrimitive.content)
    }
}
