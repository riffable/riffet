package riffet.ui.pickers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.intl.Locale
import kotlinx.coroutines.CancellationException
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.ExtensionToggles
import riffet.contracts.NativeBackendCapabilities
import riffet.contracts.NativeBackendId
import riffet.shared.ExtensionsOff
import riffet.shared.LoadedExtensionsCache
import riffet.shared.PluginToolGroup
import riffet.shared.plugins
import riffet.shared.PublicDevice
import riffet.shared.RiffetApi
import riffet.shared.ToolGroups
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetProgressIndicator
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.rememberVisualHostResumed
import riffet_mobile.shared.generated.resources.*

/*
 * 技能与工具: which paired phones the conversation's agent may control (docs/DEVICES.md §2), and which
 * MCP servers and Skills it starts without (docs/EXTENSIONS.md). Riffet's own basic tools are always
 * on. The web's `ToolsPicker.tsx` is the model; the phone keeps the same rules (only phones online and
 * allowing control are offered, one that is gone drops with the next change) in a page of the
 * send-settings sheet.
 */

/**
 * The MCP and Skill switches of one conversation. [off] is the `mcp:` / `skill:` entries that are
 * off; [onChange] gets the whole new list.
 */
internal class ExtensionsPick(
    val api: RiffetApi,
    val backendId: NativeBackendId,
    val profileId: String?,
    val projectId: String,
    val toggles: ExtensionToggles,
    val off: List<String>,
    val onChange: (List<String>) -> Unit,
)

/** The switches, when the backend has some and the conversation is not a quick chat or archived. */
internal fun extensionsPick(
    api: RiffetApi?,
    allowed: Boolean,
    capabilities: NativeBackendCapabilities?,
    backendId: NativeBackendId?,
    profileId: String?,
    projectId: String?,
    off: List<String>,
    onChange: (List<String>) -> Unit,
): ExtensionsPick? {
    val toggles = ExtensionsOff.toggles(capabilities)
    if (!allowed || api == null || backendId == null || projectId == null || toggles == null) return null
    return ExtensionsPick(api, backendId, profileId, projectId, toggles, off, onChange)
}

/**
 * Whether [pick] has any MCP server or Skill to list: read once when the composer appears (kept for
 * the app session, so a second visit knows on its first frame). Null while unknown or unreadable,
 * which keeps the row: only a list known to be empty hides it.
 */
@Composable
internal fun rememberExtensionsListed(pick: ExtensionsPick?): Boolean? {
    val readKey = pick?.let { "${it.backendId}|${it.profileId}|${it.projectId}" }
    var loaded by remember(readKey, pick?.api) {
        mutableStateOf(pick?.let { LoadedExtensionsCache.peek(it.api, it.backendId, it.profileId, it.projectId) })
    }
    LaunchedEffect(readKey) {
        val source = pick ?: return@LaunchedEffect
        if (loaded != null) return@LaunchedEffect
        try {
            loaded = LoadedExtensionsCache.load(source.api, source.backendId, source.profileId, source.projectId, force = false)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            // Unknown stays shown; the page itself offers the retry.
        }
    }
    val reading = loaded ?: return null
    if (pick == null) return null
    return (pick.toggles.mcp && ExtensionsOff.listed(reading.mcp.map { it.name }, pick.off, ExtensionsOff.MCP_PREFIX).isNotEmpty()) ||
        (pick.toggles.skills && ExtensionsOff.listed(reading.skills.map { it.name }, pick.off, ExtensionsOff.SKILL_PREFIX).isNotEmpty())
}

/**
 * The paired devices, read when the composer appears and again when the app comes back to the
 * foreground; never polled. Null until the first read answers, and a failed read keeps what was last seen.
 */
@Composable
internal fun rememberToolDevices(api: RiffetApi?, enabled: Boolean): List<PublicDevice>? {
    val resumed = rememberVisualHostResumed()
    var devices by remember(api) { mutableStateOf<List<PublicDevice>?>(null) }
    LaunchedEffect(api, enabled, resumed) {
        if (api == null || !enabled || !resumed) return@LaunchedEffect
        try {
            devices = api.devices()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            // The picker simply stays as it was; the next return to the app reads again.
        }
    }
    return devices
}

/**
 * The plugins' agent tools (the browser, docs/BROWSER.md §2), read with the devices: when the composer appears and when
 * the app comes back. Null until the first read answers; [value] keeps a picked group listed after its plugin turned off.
 */
@Composable
internal fun rememberPluginToolGroups(api: RiffetApi?, enabled: Boolean, value: List<String>): List<PluginToolGroup>? {
    val resumed = rememberVisualHostResumed()
    var plugins by remember(api) { mutableStateOf<List<riffet.shared.PluginDescriptor>?>(null) }
    LaunchedEffect(api, enabled, resumed) {
        if (api == null || !enabled || !resumed) return@LaunchedEffect
        try {
            plugins = api.plugins()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            // Stays as it was; the next return to the app reads again.
        }
    }
    return plugins?.let { ToolGroups.pluginGroups(it, value) }
}

/** There is something to pick, or something already picked that can be switched off. */
internal fun toolsOffered(devices: List<PublicDevice>?, value: List<String>, plugins: List<PluginToolGroup>? = null): Boolean =
    value.isNotEmpty() || devices?.let { ToolGroups.controllable(it).isNotEmpty() } == true || plugins?.any { it.enabled } == true

/** A new conversation's pick: the remembered phones and plugin tools that can be offered now. One offline is kept for the next. */
internal fun offeredPicks(devices: List<PublicDevice>?, value: List<String>, plugins: List<PluginToolGroup>? = null): List<String> {
    val offered = devices?.let(ToolGroups::controllable).orEmpty().mapTo(HashSet()) { ToolGroups.deviceGroup(it.id) }
    plugins.orEmpty().filter { it.enabled }.mapTo(offered) { it.id }
    return ToolGroups.picks(value).filter { it in offered }
}

/** The value shown on the send-settings row: the phones picked, then how many MCP servers and Skills are off. */
@Composable
internal fun toolsSummary(value: List<String>, off: List<String> = emptyList(), switches: Boolean = false): String = when {
    // With switches and nothing changed, everything installed is on.
    off.isEmpty() && value.isEmpty() -> stringResource(if (switches) Res.string.pickers_tools_default else Res.string.pickers_tools_off)
    off.isEmpty() -> stringResource(Res.string.pickers_tools_count, value.size)
    value.isEmpty() -> stringResource(Res.string.pickers_tools_closed, off.size)
    else -> stringResource(Res.string.pickers_tools_count_closed, value.size, off.size)
}

/**
 * The phone list and the MCP and Skill switches as one page of a sheet; see [ModePickerPage]. A pick
 * changes the selection and keeps the page open. [footnote] is for a selection that does not apply to
 * the running CLI yet. The switches are read when the page opens; phones never wait on them.
 */
@Composable
internal fun ToolsPickerPage(
    value: List<String>,
    devices: List<PublicDevice>?,
    onChange: (List<String>) -> Unit,
    plugins: List<PluginToolGroup>? = null,
    extensions: ExtensionsPick? = null,
    footnote: String? = null,
    error: String? = null,
    enabled: Boolean = true,
    onBack: (() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val controllable = devices?.let(ToolGroups::controllable).orEmpty()
    // A phone in the value that is no longer offered stays listed, so it can be switched off.
    val offered = controllable.map { ToolGroups.deviceGroup(it.id) }
    val stale = if (devices == null) emptyList() else ToolGroups.phones(value).filter { it !in offered }
    // Read when the page opens, and kept for the app session; the first frame already has what was read before.
    val readKey = extensions?.let { "${it.backendId}|${it.profileId}|${it.projectId}" }
    var loaded by remember(readKey, extensions?.api) {
        mutableStateOf(extensions?.let { LoadedExtensionsCache.peek(it.api, it.backendId, it.profileId, it.projectId) })
    }
    var failed by remember(readKey) { mutableStateOf(false) }
    var attempt by remember(readKey) { mutableIntStateOf(0) }
    LaunchedEffect(readKey, attempt) {
        val source = extensions ?: return@LaunchedEffect
        if (loaded != null && attempt == 0) return@LaunchedEffect
        failed = false
        try {
            loaded = LoadedExtensionsCache.load(source.api, source.backendId, source.profileId, source.projectId, force = attempt > 0)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            failed = true
        }
    }
    PickerPage(title = stringResource(Res.string.pickers_tools_title), onBack = onBack) {
        error?.let { SheetNotice(stringResource(Res.string.session_last_change_failed, it), SettingsNoticeKind.ERROR) }
        Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = metrics.rowPadding)) {
            val language = Locale.current.language
            plugins.orEmpty().forEach { group ->
                OptionRow(
                    label = group.label(language),
                    selected = group.id in value,
                    description = if (group.enabled) null else stringResource(Res.string.settings_disabled),
                    onClick = { onChange(ToolGroups.toggled(value, devices.orEmpty(), plugins, group.id, group.id !in value)) },
                    disabledReason = "".takeUnless { enabled },
                    multiple = true,
                )
            }
            if (controllable.isNotEmpty() || stale.isNotEmpty()) SectionLabel(stringResource(Res.string.pickers_tools_phones))
            controllable.forEach { device ->
                val group = ToolGroups.deviceGroup(device.id)
                OptionRow(
                    label = stringResource(Res.string.pickers_tools_control, device.name),
                    selected = group in value,
                    onClick = { onChange(ToolGroups.toggled(value, devices.orEmpty(), plugins, group, group !in value)) },
                    disabledReason = "".takeUnless { enabled },
                    multiple = true,
                )
            }
            stale.forEach { group ->
                val known = devices?.firstOrNull { ToolGroups.deviceGroup(it.id) == group }
                OptionRow(
                    label = known?.let { stringResource(Res.string.pickers_tools_control, it.name) } ?: stringResource(Res.string.pickers_tools_removed),
                    selected = true,
                    description = known?.takeIf { !it.online }?.let { stringResource(Res.string.pickers_tools_offline) },
                    onClick = { onChange(ToolGroups.toggled(value, devices.orEmpty(), plugins, group, false)) },
                    disabledReason = "".takeUnless { enabled },
                    multiple = true,
                )
            }
            val reading = loaded
            if (extensions != null) {
                if (reading != null) {
                    if (extensions.toggles.mcp) {
                        ExtensionRows(
                            title = stringResource(Res.string.pickers_tools_mcp),
                            names = ExtensionsOff.listed(reading.mcp.map { it.name }, extensions.off, ExtensionsOff.MCP_PREFIX),
                            prefix = ExtensionsOff.MCP_PREFIX,
                            toolCounts = reading.mcp.mapNotNull { server -> server.tools?.let { server.name to it } }.toMap(),
                            pick = extensions,
                            enabled = enabled,
                        )
                    }
                    if (extensions.toggles.skills) {
                        ExtensionRows(
                            title = stringResource(Res.string.pickers_tools_skills),
                            names = ExtensionsOff.listed(reading.skills.map { it.name }, extensions.off, ExtensionsOff.SKILL_PREFIX),
                            prefix = ExtensionsOff.SKILL_PREFIX,
                            toolCounts = emptyMap(),
                            pick = extensions,
                            enabled = enabled,
                        )
                    }
                } else if (failed) {
                    SheetNotice(stringResource(Res.string.pickers_tools_unreadable), SettingsNoticeKind.ERROR, stringResource(Res.string.pickers_retry)) { attempt++ }
                } else {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = metrics.rowPadding),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RiffetProgressIndicator(modifier = Modifier.size(metrics.smallIconSize), strokeWidth = metrics.focusWidth, color = colors.fg3)
                    }
                }
            }
            footnote?.let {
                Text(
                    text = it,
                    style = typography.caption,
                    color = colors.fg3,
                    modifier = Modifier.fillMaxWidth().padding(start = SheetInset, end = SheetInset, top = metrics.rowPadding / 2),
                )
            }
        }
    }
}

/** One kind of switch as a section; nothing is drawn for a kind with nothing to list. */
@Composable
private fun ExtensionRows(
    title: String,
    names: List<String>,
    prefix: String,
    toolCounts: Map<String, Int>,
    pick: ExtensionsPick,
    enabled: Boolean,
) {
    if (names.isEmpty()) return
    val typography = LocalRiffetTypography.current
    SectionLabel(title)
    names.forEach { name ->
        val item = prefix + name
        val on = item !in pick.off
        OptionRow(
            label = name,
            selected = on,
            onClick = { pick.onChange(ExtensionsOff.toggled(pick.off, item, !on)) },
            disabledReason = "".takeUnless { enabled },
            trailing = toolCounts[name]?.let { count -> { Text(count.toString(), style = typography.bodySmall) } },
            multiple = true,
        )
    }
}
