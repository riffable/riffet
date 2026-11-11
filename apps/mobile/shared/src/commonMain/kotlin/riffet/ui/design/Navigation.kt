package riffet.ui.design

import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.material3.LocalTextStyle
import androidx.compose.runtime.CompositionLocalProvider
import riffet.ui.theme.LocalRiffetTypography
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape

/** The chrome renderer is the only place deciding title alignment and platform bar metrics. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StyleTopBar(
    title: @Composable () -> Unit,
    navigation: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    background: Color = LocalRiffetSurfaces.current.page,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val style = LocalInterfaceStyle.current
    val metrics = style.metrics
    val surface = LocalRiffetSurfaces.current
    val chrome = modifier.riffetMaterial(MaterialRole.TOP_BAR, RectangleShape, background).drawWithContent {
            drawContent()
            if (background.alpha > 0f && style.components.navigation.divider) drawLine(surface.hairline, Offset(0f, size.height), Offset(size.width, size.height), metrics.hairlineWidth.toPx())
        }
    val colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent, scrolledContainerColor = Color.Transparent)
    val heading: @Composable () -> Unit = {
        CompositionLocalProvider(LocalTextStyle provides LocalRiffetTypography.current.barTitle) { title() }
    }
    RiffetMaterialContent {
        if (!style.components.navigation.centeredTitle) TopAppBar(
            title = heading, navigationIcon = navigation, actions = actions, modifier = chrome,
            colors = colors, windowInsets = WindowInsets(0, 0, 0, 0), expandedHeight = style.barHeight,
        ) else CenterAlignedTopAppBar(
            title = heading, navigationIcon = navigation, actions = actions, modifier = chrome,
            colors = colors, windowInsets = WindowInsets(0, 0, 0, 0), expandedHeight = style.barHeight,
        )
    }
}
