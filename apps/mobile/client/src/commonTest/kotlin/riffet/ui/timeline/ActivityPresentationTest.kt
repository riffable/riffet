package riffet.ui.timeline

import riffet.contracts.NativeActivity
import riffet.contracts.NativeActivityCompaction
import riffet.contracts.NativeActivityKind
import riffet.contracts.NativeActivityStatus
import riffet.contracts.NativeActivityStop
import riffet.i18n.L10n
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ActivityPresentationTest {
    // The assertions below pin the source-locale copy; the JVM and Apple hosts may run in English.
    // `L10n.locale` is a getter over the platform locale plus a test override, so capturing the
    // current value and writing it back in `@AfterTest` leaves other tests on their own locale.
    private val locale = L10n.locale

    @BeforeTest
    fun useSourceLocale() {
        L10n.locale = "zh-Hans"
    }

    @AfterTest
    fun restoreLocale() {
        L10n.locale = locale
    }

    @Test
    fun `a finished compaction reads as one line and leaves missing numbers out`() {
        val done = NativeActivity(
            id = "a", kind = NativeActivityKind.COMPACTION, status = NativeActivityStatus.COMPLETED,
            durationMs = 110_000, compaction = NativeActivityCompaction("manual", preTokens = 435_000, postTokens = 13_000),
        )
        assertEquals("上下文已压缩 · 43.5 万 → 1.3 万 · 1 分 50 秒", activityView(done).summary)
        assertEquals("上下文已压缩", activityView(done.copy(durationMs = null, compaction = null)).summary)
    }

    @Test
    fun `a running session-wide stop is warned about and a stop in flight reads as stopping`() {
        val task = NativeActivity(id = "t", kind = NativeActivityKind.BACKGROUND_TASK, status = NativeActivityStatus.RUNNING, title = "npm test", stop = NativeActivityStop("session"))
        val view = activityView(task)
        assertTrue(view.canStop)
        assertEquals("将停止全部后台任务", view.stopWarning)
        val stopping = activityView(task, stopping = true)
        assertFalse(stopping.canStop)
        assertTrue(stopping.summary.contains("停止中"))
    }
}

class TaskNoticePresentationTest {
    private val locale = L10n.locale

    @BeforeTest
    fun useSourceLocale() {
        L10n.locale = "zh-Hans"
    }

    @AfterTest
    fun restoreLocale() {
        L10n.locale = locale
    }

    private fun notice(kind: String, status: riffet.core.TaskNotificationStatus, exitCode: Long? = null, title: String = "t", runningMs: Long? = null) =
        riffet.core.TimelineItem.TaskNotification(
            key = "n", taskKind = kind, status = status, title = title, command = "npm test",
            jobResult = exitCode?.let { riffet.core.TaskNotificationResult("j", riffet.core.TaskNotificationResultStatus.SUCCEEDED, it, runningMs) },
            event = riffet.contracts.WorkbenchEvent(sequence = 1, sessionId = "s", runId = "r", type = "task_notification", createdAt = "2026-01-01T00:00:00Z").let {
                riffet.core.ProjectedEvent(base = it, projectionKey = "event:1", sourceEvents = listOf(it))
            },
        )

    @Test
    fun `a completed notice with a non-zero exit code reads as failed and shows the code`() {
        val view = taskNoticeView(notice("shell", riffet.core.TaskNotificationStatus.COMPLETED, exitCode = 2, runningMs = 3_000))
        assertTrue(view.failed)
        assertEquals("后台命令失败", view.headline)
        assertEquals(listOf("3s", "退出码 2"), view.figures)
        assertEquals("后台命令已完成", taskNoticeView(notice("shell", riffet.core.TaskNotificationStatus.COMPLETED, exitCode = 0)).headline)
        assertEquals("监控事件", taskNoticeView(notice("monitor", riffet.core.TaskNotificationStatus.RUNNING)).headline)
        assertEquals(null, taskNoticeView(notice("subagent", riffet.core.TaskNotificationStatus.CANCELLED, title = "子 Agent")).name)
        // A notice that is not a task's end (a peer's message) keeps its own title.
        val message = taskNoticeView(notice("message", riffet.core.TaskNotificationStatus.COMPLETED, title = "Message from Codex"))
        assertEquals("Message from Codex", message.headline)
        assertEquals(null, message.name)
    }
}
