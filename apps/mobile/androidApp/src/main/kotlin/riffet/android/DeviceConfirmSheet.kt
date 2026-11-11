package riffet.android

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import riffet.shared.DisplaySettings
import riffet.ui.design.RiffetButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import riffet.shared.PreferenceKeys
import riffet.shared.ThemeId
import riffet.shared.ThemeMode
import riffet.shared.createAppPreferences
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.RiffetTheme
import riffet.ui.theme.themeCatalog

/**
 * The owner's confirmation of an irreversible step or a pre-authorisation, over the app being
 * driven. It shows what the device read itself (app, button, typed text); the agent's own words
 * appear only as the pre-authorisation's summary.
 */
@Composable
internal fun DeviceConfirmSheet(request: ConfirmRequest, onAllow: () -> Unit, onDeny: () -> Unit) {
    SheetTheme {
        val colors = LocalRiffetColors.current
        val typography = LocalRiffetTypography.current
        Box(
            modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.32f)).clickable(onClick = {}, indication = null, interactionSource = null),
            contentAlignment = Alignment.BottomCenter,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(MaterialTheme.shapes.extraLarge)
                    .background(MaterialTheme.colorScheme.surfaceContainer)
                    .navigationBarsPadding()
                    .padding(horizontal = 20.dp, vertical = 20.dp),
            ) {
                Text(request.title(androidx.compose.ui.platform.LocalContext.current), style = typography.title, color = colors.fg)
                request.app?.let {
                    Spacer(Modifier.height(4.dp))
                    Text(it, style = typography.caption, color = colors.fg3)
                }
                val quoted = request.content ?: request.target
                if (!request.summary.isNullOrBlank()) {
                    Spacer(Modifier.height(12.dp))
                    Text(request.summary, style = typography.body, color = colors.fg2)
                }
                if (!quoted.isNullOrBlank()) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        quoted,
                        style = typography.body,
                        color = colors.fg,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 240.dp)
                            .clip(MaterialTheme.shapes.medium)
                            .background(colors.bgMuted)
                            .verticalScroll(rememberScrollState())
                            .padding(12.dp),
                    )
                }
                request.validMinutes?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(riffet.shared.R.string.host_device_grant_valid, it), style = typography.caption, color = colors.fg3)
                }
                Spacer(Modifier.height(20.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    RiffetButton(stringResource(riffet.shared.R.string.host_device_confirm_deny), primary = false, onClick = onDeny, modifier = Modifier.weight(1f))
                    RiffetButton(stringResource(riffet.shared.R.string.host_device_confirm_allow), primary = true, onClick = onAllow, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

/** The reader's theme, as the quick chat sheet reads it. */
@Composable
private fun SheetTheme(content: @Composable () -> Unit) {
    val preferences = createAppPreferences()
    val dark = when (preferences.themeMode()) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val themes = themeCatalog(null)
    val id = ThemeId.stored(preferences.string(PreferenceKeys.THEME_ID))
    val display = DisplaySettings.shared
    val resources = riffet.ui.theme.rememberAppearanceResources(RiffetHost.connection.apiOrNull())
    val density = LocalDensity.current
    CompositionLocalProvider(
        LocalDensity provides Density(density.density, density.fontScale * display.textSize.scale),
        riffet.ui.theme.LocalAppearanceResources provides resources,
    ) {
        RiffetTheme(
            darkTheme = dark, entry = resources?.palette ?: themes.firstOrNull { it.id == id } ?: themes.first(),
            uiFont = resources?.uiFont, monoFont = resources?.monoFont,
            interfaceStyle = display.interfaceStyle, amoled = display.amoled,
            surfaceMaterial = display.surfaceMaterial, materialStrength = display.materialStrength, content = content,
        )
    }
}
