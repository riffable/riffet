package riffet.ui.app

import riffet.ui.design.riffetMaterial
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialContent
import androidx.compose.ui.graphics.RectangleShape

import riffet.ui.design.LocalRiffetSurfaces
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.ExperimentalMaterial3Api
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.input.nestedscroll.nestedScroll
import riffet.ui.design.StyleTopBar
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LargeTitle
import riffet.ui.design.rememberLargeTitleState
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.ui.icons.RiffetIcons
import riffet.ui.design.LargeTitleBar
import riffet.ui.design.LargeTitleState
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography


/**
 * Set on a tab's own first page: its bar leads with the navigation drawer's menu button instead of a
 * back arrow, the tab bar being the way out. Pages pushed over it reset this.
 */
internal val LocalTabMenu = staticCompositionLocalOf<(() -> Unit)?> { null }

/**
 * The bar of the three tab roots (新会话 / 任务 / 设置): the drawer's menu button, the title, then
 * the page's actions, on the page's own colour. With [largeTitle] the page leads with a
 * [riffet.ui.design.LargeTitle] and this bar's title only fades in as that one scrolls away.
 */
@Composable
internal fun TabTopBar(
    title: String,
    onOpenMenu: () -> Unit,
    modifier: Modifier = Modifier,
    largeTitle: LargeTitleState? = null,
    background: Color? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val colors = LocalRiffetColors.current
    LargeTitleBar(
        title = title,
        state = largeTitle ?: AlwaysCollapsed,
        background = background ?: colors.bg,
        modifier = modifier,
        navigation = {
            PageBarAction(RiffetIcons.Menu, stringResource(Res.string.session_open_sidebar), onOpenMenu, tint = colors.fg)
        },
        actions = actions,
    )
}

/** A bar with no large title under it shows its own title from the start. */
private val AlwaysCollapsed = LargeTitleState({ 0 }, { true }, 1f)

/**
 * The bar every pushed page opens with: back arrow, a one-line title (with an optional line under
 * it), then the page's own actions at the end. It matches [TabTopBar]'s 56dp height, 56dp title
 * inset and `titleLarge`, so a pushed page and a tab root read as one family. On a tab's own first
 * page ([LocalTabMenu]) it is that bar. No divider; the page's content starts below.
 */
@Composable
internal fun PageTopBar(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    subtitleColor: Color? = null,
    /** A large page shows its title as a headline in the content and fades this one in on scroll. */
    titleAlpha: Float = 1f,
    actions: @Composable RowScope.() -> Unit = {},
) {
    LocalTabMenu.current?.let { menu ->
        TabTopBar(title = title, onOpenMenu = menu, modifier = modifier, actions = actions)
        return
    }
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(modifier) {
        StyleTopBar(
            title = {
                Box(Modifier.alpha(titleAlpha)) {
                    Text(title, style = typography.barTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            },
            navigation = { PageBarAction(RiffetIcons.ArrowLeft, stringResource(Res.string.app_back), onBack) },
            actions = actions,
        )
        if (!subtitle.isNullOrEmpty()) Text(subtitle, style = typography.caption, color = subtitleColor ?: colors.fg3,
            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth()
                .padding(horizontal = LocalInterfaceStyle.current.metrics.groupInset, vertical = LocalInterfaceStyle.current.metrics.controlInset / 2))
    }
}

/** A plain icon action with a full touch target for [PageTopBar]. */
@Composable
internal fun PageBarAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tint: Color? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val backChevron = LocalInterfaceStyle.current.components.navigation.backChevron
    val surface = LocalRiffetSurfaces.current
    Box(Modifier.size(metrics.controlHeight), contentAlignment = Alignment.Center) {
        riffet.ui.design.RiffetIconButton(onClick = onClick, enabled = enabled) {
            Icon(if (backChevron && icon == RiffetIcons.ArrowLeft) RiffetIcons.ChevronLeft else icon,
                contentDescription = description,
                tint = if (enabled) tint ?: colors.fg2 else surface.disabledContent,
                modifier = Modifier.size(metrics.iconSize))
        }
    }
}

/**
 * A search the page offers from its top bar (mobile.md §4): an icon among the actions that turns the
 * bar into a search field; back or the arrow closes it and clears the query.
 */
internal class PageSearch(val query: String, val onQueryChange: (String) -> Unit, val placeholder: String)

/** What the leading icon of a pushed page does: go back, or (an edit page) cancel. */
internal enum class PageNavigation { BACK, CLOSE }

/** The bar of a page with a [PageSearch] open: the field fills the bar, the arrow closes it. */
@Composable
private fun SearchTopBar(search: PageSearch, onClose: () -> Unit) {
    StyleTopBar(
        title = {
            riffet.ui.design.RiffetSearchField(
                query = search.query, onQueryChange = search.onQueryChange, placeholder = search.placeholder,
                clearDescription = stringResource(Res.string.session_clear_search), requestFocus = true,
                modifier = Modifier.padding(end = LocalInterfaceStyle.current.metrics.pageInset),
            )
        },
        navigation = { PageBarAction(RiffetIcons.ArrowLeft, stringResource(Res.string.app_close_search), onClose) },
    )
}

/**
 * The page every settings-like screen is built on: the top bar (back or cancel, title, then
 * [actions] — at most two icons, more go into a ⋯ menu), one scroll of inset content, and
 * optionally a [search] in the bar and pull-to-[onRefresh]. Keeps the scroll/content subtree in
 * place when the visual renderer changes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ScrollablePage(
    title: String,
    onBack: () -> Unit,
    large: Boolean = false,
    compactTitle: Boolean = false,
    navigation: PageNavigation = PageNavigation.BACK,
    search: PageSearch? = null,
    refreshing: Boolean = false,
    onRefresh: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val page = pageColor()
    val scroll = rememberScrollState()
    val menu = LocalTabMenu.current?.takeIf { large }
    val style = LocalInterfaceStyle.current
    val showLargeTitle = large && !compactTitle
    val nativeLargeTitle = style.components.navigation.largeTitle == riffet.ui.design.ComponentBackend.MATERIAL
    val behavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val largeState = rememberLargeTitleState(scroll)
    var searching by rememberSaveable { mutableStateOf(search?.query?.isNotEmpty() == true) }
    val closeSearch: () -> Unit = { searching = false; search?.onQueryChange?.invoke("") }
    PageBackHandler(enabled = searching && search != null) { closeSearch() }
    val barActions: @Composable RowScope.() -> Unit = {
        if (search != null) PageBarAction(RiffetIcons.Search, search.placeholder, { searching = true })
        actions()
    }
    RiffetPageScaffold(
        modifier = Modifier.fillMaxSize().pageBackground(page)
            .then(if (showLargeTitle && nativeLargeTitle) Modifier.nestedScroll(behavior.nestedScrollConnection) else Modifier),
        topBar = {
            val largeBarSurface = Modifier.riffetMaterial(MaterialRole.TOP_BAR, RectangleShape, page)
            val navigationIcon: @Composable () -> Unit = {
                when {
                    menu != null -> PageBarAction(RiffetIcons.Menu, stringResource(Res.string.session_open_sidebar), menu)
                    navigation == PageNavigation.CLOSE -> PageBarAction(RiffetIcons.Close, stringResource(Res.string.settings_cancel), onBack)
                    else -> PageBarAction(RiffetIcons.ArrowLeft, stringResource(Res.string.app_back), onBack)
                }
            }
            if (searching && search != null) SearchTopBar(search, closeSearch)
            else if (showLargeTitle && nativeLargeTitle) RiffetMaterialContent {
                LargeTopAppBar(
                    title = { Text(title, style = LocalRiffetTypography.current.largeTitle, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = navigationIcon, actions = barActions, modifier = largeBarSurface,
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent, scrolledContainerColor = Color.Transparent),
                    windowInsets = WindowInsets(0, 0, 0, 0), scrollBehavior = behavior,
                )
            } else if (showLargeTitle) LargeTitleBar(title, largeState, page, navigation = navigationIcon, actions = barActions)
            else StyleTopBar(title = { Text(title, style = LocalRiffetTypography.current.barTitle, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigation = navigationIcon, actions = barActions)
        },
    ) { contentInsets ->
        // The refresh box stays in the tree with or without [onRefresh], so adding one never remounts the page.
        val pull = rememberPullToRefreshState()
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { onRefresh?.invoke() }, modifier = Modifier.fillMaxSize(),
            state = pull, contentAlignment = Alignment.TopCenter,
            indicator = { if (onRefresh != null) PullToRefreshDefaults.Indicator(state = pull, isRefreshing = refreshing,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = contentInsets.calculateTopPadding())) }) {
            Column(Modifier.widthIn(max = style.metrics.contentMaxWidth).fillMaxWidth().verticalScroll(scroll)
                .padding(contentInsets)
                .padding(start = style.metrics.pageInset, end = style.metrics.pageInset,
                    top = style.metrics.sectionGap / 2,
                    bottom = style.metrics.sectionGap + LocalTabContentBottomPadding.current)) {
                if (showLargeTitle && !nativeLargeTitle) LargeTitle(title, largeState, horizontalInset = 0.dp)
                content()
            }
        }
    }
}

/** The ⋯ at the end of a top bar, for the page's low-frequency tools (refresh, diagnostics, import). */
@Composable
internal fun PageMoreAction(items: @Composable ColumnScope.(close: () -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        PageBarAction(RiffetIcons.Ellipsis, stringResource(Res.string.app_more), { open = true })
        riffet.ui.pickers.RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) { items { open = false } }
    }
}

/** The bar's place for "working on it": a spinner the size of an action, while the page is disabled. */
@Composable
internal fun PageBarProgress() {
    Box(Modifier.size(LocalInterfaceStyle.current.metrics.controlHeight), contentAlignment = Alignment.Center) {
        riffet.ui.timeline.Spinner(size = 18.dp)
    }
}
