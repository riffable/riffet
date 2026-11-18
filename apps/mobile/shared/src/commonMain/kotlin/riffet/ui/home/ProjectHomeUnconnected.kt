package riffet.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import org.jetbrains.compose.resources.stringResource
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.app.TabTopBar
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.onboarding.HomeSetupPage
import riffet.ui.theme.appearancePageBackground
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_tab_new

/** The 新会话 tab with no server: the page's bar and the setup island, with nothing to start a session in yet. */
@Composable
internal fun ProjectHomeUnconnected(onOpenMenu: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().appearancePageBackground(LocalRiffetSurfaces.current.page)) {
        RiffetPageScaffold(
            modifier = Modifier.fillMaxSize(),
            topBar = { TabTopBar(title = stringResource(Res.string.session_tab_new), onOpenMenu = onOpenMenu) },
        ) { insets ->
            HomeSetupPage(
                api = null, projects = emptyList(), contentPadding = insets,
                onSelectProject = {}, onAddDirectory = null, onSkipProject = null,
            )
        }
    }
}
