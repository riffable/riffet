package riffet.ui.timeline

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import riffet.contracts.WorkbenchEvent
import riffet.core.ProjectedEvent
import riffet.core.TimelineItem
import kotlin.test.Test
import kotlin.test.assertEquals

class TimelineRowsTest {
    private val turn = "run:turn-1"
    private val at = "2026-11-22T05:39:00.000Z"

    private fun projected(sequence: Long, type: String, data: Map<String, String> = emptyMap()): ProjectedEvent {
        val base = WorkbenchEvent(
            sequence = sequence,
            sessionId = "session-1",
            runId = "turn-1",
            type = type,
            data = JsonObject(data.mapValues { JsonPrimitive(it.value) }),
            createdAt = at,
        )
        return ProjectedEvent(base = base, projectionKey = "event:$sequence", sourceEvents = listOf(base), turn = turn)
    }

    private fun user(sequence: Long, text: String) =
        TimelineItem.User(key = "user:$sequence", text = text, event = projected(sequence, "user_message_chunk"), attachments = emptyList())

    private fun assistant(sequence: Long, text: String) =
        TimelineItem.Assistant(key = "asst:$sequence", text = text, event = projected(sequence, "agent_message_chunk"))

    private fun tool(sequence: Long, kind: String, toolName: String) =
        TimelineItem.Tool(
            key = "tool:$sequence",
            event = projected(sequence, "tool_call", mapOf("toolCallId" to "call-$sequence", "kind" to kind, "toolName" to toolName, "status" to "completed")),
        )

    private fun describe(rows: List<TimelineRow>): List<String> = rows.map { row ->
        when (row) {
            is TimelineRow.Process -> "process(${row.items.joinToString(",") { it.key }})"
            is TimelineRow.Single -> "${row.item.key}:${row.footer.name}"
            is TimelineRow.Trigger -> "trigger"
        }
    }

    @Test
    fun `keeps unphased prose and AskQuestion outside process across skipped and answered continuations`() {
        val skipped = listOf(
            user(1, "Design tool calls"),
            assistant(2, "Reading code first."),
            tool(3, "read", "Read"),
            assistant(4, "Full design proposal."),
            tool(5, "question", "AskQuestion"),
            assistant(6, "Let me know your preference."),
        )
        assertEquals(
            listOf("user:1:NONE", "process(asst:2,tool:3)", "asst:4:NONE", "tool:5:NONE", "asst:6:SHOWN"),
            describe(buildTimelineRows(skipped, sessionRunning = false)),
        )

        val answered = listOf(
            user(1, "Review and fix"),
            tool(2, "read", "Read"),
            assistant(3, "Detailed analysis before asking."),
            tool(4, "question", "AskQuestion"),
            assistant(5, "Applying chosen option."),
            tool(6, "edit", "StrReplace"),
            assistant(7, "All edits completed."),
        )
        assertEquals(
            listOf("user:1:NONE", "process(tool:2)", "asst:3:NONE", "tool:4:NONE", "process(asst:5,tool:6)", "asst:7:SHOWN"),
            describe(buildTimelineRows(answered, sessionRunning = false)),
        )
    }

    @Test
    fun `keeps plan review tools outside process and carries footer when ending a turn`() {
        val items = listOf(
            user(1, "Make a plan"),
            tool(2, "read", "Read"),
            assistant(3, "Summary before plan review."),
            tool(4, "plan", "ExitPlanMode"),
        )
        val rows = buildTimelineRows(items, sessionRunning = false)
        assertEquals(
            listOf("user:1:NONE", "process(tool:2)", "asst:3:NONE", "tool:4:SHOWN"),
            describe(rows),
        )
        val planRow = rows.last() as TimelineRow.Single
        assertEquals("Summary before plan review.", planRow.answerText)
    }

    @Test
    fun `regroups when a tool updates its kind to an interaction tool`() {
        val before = listOf(
            user(1, "Ask me"),
            assistant(2, "Here is the context."),
            tool(3, "other", "AskQuestion"),
            assistant(4, "Closing."),
        )
        val grouping = buildTimelineGrouping(before, sessionRunning = false)
        assertEquals(listOf("user:1:NONE", "process(asst:2,tool:3)", "asst:4:SHOWN"), describe(grouping.rows))

        val after = listOf(
            before[0],
            before[1],
            tool(3, "question", "AskQuestion"),
            before[3],
        )
        val updated = updateTimelineGrouping(grouping, after, sessionRunning = false)
        assertEquals(listOf("user:1:NONE", "asst:2:NONE", "tool:3:NONE", "asst:4:SHOWN"), describe(updated.rows))
    }

    @Test
    fun `marks pre-Ask process as not running while post-Ask work is still active in the same turn`() {
        val items = listOf(
            user(1, "Coloring rules"),
            tool(2, "read", "Read"),
            assistant(3, "Which direction do you prefer?"),
            tool(4, "question", "AskQuestion"),
            TimelineItem.Tool(
                key = "tool:5",
                event = projected(5, "tool_call", mapOf("toolCallId" to "call-5", "kind" to "edit", "toolName" to "StrReplace", "status" to "in_progress")),
            ),
        )
        val rows = buildTimelineRows(items, sessionRunning = true)
        assertEquals(
            listOf("user:1:NONE", "process(tool:2)", "asst:3:NONE", "tool:4:NONE", "process(tool:5)"),
            describe(rows),
        )
        val beforeAsk = rows[1] as TimelineRow.Process
        val afterAsk = rows[4] as TimelineRow.Process
        assertEquals(false, beforeAsk.running)
        assertEquals(false, beforeAsk.turnActive)
        assertEquals(true, afterAsk.running)
        assertEquals(true, afterAsk.turnActive)
    }
}
