package riffet.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// RiffetApi endpoints — plugin commands (docs/design/plugin-system.md §4.3). The command ID is `<pluginId>/<name>`; a client lists the commands from `PluginDescriptor.declared` and runs one here.

/**
 * What a command did, by [kind]: `done` (with a [message] to show, BCP-47 tag -> text), `open` (a sidebar
 * [view], a [sessionId], a project-relative [path]; each optional) or `task` (a [taskId] it started).
 */
@Serializable
data class PluginCommandResult(
    val kind: String,
    val message: Map<String, String>? = null,
    val view: String? = null,
    val sessionId: String? = null,
    val path: String? = null,
    val taskId: String? = null,
)

/** What running a command came to: its [result], or the [confirmation] of a task it starts that the reader must approve first. */
class PluginCommandRun(val result: PluginCommandResult?, val confirmation: TaskConfirmation?)

@Serializable
internal data class PluginCommandBody(
    val requestId: String,
    val projectId: String? = null,
    val sessionId: String? = null,
    val args: Map<String, JsonElement> = emptyMap(),
    val confirm: String? = null,
)

/**
 * The values of [params] as the server takes them: a field the reader filled in keeps that value (a
 * boolean as one), an empty one takes its default, and a field with neither is left out.
 */
internal fun commandArgs(values: Map<String, String>, params: List<TaskParamField>): Map<String, JsonElement> = buildMap {
    for (field in params) {
        val value = values[field.key]
        when {
            value.isNullOrEmpty() -> field.default?.let { put(field.key, it) }
            field.kind == "boolean" -> put(field.key, JsonPrimitive(value == "true"))
            else -> put(field.key, JsonPrimitive(value))
        }
    }
}

/**
 * Runs the command `<pluginId>/<name>`. A repeat with the same [requestId] returns the same result
 * without running it twice; [confirm] is the fingerprint of a [TaskConfirmation] the reader approved.
 * [values] are the reader's input by [TaskParamField.key], as text.
 */
@Throws(Exception::class)
suspend fun RiffetApi.runCommand(
    commandId: String,
    requestId: String,
    projectId: String?,
    sessionId: String?,
    values: Map<String, String>,
    params: List<TaskParamField>,
    confirm: String?,
): PluginCommandRun {
    val split = commandId.indexOf('/')
    require(split > 0 && split < commandId.length - 1) { "not a command id: $commandId" }
    val path = "/api/integrations/${commandId.substring(0, split).enc()}/commands/${commandId.substring(split + 1).enc()}"
    val body = PluginCommandBody(requestId, projectId, sessionId, commandArgs(values, params), confirm)
    return try {
        PluginCommandRun(post(path, wireBody(body)).decode<PluginCommandResult>(), null)
    } catch (refused: RiffetHttpException) {
        PluginCommandRun(null, refused.taskConfirmation() ?: throw refused)
    }
}
