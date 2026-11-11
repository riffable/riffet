package riffet.contracts

/**
 * Agent identity beyond the closed [NativeBackendId] (docs/design/plugin-system.md §5.1).
 *
 * The enum stays what Android and iOS compile against and never gains a plugin's id. A client that
 * names [PLUGIN_AGENTS_FEATURE] (today only the macOS app) is also sent Agents a plugin provides,
 * whose ids are namespaced strings such as `acme.gemini`. For those the DTOs carry the raw id in a
 * sidecar `agentId` field and a stand-in in the typed field; a reader that may meet one asks the
 * DTO's `agent` (the raw id, whichever kind it is) and never compares the typed field.
 */
object AgentIds {
    /** The `X-Riffet-Features` value that makes the server send plugin Agent ids. */
    const val PLUGIN_AGENTS_FEATURE = "plugin-agents"

    private const val PLUGIN_AGENT_ID_MAX = 64
    private val pluginAgent = Regex("^[a-z0-9][a-z0-9-]*\\.[a-z0-9][a-z0-9.-]*$")

    /** A well-formed id of an Agent a plugin provides; built-in ids have no dot. */
    fun isPlugin(raw: String): Boolean = raw.length <= PLUGIN_AGENT_ID_MAX && pluginAgent.matches(raw)

    /** The built-in Agent [raw] names, or null for a plugin's or an unknown id. */
    fun builtin(raw: String): NativeBackendId? = NativeBackendId.entries.firstOrNull { wire(it) == raw }

    /** The wire spelling of a built-in id: its `@SerialName`, not its Kotlin constant name. */
    fun wire(id: NativeBackendId): String = when (id) {
        NativeBackendId.CURSOR -> "cursor"
        NativeBackendId.CODEX -> "codex"
        NativeBackendId.CLAUDE -> "claude"
        NativeBackendId.DSH -> "dsh"
        NativeBackendId.DROID -> "droid"
        NativeBackendId.TRAEX -> "traex"
        NativeBackendId.PI -> "pi"
        NativeBackendId.CHAT -> "chat"
    }
}
