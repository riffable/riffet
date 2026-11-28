package riffet.ui.favorites

import androidx.compose.foundation.lazy.rememberLazyListState
import riffet.ui.gesture.horizontalSwipeChild
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import riffet.ui.design.AlertDialog
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.FolderFavorite
import riffet.shared.RiffetApi
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.shared.addFolderFavorite
import riffet.shared.folderFavorites
import riffet.shared.removeFolderFavorite
import riffet.shared.reorderFolderFavorites
import riffet.shared.updateFolderFavorite

/**
 * One scope's folder favorites (`apps/web/src/app/FolderFavorites.tsx`): the host's, with absolute
 * paths, for the directory picker; or a project's files panel ([projectId]), with paths relative to
 * its root. They live on the server, so every device signed in to it sees the same list.
 */
@Stable
internal class FolderFavoritesState(private val api: RiffetApi, val projectId: String?, private val scope: CoroutineScope) {
    var favorites by mutableStateOf<List<FolderFavorite>>(emptyList())
        private set
    /** The last failed change, for the caller to show; reads fail quietly, favorites are a shortcut. */
    var error by mutableStateOf<String?>(null)

    fun favoriteAt(path: String): FolderFavorite? = favorites.firstOrNull { it.path == path }

    /** Quick picks lead with what was opened most recently; never-used ones keep their order. */
    val byRecentUse: List<FolderFavorite>
        get() = favorites.filter { it.exists }.sortedWith(compareByDescending<FolderFavorite> { it.lastUsedAt.orEmpty() }.thenBy { it.sort })

    fun load() {
        scope.launch {
            try { favorites = api.folderFavorites(projectId) } catch (cancellation: CancellationException) { throw cancellation } catch (_: Throwable) {}
        }
    }

    fun toggle(path: String, addFailure: String, removeFailure: String) {
        val existing = favoriteAt(path)
        if (existing != null) remove(existing, removeFailure) else change(addFailure) {
            val created = api.addFolderFavorite(path, projectId, null)
            if (favorites.none { it.id == created.id }) favorites = favorites + created
        }
    }

    fun remove(favorite: FolderFavorite, failure: String) = change(failure) {
        api.removeFolderFavorite(favorite.id)
        favorites = favorites.filterNot { it.id == favorite.id }
    }

    /** An empty [label], or the folder's own name, goes back to showing the folder's name. */
    fun rename(favorite: FolderFavorite, label: String, failure: String) = change(failure) {
        val value = label.trim().takeUnless { it == folderName(favorite.path) }.orEmpty()
        if (value == favorite.label.orEmpty()) return@change
        val updated = api.updateFolderFavorite(favorite.id, value, false)
        favorites = favorites.map { if (it.id == updated.id) updated else it }
    }

    /** One step up (-1) or down (1); shown at once, put back if the server refuses. */
    fun move(favorite: FolderFavorite, delta: Int, failure: String) {
        val before = favorites
        val from = before.indexOfFirst { it.id == favorite.id }
        val to = from + delta
        if (from < 0 || to !in before.indices) return
        favorites = before.toMutableList().apply { add(to, removeAt(from)) }
        change(failure, undo = { favorites = before }) {
            favorites = api.reorderFolderFavorites(favorites.map { it.id }, projectId)
        }
    }

    private fun change(failure: String, undo: () -> Unit = {}, block: suspend () -> Unit) {
        scope.launch {
            try {
                error = null
                block()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (cause: Throwable) {
                undo()
                error = cause.message?.takeIf { it.isNotBlank() } ?: failure
            }
        }
    }
}

/** Remembered per scope and read once on entry when [enabled]. */
@Composable
internal fun rememberFolderFavorites(api: RiffetApi, projectId: String? = null, enabled: Boolean = true): FolderFavoritesState {
    val scope = rememberCoroutineScope()
    val state = remember(api, projectId) { FolderFavoritesState(api, projectId, scope) }
    LaunchedEffect(state, enabled) { if (enabled) state.load() }
    return state
}

private fun folderName(path: String): String = path.split('/').lastOrNull { it.isNotEmpty() } ?: path

/** What a favorite is shown as: its label, else the folder's own name. */
internal fun favoriteName(favorite: FolderFavorite): String = favorite.label?.takeIf { it.isNotBlank() } ?: folderName(favorite.path)

/**
 * The favorites as a scrolling row of chips. A tap opens one; in edit mode (the pencil at the end) or on a long press a chip offers 重命名, 上移,
 * 下移 and 取消收藏. A folder that is gone is greyed with 不存在 and only offers removal.
 */
@Composable
internal fun FolderFavoriteChips(state: FolderFavoritesState, currentPath: String?, onOpen: (FolderFavorite) -> Unit, modifier: Modifier = Modifier) {
    val motion = LocalRiffetMotion.current
    // The row opens once the list has loaded, and keeps its last chips while it closes.
    val shown = remember { Held(state.favorites) }
    if (state.favorites.isNotEmpty()) shown.value = state.favorites
    // Read here, in composition: the LazyRow content lambda is memoized on its captures and would not see a plain holder change.
    val rows = shown.value
    var editing by remember { mutableStateOf(false) }
    if (editing && state.favorites.isEmpty()) editing = false
    AnimatedVisibility(visible = state.favorites.isNotEmpty(), enter = motion.expandIn(), exit = motion.collapseOut()) {
        val row = rememberLazyListState()
        LazyRow(
            state = row,
            modifier = modifier.fillMaxWidth().horizontalSwipeChild(row),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items(rows, key = { favorite -> favorite.id }) { favorite ->
                FavoriteChip(
                    state, favorite,
                    current = favorite.path == currentPath,
                    editing = editing,
                    onOpen = { onOpen(favorite) },
                    modifier = Modifier.animateItem(fadeInSpec = motion.effects(), placementSpec = motion.spatial(), fadeOutSpec = motion.effects()),
                )
            }
            // Rename and reorder also have a visible way in; the long press stays as the shortcut.
            item(key = "edit") {
                riffet.ui.design.RiffetIconButton(onClick = { editing = !editing }, modifier = Modifier.animateItem()) {
                    Icon(
                        if (editing) RiffetIcons.Check else RiffetIcons.Pencil,
                        contentDescription = stringResource(if (editing) Res.string.homem_favorites_done else Res.string.homem_favorites_edit),
                        tint = if (editing) LocalRiffetColors.current.accent else LocalRiffetColors.current.fg3,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
    }
}

/** A value kept by plain reference, so a closing row can hold what it last showed. */
private class Held<T>(var value: T)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FavoriteChip(state: FolderFavoritesState, favorite: FolderFavorite, current: Boolean, editing: Boolean, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    val removeFailed = stringResource(Res.string.favorites_error_remove)
    val reorderFailed = stringResource(Res.string.favorites_error_reorder)
    val renameFailed = stringResource(Res.string.favorites_error_rename)
    val missing = stringResource(Res.string.favorites_missing)
    Box(modifier = modifier) {
        riffet.ui.design.ChipButton(
            label = if (favorite.exists) favoriteName(favorite) else favoriteName(favorite) + " · " + missing,
            active = current,
            onClick = { if (favorite.exists && !editing) onOpen() else menu = true },
            icon = if (favorite.exists) RiffetIcons.StarFilled else RiffetIcons.Star,
            trailingIcon = if (editing) RiffetIcons.Ellipsis else null,
            onLongClick = { menu = true },
        )
        RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            val index = state.favorites.indexOfFirst { it.id == favorite.id }
            if (favorite.exists) {
                RiffetMenuItem(stringResource(Res.string.favorites_rename), onClick = { menu = false; renaming = true })
                RiffetMenuItem(stringResource(Res.string.favorites_move_up), onClick = { menu = false; state.move(favorite, -1, reorderFailed) }, enabled = index > 0)
                RiffetMenuItem(stringResource(Res.string.favorites_move_down), onClick = { menu = false; state.move(favorite, 1, reorderFailed) }, enabled = index in 0 until state.favorites.lastIndex)
            }
            RiffetMenuItem(stringResource(Res.string.favorites_unfavorite), onClick = { menu = false; state.remove(favorite, removeFailed) }, danger = true)
        }
    }
    if (renaming) RenameFavoriteDialog(favorite, onDismiss = { renaming = false }, onSave = { renaming = false; state.rename(favorite, it, renameFailed) })
}

@Composable
private fun RenameFavoriteDialog(favorite: FolderFavorite, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var value by remember { mutableStateOf(favoriteName(favorite)) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(Res.string.favorites_rename_title)) },
        text = { Column {
            riffet.ui.design.RiffetTextField(value = value, onValueChange = { value = it }, singleLine = true, placeholder = folderName(favorite.path))
            Text(stringResource(Res.string.favorites_rename_hint), style = LocalRiffetTypography.current.caption, color = LocalRiffetColors.current.fg3)
        } },
        confirmButton = { RiffetTextButton(onClick = { onSave(value) }) { Text(stringResource(Res.string.favorites_save)) } },
        dismissButton = { RiffetTextButton(onClick = onDismiss) { Text(stringResource(Res.string.favorites_cancel)) } },
    )
}

/** A star that adds or removes [path]; filled when it is a favorite. */
@Composable
internal fun FavoriteToggle(state: FolderFavoritesState, path: String, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val starred = state.favoriteAt(path) != null
    val addFailed = stringResource(Res.string.favorites_error_add)
    val removeFailed = stringResource(Res.string.favorites_error_remove)
    riffet.ui.design.RiffetIconButton(
        onClick = { state.toggle(path, addFailed, removeFailed) },
        modifier = modifier,
    ) {
        Icon(
            if (starred) RiffetIcons.StarFilled else RiffetIcons.Star,
            contentDescription = if (starred) stringResource(Res.string.favorites_unfavorite) else stringResource(Res.string.favorites_favorite),
            tint = if (starred) colors.warning else colors.fg3,
            modifier = Modifier.size(16.dp),
        )
    }
}
