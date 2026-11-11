package riffet.shared

import riffet.contracts.ExtensionToggles
import riffet.contracts.LoadedExtensions
import riffet.contracts.NativeBackendCapabilities
import riffet.contracts.NativeBackendId

/*
 * The MCP servers and Skills a conversation's agent is launched without (docs/EXTENSIONS.md, 按对话开关).
 * An entry is `mcp:<name>` or `skill:<name>`; the list is what is off, so empty means everything the
 * user installed is on. Riffet's own `riffet` MCP is never listed and never switched off.
 */
object ExtensionsOff {
    const val MCP_PREFIX = "mcp:"
    const val SKILL_PREFIX = "skill:"
    private const val OWN_MCP = "riffet"

    fun mcp(name: String): String = MCP_PREFIX + name

    fun skill(name: String): String = SKILL_PREFIX + name

    /** [value] without repeats, unknown shapes, and the `riffet` MCP. */
    fun clean(value: List<String>?): List<String> = value.orEmpty().filter(::valid).distinct()

    private fun valid(item: String): Boolean = when {
        item.startsWith(MCP_PREFIX) -> item.length > MCP_PREFIX.length && item != mcp(OWN_MCP)
        item.startsWith(SKILL_PREFIX) -> item.length > SKILL_PREFIX.length
        else -> false
    }

    /** The names in [value] behind [prefix], in order. */
    fun names(value: List<String>?, prefix: String): List<String> =
        clean(value).filter { it.startsWith(prefix) }.map { it.substring(prefix.length) }

    /** [value] with [item] switched [on] (removed) or off (added). */
    fun toggled(value: List<String>?, item: String, on: Boolean): List<String> {
        val kept = clean(value).filter { it != item }
        return if (on) kept else clean(kept + item)
    }

    /** The kinds this backend can switch off, or null when it has none. */
    fun toggles(capabilities: NativeBackendCapabilities?): ExtensionToggles? =
        capabilities?.extensionToggles?.takeIf { it.mcp || it.skills }

    /** What the listing shows for one kind: the loaded names, then the switched-off ones the listing no longer has. */
    fun listed(loaded: List<String>, value: List<String>?, prefix: String): List<String> {
        val known = loaded.filter { prefix != MCP_PREFIX || it != OWN_MCP }.distinct()
        return known + names(value, prefix).filter { it !in known }
    }
}

/**
 * What a launch loads, kept in memory for the app session per backend, provider and project; the
 * server caches it too, and a first read may take seconds. A different [RiffetApi] (another account
 * or server) starts empty.
 */
object LoadedExtensionsCache {
    private var owner: RiffetApi? = null
    private val entries = HashMap<String, LoadedExtensions>()

    private fun key(backendId: NativeBackendId, profileId: String?, projectId: String) = "$backendId|${profileId.orEmpty()}|$projectId"

    private fun forApi(api: RiffetApi) {
        if (owner !== api) {
            owner = api
            entries.clear()
        }
    }

    fun peek(api: RiffetApi, backendId: NativeBackendId, profileId: String?, projectId: String): LoadedExtensions? {
        forApi(api)
        return entries[key(backendId, profileId, projectId)]
    }

    @Throws(Exception::class)
    suspend fun load(api: RiffetApi, backendId: NativeBackendId, profileId: String?, projectId: String, force: Boolean): LoadedExtensions {
        forApi(api)
        val key = key(backendId, profileId, projectId)
        if (!force) entries[key]?.let { return it }
        val loaded = api.loadedExtensions(backendId, profileId, projectId)
        if (owner === api) entries[key] = loaded
        return loaded
    }
}
