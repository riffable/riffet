package riffet.ui.settings

import riffet.ui.gesture.riffetHorizontalScroll
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import riffet.ui.app.LocalPageBack
import riffet.ui.app.PageHost
import riffet.ui.app.PageStack
import riffet.ui.design.GroupField
import riffet.ui.design.GroupRow
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import riffet.ui.design.LocalRiffetSurfaces
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
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

    /** [onSaved] runs once the server has the name (at once when it already does), not after a failure. */
    fun saveName(draft: String, onSaved: () -> Unit = {}) {
        val name = draft.trim()
        if (name == (submittedName ?: _state.value.owner?.name.orEmpty())) { onSaved(); return }
        submittedName = name
        write(onSaved) { api.updateOwnerName(name) }
    }

    fun upload(avatar: PreparedAvatar) = write { api.uploadOwnerAvatar(avatar.bytes, avatar.type) }

    fun removeAvatar() = write { api.removeOwnerAvatar() }

    fun historyUrl(avatar: OwnerAvatarFile): String = api.ownerAvatarUrl(avatar)

    fun restore(avatar: OwnerAvatarFile) = write { api.restoreOwnerAvatar(avatar.sha256) }

    fun deleteHistory(avatar: OwnerAvatarFile) = write { api.deleteOwnerAvatarHistory(avatar.sha256) }

    fun showError(message: String) = _state.update { it.copy(error = message) }

    private fun write(onDone: () -> Unit = {}, call: suspend () -> OwnerInfo) {
        scope.launch {
            var done = false
            writes.withLock {
                _state.update { it.copy(busy = true, error = null) }
                try {
                    accept(call())
                    done = true
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
            if (done) onDone()
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

private sealed interface OwnerRoute {
    data object Profile : OwnerRoute
    data object Name : OwnerRoute
}

/**
 * 个人资料 (mobile.md §2.2, a detail page): who you are on this server at the top, avatar and name,
 * then what can change. The name is edited on its own page with 保存 in the bar; the avatar's
 * choices open from the avatar.
 */
@Composable
internal fun OwnerProfilePages(controller: OwnerController, onBack: () -> Unit) {
    val pages = remember { PageStack<OwnerRoute>(OwnerRoute.Profile) }
    PageHost(pages) { route, back ->
        rememberResourceEnvironment()
        when (route) {
            OwnerRoute.Profile -> SettingsPage(L10n.uiText("owner.title"), onBack) {
                OwnerProfilePage(controller, onEditName = { pages.push(OwnerRoute.Name) })
            }
            OwnerRoute.Name -> OwnerNamePage(controller, back)
        }
    }
}

@Composable
private fun OwnerProfilePage(controller: OwnerController, onEditName: () -> Unit) {
    val state by controller.state.collectAsState()
    val owner = state.owner
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    LaunchedEffect(controller) { controller.loadStyles() }
    var randomizing by remember { mutableStateOf(false) }
    var avatarMenu by remember { mutableStateOf(false) }
    val picker = rememberAvatarPicker(onError = controller::showError, onPicked = controller::upload)
    val canPick = picker.available
    val canRandom = state.styles.isNotEmpty()
    val canRemove = owner?.avatar != null
    val name = owner?.name?.takeIf { it.isNotBlank() }

    state.error?.let { PageBanner(it, SettingsNoticeKind.ERROR); Spacer(Modifier.height(metrics.controlInset)) }
    Column(
        Modifier.fillMaxWidth().padding(top = metrics.sectionGap, bottom = metrics.controlInset),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box {
            Box(
                Modifier.clip(CircleShape).clickable(
                    enabled = owner != null && !state.busy && (canPick || canRandom || canRemove),
                    onClickLabel = L10n.uiText("owner.avatar"), role = Role.Button,
                ) { avatarMenu = true },
            ) {
                OwnerAvatar(owner, controller.avatarUrl(owner), OwnerAvatarSize)
            }
            // The mark that says the avatar opens something: a small pencil on the page's own ground.
            Box(
                Modifier.align(Alignment.BottomEnd).size(metrics.iconSlot).clip(CircleShape)
                    .background(LocalRiffetSurfaces.current.groupedPage).padding(metrics.hairlineWidth * 2)
                    .clip(CircleShape).background(LocalRiffetSurfaces.current.card),
                contentAlignment = Alignment.Center,
            ) {
                Icon(RiffetIcons.Pencil, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(metrics.smallIconSize * 0.8f))
            }
            RiffetDropdownMenu(expanded = avatarMenu, onDismissRequest = { avatarMenu = false }) {
                if (canPick) RiffetMenuItem(L10n.uiText("owner.choosePhoto"), icon = RiffetIcons.Image, onClick = { avatarMenu = false; picker.launch() })
                if (canRandom) RiffetMenuItem(L10n.uiText("owner.randomAvatar"), icon = RiffetIcons.Dices, onClick = { avatarMenu = false; randomizing = true })
                if (canRemove) RiffetMenuItem(L10n.uiText("owner.removeAvatar"), icon = RiffetIcons.Trash, danger = true, onClick = { avatarMenu = false; controller.removeAvatar() })
            }
        }
        if (name != null) Text(
            name, style = type.title, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = metrics.controlInset, start = metrics.pageInset, end = metrics.pageInset),
        )
        // The one fact about the whole profile a reader cannot infer: where it lives.
        Text(L10n.uiText("owner.shared"), style = type.bodySmall, color = colors.fg3, textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = metrics.hairlineWidth * 2, start = metrics.pageInset, end = metrics.pageInset))
    }
    SettingsGroup("") {
        GroupRow(title = L10n.uiText("owner.name"), value = name, chevron = true, enabled = owner != null && !state.busy, onClick = onEditName)
    }
    if (owner != null && owner.history.isNotEmpty()) {
        SettingsGroup(L10n.uiText("owner.history")) {
            Row(
                Modifier.fillMaxWidth().riffetHorizontalScroll(rememberScrollState()).padding(horizontal = metrics.rowPadding, vertical = metrics.rowPadding),
                horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
            ) {
                owner.history.forEach { avatar -> key(avatar.sha256) { HistoryAvatar(controller, avatar, enabled = !state.busy) } }
            }
        }
    }
    if (randomizing && LocalPageActive.current) RandomAvatarSheet(controller, onDismiss = { randomizing = false })
}

/** The name on its own edit page (mobile.md §2.3): 保存 in the bar, enabled once it differs. */
@Composable
private fun OwnerNamePage(controller: OwnerController, back: () -> Unit) {
    val state by controller.state.collectAsState()
    val saved = state.owner?.name.orEmpty()
    var draft by remember { mutableStateOf(saved) }
    val pageBack = LocalPageBack.current
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    // Saved: leave without the guard, which still compares against the name before the save.
    val save = { controller.saveName(draft, onSaved = { pageBack?.leaveConfirmed() ?: back() }) }
    EditPage(
        title = L10n.uiText("owner.name"),
        onBack = back,
        dirty = draft.trim() != saved,
        busy = state.busy,
        onSave = save,
    ) {
        state.error?.let { PageBanner(it, SettingsNoticeKind.ERROR); Spacer(Modifier.height(LocalInterfaceStyle.current.metrics.controlInset)) }
        SettingsGroup("") {
            GroupField(
                value = draft,
                onValueChange = { draft = clampName(it) },
                placeholder = L10n.uiText("owner.name"),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (draft.trim() != saved && !state.busy) save() }),
                modifier = Modifier.focusRequester(focus),
            )
        }
        SettingsFootnote(L10n.uiText("owner.shared"))
    }
}

private val OwnerAvatarSize = 96.dp

/** Tap restores; long-press offers 删除. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HistoryAvatar(controller: OwnerController, avatar: OwnerAvatarFile, enabled: Boolean) {
    var menu by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier.size(LocalInterfaceStyle.current.metrics.controlHeight).clip(CircleShape)
                .combinedClickable(enabled = enabled, role = Role.Button, onClick = { controller.restore(avatar) }, onLongClick = { menu = true }),
        ) {
            OwnerAvatar(null, controller.historyUrl(avatar), LocalInterfaceStyle.current.metrics.controlHeight)
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
