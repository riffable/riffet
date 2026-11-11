package riffet.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

// RiffetApi endpoints — project tasks (docs/TASKS.md): a build the server runs for a project, outliving any client. Transport and auth rules: see RiffetApi.kt.

/*
 * `packages/contracts/src/tasks.ts`. Enum-like values (`state`, `severity`, `kind`) stay strings so a
 * value a newer server adds cannot fail a list.
 */

/**
 * The server's `Task`. Named `ProjectTask` here because a type called `Task` would shadow Swift's
 * concurrency `Task` in every file that imports `RiffetKit`.
 *
 * [state] is `running`, `cancelling`, `succeeded`, `failed`, `cancelled` or `unknown`; [title] is
 * BCP-47 tag -> text; [startedAt] and the other times are ISO 8601; [logSize] counts bytes.
 */
@Serializable
data class ProjectTask(
    val id: String,
    val requestId: String = "",
    val projectId: String = "",
    val pluginId: String = "",
    val providerId: String = "",
    val providerVersion: String = "",
    val actionId: String = "",
    val title: Map<String, String> = emptyMap(),
    val params: Map<String, JsonElement> = emptyMap(),
    val state: String = "unknown",
    val exitCode: Int? = null,
    val startedAt: String = "",
    val endedAt: String? = null,
    val cancelRequestedAt: String? = null,
    val logSize: Long = 0,
    val diagnostics: List<TaskDiagnostic>? = null,
    val artifacts: List<TaskArtifact>? = null,
    /** Why [state] is `unknown`. */
    val unknownReason: String? = null,
)

/** [severity] is `error` or `warning`; [file] is project-relative. */
@Serializable
data class TaskDiagnostic(
    val severity: String = "error",
    val message: String = "",
    val file: String? = null,
    val line: Int? = null,
    val column: Int? = null,
)

@Serializable
data class TaskArtifact(
    val id: String,
    val name: String = "",
    /** Project-relative. */
    val path: String = "",
    val size: Long = 0,
    val sha256: String = "",
)

/** A value an action takes; [kind] is `text`, `boolean` or `choice`. */
@Serializable
data class TaskParamField(
    val key: String,
    val label: Map<String, String> = emptyMap(),
    val kind: String = "text",
    val options: List<String>? = null,
    val default: JsonElement? = null,
    val required: Boolean = false,
)

@Serializable
data class TaskAction(
    val providerId: String,
    val pluginId: String = "",
    val id: String,
    val title: Map<String, String> = emptyMap(),
    val params: List<TaskParamField>? = null,
)

/** [projectTypes] are the types of the providers that recognise the project: what a view's `when.projectType` is matched against. */
@Serializable
data class TaskActionsResponse(val actions: List<TaskAction> = emptyList(), val projectTypes: List<String> = emptyList())

@Serializable
data class TasksResponse(val tasks: List<ProjectTask> = emptyList())

/** The bytes `[from, to)` of a task's log; [eof] is true once the task ended and [to] is its end. */
@Serializable
data class TaskLogChunk(val from: Long = 0, val to: Long = 0, val text: String = "", val eof: Boolean = false)

/**
 * `POST /api/tasks`. The same [requestId] with the same request returns the same task. [confirm] is
 * the fingerprint of a [TaskConfirmation] the reader approved.
 */
@Serializable
data class TaskCreate(
    val requestId: String,
    val projectId: String,
    val providerId: String,
    val actionId: String,
    val params: Map<String, JsonElement> = emptyMap(),
    val confirm: String? = null,
)

/** The `task` event of `/api/lists/stream`. */
@Serializable
data class TaskEvent(val id: String, val projectId: String = "", val state: String = "unknown")

/**
 * What starting a task came to: the [task] that was started (or returned again), the [holderId] of the
 * running task that holds the lock, or the [confirmation] the reader must approve first.
 */
class StartedTask(val task: ProjectTask?, val holderId: String?, val confirmation: TaskConfirmation? = null)

/**
 * The command a task of an installed package would run, answered as 409 `TASK_CONFIRM_REQUIRED` until
 * the reader approves it. Sending the same request again with [fingerprint] as `confirm` runs it; the
 * server remembers the approval. [cwd] is project-relative.
 */
class TaskConfirmation(
    val fingerprint: String,
    val file: String,
    val args: List<String>,
    val cwd: String,
    val env: Map<String, String>,
)

/** The confirmation a refusal carries, or null when it is another refusal. */
internal fun RiffetHttpException.taskConfirmation(): TaskConfirmation? {
    if (status != 409 || code != "TASK_CONFIRM_REQUIRED") return null
    val details = details as? JsonObject ?: return null
    val fingerprint = (details["fingerprint"] as? JsonPrimitive)?.contentOrNull ?: return null
    val plan = details["plan"] as? JsonObject ?: return null
    val file = (plan["file"] as? JsonPrimitive)?.contentOrNull ?: return null
    return TaskConfirmation(
        fingerprint = fingerprint,
        file = file,
        args = (plan["args"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty(),
        cwd = (plan["cwd"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
        env = (plan["env"] as? JsonObject)?.mapNotNull { (key, value) -> (value as? JsonPrimitive)?.contentOrNull?.let { key to it } }?.toMap().orEmpty(),
    )
}

/** The default of a form field as text; a boolean's is `true` or `false`. */
fun TaskParamField.defaultText(): String? = (default as? JsonPrimitive)?.contentOrNull

@Throws(Exception::class)
suspend fun RiffetApi.taskActions(projectId: String): TaskActionsResponse =
    get("/api/projects/${projectId.enc()}/task-actions").decode()

/** The project's recent tasks, newest first. */
@Throws(Exception::class)
suspend fun RiffetApi.tasks(projectId: String, limit: Int = 20): List<ProjectTask> =
    get("/api/tasks", listOf("projectId" to projectId, "limit" to limit.toString())).decode<TasksResponse>().tasks

@Throws(Exception::class)
suspend fun RiffetApi.task(id: String): ProjectTask =
    get("/api/tasks/${id.enc()}").decode()

/**
 * 409 `TASK_BUSY` is not a failure here: another task holds the project's lock, and [StartedTask.holderId]
 * names it so the caller can show that one. Neither is 409 `TASK_CONFIRM_REQUIRED`, which comes back as
 * [StartedTask.confirmation]. Any other refusal is thrown.
 */
@Throws(Exception::class)
suspend fun RiffetApi.startTask(body: TaskCreate): StartedTask = try {
    StartedTask(post("/api/tasks", wireBody(body)).decode<ProjectTask>(), null)
} catch (refused: RiffetHttpException) {
    val confirmation = refused.taskConfirmation()
    val holder = (refused.details as? JsonObject)?.get("taskId")?.jsonPrimitive?.contentOrNull
    when {
        confirmation != null -> StartedTask(null, null, confirmation)
        refused.status == 409 && refused.code == "TASK_BUSY" && holder != null -> StartedTask(null, holder)
        else -> throw refused
    }
}

/** Asks the task to stop; it is `cancelling` until the server sees the process exit. A finished task comes back as it is. */
@Throws(Exception::class)
suspend fun RiffetApi.cancelTask(id: String): ProjectTask =
    post("/api/tasks/${id.enc()}/cancel").decode()

/** A window of the log from byte [from]; the next window starts at the returned `to`. */
@Throws(Exception::class)
suspend fun RiffetApi.taskLog(id: String, from: Long, limit: Int = 64 * 1024): TaskLogChunk =
    get("/api/tasks/${id.enc()}/log", listOf("from" to from.toString(), "limit" to limit.toString())).decode()

/** Where an artifact downloads from; the request needs the device token like any other. */
fun RiffetApi.taskArtifactUrl(taskId: String, artifactId: String): String =
    "$baseUrl/api/tasks/${taskId.enc()}/artifacts/${artifactId.enc()}"
