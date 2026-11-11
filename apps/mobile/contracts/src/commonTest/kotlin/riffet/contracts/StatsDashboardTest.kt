package riffet.contracts

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Golden fixture for `GET /api/stats/dashboard`. Inline: the
 * round-trip is what catches a renamed field, a null turned into zero, or a new unknown key.
 * Every token slot that the wire can omit is present as JSON null at least once.
 */
class StatsDashboardTest {

    private val json = RiffetJson.instance

    @Test
    fun `dashboard fixture keeps nulls and the values the charts read`() {
        val dashboard = json.decodeFromString(StatsDashboard.serializer(), STATS_DASHBOARD_FIXTURE)

        assertEquals("2026-09-08T16:00:00.000Z", dashboard.filter.from)
        assertEquals("2026-10-08T16:00:00.000Z", dashboard.filter.to)
        assertEquals("Asia/Shanghai", dashboard.filter.tz)
        assertEquals(listOf(NativeBackendId.CURSOR, NativeBackendId.CODEX), dashboard.filter.backends)
        assertEquals(StatsAgentKind.MAIN, dashboard.filter.agentKind)
        assertEquals(false, dashboard.filter.includeArchived)
        assertEquals(true, dashboard.filter.includeEstimated)
        assertEquals("2026-10-08T12:34:56.000Z", dashboard.generatedAt)

        val current = dashboard.summary.current
        assertEquals(7L, current.sessions)
        assertEquals(42L, current.runs)
        assertEquals(30L, current.states.completed)
        assertEquals(6L, current.states.failed)
        assertEquals(4L, current.states.cancelled)
        assertEquals(2L, current.states.interrupted)
        assertEquals(5L, current.activeDays)
        assertEquals(1_500_000L, current.totalTokens)
        assertEquals(0.5, current.cacheHitRate)
        assertEquals(180.0, current.ttftMs!!.p50)
        assertEquals(900.0, current.ttftMs!!.p99)
        assertEquals(12L, current.ttftMs!!.samples)
        assertNull(current.durationMs)
        assertEquals(32.5, current.outputTokensPerSecond!!.p50)
        assertNull(current.tokens.input)
        assertEquals(200L, current.tokens.cacheRead)
        assertNull(current.tokens.cacheWrite)
        assertEquals(80_000L, current.tokens.output)
        assertNull(current.tokens.reasoning)
        assertEquals(40L, current.tokens.estimatedOutput)
        assertNull(dashboard.summary.previous.cacheHitRate)
        assertNull(dashboard.summary.previous.ttftMs)
        assertEquals(3L, dashboard.summary.streakDays)

        assertEquals(StatsSeriesMetric.TOTAL_TOKENS, dashboard.series.metric)
        assertEquals(StatsGranularity.DAY, dashboard.series.granularity)
        assertEquals(StatsSplit.BACKEND, dashboard.series.split)
        assertEquals(NativeBackendId.CURSOR, dashboard.series.keys[0].backendId)
        assertEquals(1000.0, dashboard.series.points[0].values["cursor"])
        assertEquals(250.0, dashboard.series.points[0].values["codex"])
        // A bucket that recorded a real zero still carries 0. An omitted key is absent, not zero.
        assertEquals(0.0, dashboard.series.points[1].values["cursor"])
        assertNull(dashboard.series.points[1].values["codex"])

        val cursor = dashboard.backends.rows.single()
        assertEquals(StatsDimension.BACKEND, dashboard.backends.dimension)
        assertEquals(NativeBackendId.CURSOR, cursor.backendId)
        assertEquals(0.5, cursor.share)
        assertNull(cursor.failed)

        val model = dashboard.models.rows.single()
        assertNull(model.backendId)
        assertNull(model.tokens.input)
        assertNull(model.durationMs)
        assertEquals(0L, model.tokens.estimatedOutput)

        val tool = dashboard.tools.rows.single()
        assertEquals(StatsDimension.TOOL, dashboard.tools.dimension)
        assertEquals(11L, tool.count)
        assertEquals(2L, tool.failed)
        assertNull(tool.outputTokensPerSecond)

        assertEquals(7, dashboard.heatmap.weekHour.size)
        assertEquals(24, dashboard.heatmap.weekHour[1].size)
        assertEquals(4L, dashboard.heatmap.weekHour[1][10])
        assertEquals("2026-10-08", dashboard.heatmap.calendar.single().date)
        assertEquals(3L, dashboard.heatmap.calendar.single().runs)

        assertEquals("proj-1", dashboard.options.projects.single().key)
        assertNull(dashboard.options.profiles.single().backendId)
        assertEquals(NativeBackendId.DSH, dashboard.options.backends[3].backendId)

        val again = json.decodeFromString(
            StatsDashboard.serializer(),
            json.encodeToString(StatsDashboard.serializer(), dashboard),
        )
        assertNull(again.summary.current.tokens.input)
        assertEquals(40L, again.summary.current.tokens.estimatedOutput)
        assertNull(again.summary.current.durationMs)
        assertEquals(1_500_000L, again.summary.current.totalTokens)
    }

}

private const val HOUR_ROW = "[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]"

private val STATS_DASHBOARD_FIXTURE = """
{
  "unreleased": true,
  "filter": {
    "from": "2026-09-08T16:00:00.000Z",
    "to": "2026-10-08T16:00:00.000Z",
    "tz": "Asia/Shanghai",
    "backends": ["cursor", "codex"],
    "models": ["gpt-5"],
    "projects": ["proj-1"],
    "profiles": ["default"],
    "agentKind": "main",
    "includeArchived": false,
    "includeEstimated": true
  },
  "generatedAt": "2026-10-08T12:34:56.000Z",
  "summary": {
    "current": {
      "sessions": 7,
      "runs": 42,
      "states": {"completed": 30, "failed": 6, "cancelled": 4, "interrupted": 2},
      "activeDays": 5,
      "tokens": {"input": null, "cacheRead": 200, "cacheWrite": null, "output": 80000, "reasoning": null, "estimatedOutput": 40},
      "totalTokens": 1500000,
      "toolCalls": 11,
      "subagents": 1,
      "cacheHitRate": 0.5,
      "ttftMs": {"p50": 180, "p90": 400, "p99": 900, "samples": 12},
      "durationMs": null,
      "outputTokensPerSecond": {"p50": 32.5, "p90": 48, "p99": 70, "samples": 9}
    },
    "previous": {
      "sessions": 4,
      "runs": 20,
      "states": {"completed": 16, "failed": 4, "cancelled": 0, "interrupted": 0},
      "activeDays": 3,
      "tokens": {"input": 10, "cacheRead": 0, "cacheWrite": 0, "output": 20, "reasoning": 0, "estimatedOutput": 0},
      "totalTokens": 1000000,
      "toolCalls": 2,
      "subagents": 0,
      "cacheHitRate": null,
      "ttftMs": null,
      "durationMs": {"p50": 1000, "p90": 2000, "p99": 5000, "samples": 4},
      "outputTokensPerSecond": null
    },
    "streakDays": 3
  },
  "series": {
    "metric": "totalTokens",
    "granularity": "day",
    "split": "backend",
    "keys": [
      {"key": "cursor", "label": "Cursor", "backendId": "cursor"},
      {"key": "codex", "label": "Codex", "backendId": "codex"}
    ],
    "points": [
      {"start": "2026-10-07T16:00:00.000Z", "values": {"cursor": 1000, "codex": 250}},
      {"start": "2026-10-08T16:00:00.000Z", "values": {"cursor": 0}}
    ]
  },
  "backends": {
    "dimension": "backend",
    "rows": [{
      "key": "cursor", "label": "Cursor", "backendId": "cursor",
      "count": 30, "sessions": 5,
      "states": {"completed": 24, "failed": 4, "cancelled": 1, "interrupted": 1},
      "tokens": {"input": null, "cacheRead": 200, "cacheWrite": null, "output": 80000, "reasoning": null, "estimatedOutput": 40},
      "totalTokens": 1050000, "share": 0.5,
      "durationMs": {"p50": 1200, "p90": 2400, "p99": 8000, "samples": 10},
      "outputTokensPerSecond": {"p50": 30, "p90": 40, "p99": 60, "samples": 8}
    }]
  },
  "models": {
    "dimension": "model",
    "rows": [{
      "key": "gpt-5", "label": "GPT-5",
      "count": 18, "sessions": 4,
      "states": {"completed": 18, "failed": 0, "cancelled": 0, "interrupted": 0},
      "tokens": {"input": null, "cacheRead": null, "cacheWrite": null, "output": 500, "reasoning": null, "estimatedOutput": 0},
      "totalTokens": 500, "share": 0.3,
      "durationMs": null,
      "outputTokensPerSecond": null
    }]
  },
  "tools": {
    "dimension": "tool",
    "rows": [{
      "key": "shell", "label": "Shell",
      "count": 11, "sessions": 3,
      "states": {"completed": 9, "failed": 2, "cancelled": 0, "interrupted": 0},
      "tokens": {"input": null, "cacheRead": null, "cacheWrite": null, "output": null, "reasoning": null, "estimatedOutput": 0},
      "totalTokens": 0, "share": 1,
      "failed": 2,
      "durationMs": null,
      "outputTokensPerSecond": null
    }]
  },
  "heatmap": {
    "weekHour": [
      $HOUR_ROW,
      [0,0,0,0,0,0,0,0,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0],
      $HOUR_ROW,
      $HOUR_ROW,
      $HOUR_ROW,
      $HOUR_ROW,
      $HOUR_ROW
    ],
    "calendar": [{"date": "2026-10-08", "runs": 3, "totalTokens": 1500}]
  },
  "options": {
    "backends": [
      {"key": "cursor", "label": "Cursor", "backendId": "cursor"},
      {"key": "codex", "label": "Codex", "backendId": "codex"},
      {"key": "claude", "label": "Claude", "backendId": "claude"},
      {"key": "dsh", "label": "DeepSeek", "backendId": "dsh"}
    ],
    "models": [{"key": "gpt-5", "label": "GPT-5"}],
    "projects": [{"key": "proj-1", "label": "Riffet"}],
    "profiles": [{"key": "default", "label": "默认"}]
  }
}
""".trimIndent()
