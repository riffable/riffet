package riffet.shared

/*
 * The tool groups a conversation's agent is launched with (docs/DEVICES.md §2). Riffet's basic tools
 * are always on, so the only thing a person picks is which paired phones the agent may control; a
 * group is `device:<id>`, and anything else the server reports is not offered here.
 */
object ToolGroups {
    const val DEVICE_PREFIX = "device:"

    fun deviceGroup(deviceId: String): String = DEVICE_PREFIX + deviceId

    /** The phone groups of [groups], in order and without repeats. */
    fun phones(groups: List<String>?): List<String> =
        groups.orEmpty().filter { it.startsWith(DEVICE_PREFIX) && it.length > DEVICE_PREFIX.length }.distinct()

    /** Phones that can be offered: paired, reporting a platform, allowing control, and online. */
    fun controllable(devices: List<PublicDevice>): List<PublicDevice> = devices.filter { it.platform != null && it.allowControl && it.online }

    /**
     * [value] with [group] switched [on] or off. A phone that is no longer paired is dropped with the
     * change, so the server never gets a group it would refuse; one that went offline or stopped
     * allowing control stays until switched off. Only a controllable phone can be switched on.
     */
    fun toggled(value: List<String>, devices: List<PublicDevice>, group: String, on: Boolean): List<String> {
        val paired = devices.mapTo(HashSet()) { deviceGroup(it.id) }
        val kept = phones(value).filter { it != group && it in paired }
        return if (on && controllable(devices).any { deviceGroup(it.id) == group }) kept + group else kept
    }

    /** The last pick, as kept in the local preferences. */
    fun decode(raw: String?): List<String> = phones(raw?.split(','))

    fun encode(groups: List<String>): String? = phones(groups).joinToString(",").ifEmpty { null }
}
