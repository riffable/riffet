package riffet.ui.app

import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.CoroutineScope
import org.jetbrains.compose.resources.stringResource
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.ui.home.ProjectHomeUnconnected
import riffet.ui.onboarding.NeedsServerState
import riffet.ui.state.RiffetConnectionState
import riffet.ui.theme.LocalRiffetPageMotion
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.assistant_tab
import riffet_mobile.shared.generated.resources.session_tab_tasks

/**
 * The tabs while no server is connected. The same shell as [Workbench] (bar or rail, drawer, page
 * motion), with the pages that need a server replaced by the empty state, 新会话 showing the setup
 * island, and 设置 working on its local sections. It lands on 新会话 once, and keeps the tab it is on
 * when a pairing finishes.
 */
@Composable
internal fun UnconnectedWorkbench(
    navigation: RiffetNavigation,
    connection: RiffetConnection,
    onPaired: (RiffetApi) -> Unit,
    scope: CoroutineScope,
    /** The 设置 tab's content. */
    settings: @Composable () -> Unit,
) {
    val pageMotion = LocalRiffetPageMotion.current
    if (!navigation.tabRestored) {
        navigation.tabRestored = true
        navigation.tab = HomeTab.NEW_SESSION
    }
    val openMenu: () -> Unit = {
        navigation.detailsOpen = false
        navigation.drawerOpen = true
    }
    val drawerBackTarget = PageBackHandler(enabled = navigation.drawerOpen) { navigation.backFromOverlay() }
    val tabBack = rememberUpdatedState { navigation.tab = HomeTab.NEW_SESSION }
    val tabBackTarget = remember { TabBackTarget { tabBack.value() } }
    RegisterPageBackTarget(tabBackTarget, enabled = navigation.tab != HomeTab.NEW_SESSION)

    AdaptiveWorkbench(tasks = { false }) { layout ->
        SideDrawers(
            startOpen = navigation.drawerOpen,
            onStartOpenChange = { open -> navigation.drawerOpen = open },
            endOpen = false,
            onEndOpenChange = {},
            endEnabled = false,
            backSwipe = { navigation.backSwipeFor(drawerBackTarget) },
            startDrawer = {
                WorkbenchDrawer(
                    api = null,
                    owner = null,
                    connection = connection,
                    status = RiffetConnectionState.Idle,
                    onClose = { navigation.drawerOpen = false },
                    onPaired = onPaired,
                    onOwner = {},
                    onRepair = { address ->
                        navigation.drawerOpen = false
                        navigation.requestPairing(address)
                    },
                    onFavorite = {},
                    onDownloads = {
                        navigation.drawerOpen = false
                        navigation.downloadsOpen = true
                    },
                    onStats = {},
                    operationScope = scope,
                    connectionOperation = navigation.connectionOperation,
                )
            },
            endDrawer = {},
        ) {
            val tabs = rememberSaveableStateHolder()
            HomeShell(tab = navigation.tab, onTab = { navigation.tab = it }, waiting = 0, rail = layout.rail) {
                val tabInsets = systemBarsPadding(includeDisplayCutout = false)
                AnimatedContent(
                    targetState = navigation.tab,
                    modifier = Modifier.coverSystemBars(tabInsets),
                    transitionSpec = { pageMotion.transition(forward = targetState.ordinal > initialState.ordinal) },
                    label = "tab",
                ) { shown ->
                    val active = rememberUpdatedState(LocalPageActive.current && shown == navigation.tab)
                    Box(Modifier.fillMaxSize().padding(tabInsets)
                        .focusProperties { canFocus = active.value }
                        .semantics { if (!active.value) hideFromAccessibility() }
                        .pointerInput(Unit) {
                            awaitPointerEventScope {
                                while (true) {
                                    val event = awaitPointerEvent(PointerEventPass.Initial)
                                    if (!active.value) event.changes.forEach { it.consume() }
                                }
                            }
                        }) {
                        CompositionLocalProvider(LocalPageActive provides active.value) {
                            tabs.SaveableStateProvider(shown.name) {
                                when (shown) {
                                    HomeTab.NEW_SESSION -> ProjectHomeUnconnected(onOpenMenu = openMenu)
                                    HomeTab.ASSISTANT -> NeedsServerTab(stringResource(Res.string.assistant_tab), openMenu)
                                    HomeTab.TASKS -> NeedsServerTab(stringResource(Res.string.session_tab_tasks), openMenu)
                                    HomeTab.SETTINGS -> CompositionLocalProvider(LocalTabMenu provides openMenu) { settings() }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A tab whose page needs the server: its bar and the shared empty state. */
@Composable
private fun NeedsServerTab(title: String, onOpenMenu: () -> Unit) {
    val setup = riffet.ui.onboarding.LocalSetupActions.current
    RiffetPageScaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = { TabTopBar(title = title, onOpenMenu = onOpenMenu) },
    ) { insets ->
        NeedsServerState(onConnect = { setup?.showSetup?.invoke() }, modifier = Modifier.padding(insets))
    }
}
