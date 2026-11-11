package riffet.ui.settings

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import riffet.contracts.OWNER_NAME_MAX
import riffet.contracts.OwnerAvatar as OwnerAvatarFile
import riffet.contracts.OwnerAvatarStyle
import riffet.contracts.OwnerInfo
import riffet.i18n.L10n
import org.jetbrains.compose.resources.rememberResourceEnvironment
import riffet.shared.RiffetApi
import riffet.shared.deleteOwnerAvatarHistory
import riffet.shared.generateOwnerAvatar
import riffet.shared.owner
import riffet.shared.ownerAvatarPreviewUrl
import riffet.shared.ownerAvatarStyles
import riffet.shared.ownerAvatarUrl
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.settings_delete
import org.jetbrains.compose.resources.stringResource
import riffet.shared.removeOwnerAvatar
import riffet.shared.restoreOwnerAvatar
import riffet.shared.updateOwnerName
import riffet.shared.uploadOwnerAvatar
import riffet.ui.app.LocalPageActive
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.OwnerAvatar
import riffet.ui.design.RiffetTextField
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.platform.PreparedAvatar
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.platform.rememberAvatarPicker
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

internal data class OwnerState(
    val owner: OwnerInfo? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val styles: List<OwnerAvatarStyle> = emptyList(),
)

/** The owner's personal info on one server; writes are serialised and a stale reply never replaces a newer one. */
internal class OwnerController(private val api: RiffetApi, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(OwnerState())
    val state: StateFlow<OwnerState> = _state
    private val writes = Mutex()
    private var submittedName: String? = null

    fun avatarUrl(owner: OwnerInfo?): String? = owner?.let(api::ownerAvatarUrl)

    /** Quiet on failure: the header keeps whatever was last known. */
    suspend fun refresh() {
        try {
            // A full read is the server's word: its revision can go down (a restored backup, a fresh state directory).
            val info = api.owner()
            _state.update { it.copy(owner = info) }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
        }
    }

    /** Quiet on failure: without styles the random-avatar action simply stays hidden. */
    suspend fun loadStyles() {
        try {
            val styles = api.ownerAvatarStyles()
            _state.update { it.copy(styles = styles) }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
        }
    }

    fun previewUrl(style: OwnerAvatarStyle, seed: String, ink: String, paper: String): String = api.ownerAvatarPreviewUrl(style.id, seed, ink, paper)

    fun generate(style: OwnerAvatarStyle, seed: String, ink: String, paper: String) = write { api.generateOwnerAvatar(style.id, seed, ink, paper) }

    fun saveName(draft: String) {
        val name = draft.trim()
        if (name == (submittedName ?: _state.value.owner?.name.orEmpty())) return
        submittedName = name
        write { api.updateOwnerName(name) }
    }

    fun upload(avatar: PreparedAvatar) = write { api.uploadOwnerAvatar(avatar.bytes, avatar.type) }

    fun removeAvatar() = write { api.removeOwnerAvatar() }

    fun historyUrl(avatar: OwnerAvatarFile): String = api.ownerAvatarUrl(avatar)

    fun restore(avatar: OwnerAvatarFile) = write { api.restoreOwnerAvatar(avatar.sha256) }

    fun deleteHistory(avatar: OwnerAvatarFile) = write { api.deleteOwnerAvatarHistory(avatar.sha256) }

    fun showError(message: String) = _state.update { it.copy(error = message) }

    private fun write(call: suspend () -> OwnerInfo) {
        scope.launch {
            writes.withLock {
                _state.update { it.copy(busy = true, error = null) }
                try {
                    accept(call())
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (failure: Exception) {
                    _state.update { it.copy(error = failure.settingsMessage(L10n.uiText("owner.saveFailed"))) }
                } finally {
                    // Only a save in flight is skipped as a repeat; once it settles, the server's name is the reference again.
                    submittedName = null
                    _state.update { it.copy(busy = false) }
                }
            }
        }
    }

    private fun accept(info: OwnerInfo) = _state.update {
        if (it.owner != null && info.revision < it.owner.revision) it else it.copy(owner = info)
    }
}

/** The settings home's first row: avatar and name, or the page title while there is no name. */
@Composable
internal fun OwnerHeaderRow(controller: OwnerController, onClick: () -> Unit) {
    rememberResourceEnvironment()
    val state by controller.state.collectAsState()
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val title = state.owner?.name?.takeIf { it.isNotBlank() } ?: L10n.uiText("owner.title")
    SettingsGroup("") {
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick)
                .heightIn(min = metrics.rowHeight).padding(horizontal = metrics.rowPadding, vertical = metrics.rowPadding),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(metrics.rowPadding),
        ) {
            OwnerAvatar(state.owner, controller.avatarUrl(state.owner), 44.dp)
            Text(title, style = LocalRiffetTypography.current.headline, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Icon(RiffetIcons.ChevronRight, null, Modifier.size(metrics.smallIconSize), colors.fg4)
        }
    }
}

@Composable
internal fun OwnerProfilePage(controller: OwnerController) {
    rememberResourceEnvironment()
    val state by controller.state.collectAsState()
    val owner = state.owner
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val focus = LocalFocusManager.current
    var draft by remember { mutableStateOf(owner?.name.orEmpty()) }
    var editing by remember { mutableStateOf(false) }
    // A name from the server fills the field unless the user is typing in it.
    LaunchedEffect(owner?.name) { if (!editing) draft = owner?.name.orEmpty() }
    val latest by rememberUpdatedState(draft)
    DisposableEffect(controller) { onDispose { controller.saveName(latest) } }

    LaunchedEffect(controller) { controller.loadStyles() }
    var randomizing by remember { mutableStateOf(false) }
    val picker = rememberAvatarPicker(onError = controller::showError, onPicked = controller::upload)
    val nameLabel = L10n.uiText("owner.name")

    state.error?.let { PageBanner(it, SettingsNoticeKind.ERROR); Spacer(Modifier.height(12.dp)) }
    Column(Modifier.fillMaxWidth().padding(vertical = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        OwnerAvatar(owner, controller.avatarUrl(owner), 96.dp)
        FlowRow(
            Modifier.padding(top = 12.dp, start = metrics.pageInset, end = metrics.pageInset),
            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
        ) {
            rememberResourceEnvironment()
            if (picker.available) SettingsButton(L10n.uiText("owner.changeAvatar"), onClick = picker::launch, enabled = !state.busy)
            if (state.styles.isNotEmpty()) SettingsButton(L10n.uiText("owner.randomAvatar"), onClick = { randomizing = true }, enabled = !state.busy)
            if (owner?.avatar != null) SettingsButton(L10n.uiText("owner.removeAvatar"), onClick = controller::removeAvatar, enabled = !state.busy, danger = true)
        }
    }
    SettingsGroup("") {
        Column(Modifier.padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding)) {
            Text(nameLabel, style = LocalRiffetTypography.current.label, color = colors.fg2, modifier = Modifier.padding(bottom = 4.dp))
            RiffetTextField(
                value = draft,
                onValueChange = { draft = clampName(it) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                modifier = Modifier.onFocusChanged {
                    if (editing && !it.isFocused) controller.saveName(draft)
                    editing = it.isFocused
                },
            )
        }
    }
    if (owner != null && owner.history.isNotEmpty()) {
        SettingsGroup(L10n.uiText("owner.history")) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding),
                horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
            ) {
                owner.history.forEach { avatar -> key(avatar.sha256) { HistoryAvatar(controller, avatar, enabled = !state.busy) } }
            }
        }
    }
    SettingsFootnote(L10n.uiText("owner.shared"))
    if (randomizing && LocalPageActive.current) RandomAvatarSheet(controller, onDismiss = { randomizing = false })
}

/** Tap restores; long-press offers 删除. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HistoryAvatar(controller: OwnerController, avatar: OwnerAvatarFile, enabled: Boolean) {
    var menu by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier.size(44.dp).clip(CircleShape)
                .combinedClickable(enabled = enabled, role = Role.Button, onClick = { controller.restore(avatar) }, onLongClick = { menu = true }),
        ) {
            OwnerAvatar(null, controller.historyUrl(avatar), 44.dp)
        }
        RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            RiffetMenuItem(stringResource(Res.string.settings_delete), danger = true, onClick = { menu = false; controller.deleteHistory(avatar) })
        }
    }
}

/** At most [OWNER_NAME_MAX] code points; a surrogate pair is never cut in half. */
private fun clampName(text: String): String {
    var count = 0
    var index = 0
    while (index < text.length) {
        if (count == OWNER_NAME_MAX) return text.substring(0, index)
        index += if (text[index].isHighSurrogate() && index + 1 < text.length && text[index + 1].isLowSurrogate()) 2 else 1
        count++
    }
    return text
}
