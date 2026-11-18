package riffet.ui.onboarding

import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.shared.createQrScanner
import riffet.ui.app.systemBarsPadding
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.RiffetButton
import riffet.ui.design.RiffetTextButton
import riffet.ui.icons.BrandMark
import riffet.ui.icons.LiveBrandMark
import riffet.ui.icons.LiveBrandStyle
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetPageMotion
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.appearancePageBackground
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.onboarding_brand
import riffet_mobile.shared.generated.resources.onboarding_connect_hint
import riffet_mobile.shared.generated.resources.onboarding_connect_title
import riffet_mobile.shared.generated.resources.onboarding_enter_address
import riffet_mobile.shared.generated.resources.onboarding_notify_allow
import riffet_mobile.shared.generated.resources.onboarding_notify_hint
import riffet_mobile.shared.generated.resources.onboarding_notify_later
import riffet_mobile.shared.generated.resources.onboarding_notify_title
import riffet_mobile.shared.generated.resources.onboarding_sample_body
import riffet_mobile.shared.generated.resources.onboarding_sample_title
import riffet_mobile.shared.generated.resources.onboarding_scan
import riffet_mobile.shared.generated.resources.onboarding_skip
import riffet_mobile.shared.generated.resources.onboarding_start
import riffet_mobile.shared.generated.resources.onboarding_tagline

/** The pages of the first launch, in order; only the ones that need a decision are used. */
internal enum class OnboardingPage { WELCOME, CONNECT, NOTIFY }

private val WelcomeMarkSize = 96.dp

/**
 * The full-screen first launch: one decision per page, [OnboardingPage.WELCOME] first. [pages] holds
 * the pages in use (the notification page drops out where it has nothing to ask), and the progress
 * bar counts the ones after the welcome.
 */
@Composable
internal fun OnboardingFlow(
    page: OnboardingPage,
    pages: List<OnboardingPage>,
    onPage: (OnboardingPage) -> Unit,
    onFinish: () -> Unit,
    actions: SetupActions,
    /** Asks the system for notifications and calls back once it answered; null where there is nothing to ask. */
    requestNotifications: ((() -> Unit) -> Unit)?,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val pageMotion = LocalRiffetPageMotion.current
    val index = pages.indexOf(page)
    val next = pages.getOrNull(index + 1)
    val advance: () -> Unit = { if (next != null) onPage(next) else onFinish() }

    Column(
        Modifier.fillMaxSize()
            .appearancePageBackground(LocalRiffetSurfaces.current.page)
            .padding(systemBarsPadding(includeDisplayCutout = false))
            .padding(horizontal = metrics.pageInset),
    ) {
        Row(Modifier.fillMaxWidth().height(metrics.barHeight), verticalAlignment = Alignment.CenterVertically) {
            Progress(done = index, total = pages.size - 1, modifier = Modifier.weight(1f))
            if (page != OnboardingPage.NOTIFY) RiffetTextButton(onFinish) { Text(stringResource(Res.string.onboarding_skip), color = LocalRiffetColors.current.fg3) }
        }
        AnimatedContent(
            targetState = page,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            transitionSpec = { pageMotion.transition(forward = targetState.ordinal > initialState.ordinal) },
            label = "onboarding",
        ) { shown ->
            when (shown) {
                OnboardingPage.WELCOME -> Welcome(onStart = advance)
                OnboardingPage.CONNECT -> Connect(actions)
                OnboardingPage.NOTIFY -> Notify(
                    onAllow = { requestNotifications?.invoke(onFinish) ?: onFinish() },
                    onLater = onFinish,
                )
            }
        }
    }
}

/** One segment per page after the welcome; the ones reached are filled. */
@Composable
private fun Progress(done: Int, total: Int, modifier: Modifier) {
    val colors = LocalRiffetColors.current
    val metrics = LocalInterfaceStyle.current.metrics
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
        if (done > 0) repeat(total) { segment ->
            Box(
                Modifier.weight(1f).height(metrics.focusWidth * 2).clip(RoundedCornerShape(metrics.focusWidth))
                    .background(if (segment < done) colors.fg else LocalRiffetSurfaces.current.hairline),
            )
        }
    }
}

@Composable
private fun PageFrame(
    title: String?,
    subtitle: String?,
    center: Boolean = false,
    lead: @Composable () -> Unit = {},
    bottom: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
            verticalArrangement = if (center) Arrangement.Center else Arrangement.Top,
            horizontalAlignment = if (center) Alignment.CenterHorizontally else Alignment.Start,
        ) {
            lead()
            if (title != null) Text(title, style = type.largeTitle, color = colors.fg, textAlign = if (center) TextAlign.Center else TextAlign.Start)
            if (subtitle != null) Text(
                subtitle, style = type.body, color = colors.fg3, textAlign = if (center) TextAlign.Center else TextAlign.Start,
                modifier = Modifier.padding(top = metrics.controlInset / 2),
            )
            content()
        }
        Column(Modifier.fillMaxWidth().padding(vertical = metrics.pageInset), verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) { bottom() }
    }
}

@Composable
private fun Welcome(onStart: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    PageFrame(
        title = stringResource(Res.string.onboarding_brand),
        subtitle = stringResource(Res.string.onboarding_tagline),
        center = true,
        lead = {
            // Drawn once here: outline, fill, mane, eye, then it holds still.
            LiveBrandMark(Modifier.size(WelcomeMarkSize), fg = colors.fg, accent = colors.accent, style = LiveBrandStyle.Draw, once = true)
            Spacer(Modifier.height(metrics.pageInset))
        },
        bottom = { PrimaryAction(stringResource(Res.string.onboarding_start), onStart) },
    ) {}
}

@Composable
private fun Connect(actions: SetupActions) {
    val metrics = LocalInterfaceStyle.current.metrics
    val found = rememberFoundServers()
    val scannable = remember { createQrScanner().isSupported }
    PageFrame(
        title = stringResource(Res.string.onboarding_connect_title),
        subtitle = stringResource(Res.string.onboarding_connect_hint),
        bottom = {
            if (scannable) {
                PrimaryAction(stringResource(Res.string.onboarding_scan), actions.scan)
                SecondaryAction(stringResource(Res.string.onboarding_enter_address), actions.enterAddress)
            } else PrimaryAction(stringResource(Res.string.onboarding_enter_address), actions.enterAddress)
        },
    ) {
        Spacer(Modifier.height(metrics.pageInset))
        found.servers.forEach { server ->
            FoundServerRow(server, enabled = actions.busy.value == null, onConnect = {
                actions.connectTo(riffet.ui.pairing.formatServerAddress(server.host, server.port))
            })
        }
    }
}

@Composable
private fun Notify(onAllow: () -> Unit, onLater: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    PageFrame(
        title = stringResource(Res.string.onboarding_notify_title),
        subtitle = stringResource(Res.string.onboarding_notify_hint),
        bottom = {
            PrimaryAction(stringResource(Res.string.onboarding_notify_allow), onAllow)
            SecondaryAction(stringResource(Res.string.onboarding_notify_later), onLater)
        },
    ) {
        Spacer(Modifier.height(metrics.pageInset))
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(metrics.groupRadius)).background(LocalRiffetSurfaces.current.card).padding(metrics.rowPadding),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(metrics.rowPadding),
        ) {
            Box(
                Modifier.size(metrics.controlHeight).clip(RoundedCornerShape(metrics.iconTileRadius)).background(colors.fg),
                contentAlignment = Alignment.Center,
            ) { BrandMark(Modifier.size(metrics.iconSize), fg = colors.bg, accent = colors.accent) }
            Column {
                Text(stringResource(Res.string.onboarding_sample_title), style = type.headline, color = colors.fg)
                Text(stringResource(Res.string.onboarding_sample_body), style = type.bodySmall, color = colors.fg3)
            }
        }
    }
}

@Composable
private fun PrimaryAction(text: String, onClick: () -> Unit) {
    RiffetButton(text, onClick, primary = true, modifier = Modifier.fillMaxWidth().heightIn(min = LocalInterfaceStyle.current.metrics.controlHeight))
}

@Composable
private fun SecondaryAction(text: String, onClick: () -> Unit) {
    RiffetTextButton(onClick, Modifier.fillMaxWidth().heightIn(min = LocalInterfaceStyle.current.metrics.controlHeight)) { Text(text, color = LocalRiffetColors.current.fg2) }
}
