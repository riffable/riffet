package riffet.shared

/*
 * The tool groups a conversation's agent is launched with (docs/DEVICES.md §2). Riffet's basic tools
 * are always on, so a person picks which paired phones the agent may control (`device:<id>`) and which
 * plugin tools it gets (`<pluginId>/<name>`, the browser); anything else the server reports is not offered here.
 */
object ToolGroups {
    const val DEVICE_PREFIX = "device:"

    fun deviceGroup(deviceId: String): String = DEVICE_PREFIX + deviceId

    /** The phone groups of [groups], in order and without repeats. */
    fun phones(groups: List<String>?): List<String> =
        groups.orEmpty().filter { it.startsWith(DEVICE_PREFIX) && it.length > DEVICE_PREFIX.length }.distinct()

    /** Phones that can be offered: paired, reporting a platform, allowing control, and online. */
    fun controllable(devices: List<PublicDevice>): List<PublicDevice> = devices.filter { it.platform != null && it.allowControl && it.online }

    /** A plugin's agent tools, `<pluginId>/<name>` (docs/BROWSER.md §2), such as the browser. */
    fun isPluginGroup(id: String): Boolean = PLUGIN_GROUP.matches(id)
    private val PLUGIN_GROUP = Regex("^[a-z0-9][a-z0-9-]*\\.[a-z0-9][a-z0-9.-]*/[a-z0-9][a-z0-9.-]*$")

    /** The phone and plugin groups of [groups], in order and without repeats. */
    fun picks(groups: List<String>?): List<String> =
        groups.orEmpty().filter { (it.startsWith(DEVICE_PREFIX) && it.length > DEVICE_PREFIX.length) || isPluginGroup(it) }.distinct()

    /**
     * The tool groups of the plugins that are on, plus any [value] names whose plugin is off now, so the pick can be
     * switched off. [PluginToolGroup.title] is by BCP-47 tag, as declared.
     */
    fun pluginGroups(plugins: List<PluginDescriptor>, value: List<String>): List<PluginToolGroup> = plugins.flatMap { plugin ->
        plugin.declared?.agentTools.orEmpty().mapNotNull { group ->
            if (plugin.enabled || group.id in value) PluginToolGroup(group.id, group.title, plugin.enabled) else null
        }
    }

    /**
     * [value] with [group] switched [on] or off. A phone that is no longer paired is dropped with the
     * change, so the server never gets a group it would refuse; one that went offline or stopped
     * allowing control stays until switched off. Only a controllable phone, or a plugin group whose plugin is on, can be switched on.
     */
    fun toggled(value: List<String>, devices: List<PublicDevice>, plugins: List<PluginToolGroup>?, group: String, on: Boolean): List<String> {
        val paired = devices.mapTo(HashSet()) { deviceGroup(it.id) }
        // Until the plugin list is read ([plugins] null), plugin picks are kept as they are.
        val listed = plugins?.mapTo(HashSet()) { it.id }
        val kept = picks(value).filter { it != group && (it in paired || (isPluginGroup(it) && (listed == null || it in listed))) }
        val usable = controllable(devices).any { deviceGroup(it.id) == group } || plugins.orEmpty().any { it.id == group && it.enabled }
        return if (on && usable) kept + group else kept
    }

    /** The last pick, as kept in the local preferences. */
    fun decode(raw: String?): List<String> = picks(raw?.split(','))

    fun encode(groups: List<String>): String? = picks(groups).joinToString(",").ifEmpty { null }
}

/** One plugin's agent tools as the picker lists them; [enabled] is false for a picked group whose plugin is off. */
data class PluginToolGroup(val id: String, val title: Map<String, String>, val enabled: Boolean) {
    /** The title in [language] (`zh`, `en`…), falling back to `zh-Hans`, `en`, then any. */
    fun label(language: String): String =
        title.entries.firstOrNull { it.key.substringBefore('-').equals(language, ignoreCase = true) }?.value
            ?: title["zh-Hans"] ?: title["en"] ?: title.values.firstOrNull() ?: id
}
