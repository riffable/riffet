package riffet.ui.settings

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.jetbrains.compose.resources.stringResource
import riffet.shared.PairingCodeResponse
import riffet.shared.RiffetApi
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.CopyTextButton
import riffet.ui.timeline.Spinner
import riffet.ui.timeline.platformNowMillis
import riffet_mobile.shared.generated.resources.*

/** The server's own TTL; a client clock that runs ahead of the server's must not stretch it. */
private const val CODE_TTL_MILLIS = 5 * 60_000L

/** Shows a one-use code and QR from the server this device is connected to, for another device to join it. */
@Composable
internal fun PairDeviceSection(api: RiffetApi) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val metrics = LocalInterfaceStyle.current.metrics
    val fallback = stringResource(Res.string.settings_load_failed_title)
    var attempt by remember(api) { mutableIntStateOf(0) }
    var issued by remember(api) { mutableStateOf<PairingCodeResponse?>(null) }
    var qr by remember(api) { mutableStateOf<QrMatrix?>(null) }
    var deadline by remember(api) { mutableLongStateOf(0L) }
    var expired by remember(api) { mutableStateOf(false) }
    var error by remember(api) { mutableStateOf<String?>(null) }

    LaunchedEffect(api, attempt) {
        issued = null
        qr = null
        expired = false
        error = null
        try {
            val response = api.pairingCode()
            deadline = minOf(response.expiresAt, platformNowMillis() + CODE_TTL_MILLIS)
            // A server before `payload` still shows its address and typed code, just without a QR.
            qr = response.payload?.let(::encodeQr)
            issued = response
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            error = failure.message?.takeIf { it.isNotBlank() } ?: fallback
        }
    }
    LaunchedEffect(issued) {
        if (issued == null) return@LaunchedEffect
        delay((deadline - platformNowMillis()).coerceAtLeast(0))
        expired = true
    }

    val response = issued
    val modules = qr
    // White regardless of theme: scanners need dark modules on a light field.
    if (modules != null || (response == null && error == null)) Box(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 8.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(232.dp).clip(RoundedCornerShape(metrics.controlRadius)).background(Color.White), contentAlignment = Alignment.Center) {
            if (modules != null) {
                Canvas(Modifier.size(232.dp).alpha(if (expired) 0.12f else 1f)) {
                    // Four light modules of quiet zone on every side.
                    val cell = size.width / (modules.size + 8)
                    for (y in 0 until modules.size) {
                        var x = 0
                        while (x < modules.size) {
                            if (!modules.isDark(x, y)) { x++; continue }
                            val start = x
                            while (x < modules.size && modules.isDark(x, y)) x++
                            drawRect(Color.Black, Offset((start + 4) * cell, (y + 4) * cell), Size((x - start) * cell, cell))
                        }
                    }
                }
            } else {
                Spinner(size = 20.dp)
            }
        }
    }
    error?.let {
        Spacer(Modifier.height(12.dp))
        PageBanner(it, SettingsNoticeKind.ERROR, stringResource(Res.string.settings_retry)) { attempt++ }
    }
    if (response != null) {
        Row(Modifier.fillMaxWidth().padding(horizontal = metrics.pageInset, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                if (expired) stringResource(Res.string.settings_pair_device_expired)
                else stringResource(Res.string.settings_pair_device_until, riffet.ui.sessionlist.clockLabel(deadline)),
                style = typography.caption, color = if (expired) colors.danger else colors.fg3,
            )
            SettingsButton(stringResource(Res.string.settings_pair_device_regenerate), onClick = { attempt++ })
        }
        val host = response.hosts.firstOrNull().orEmpty().let { if (':' in it && !it.startsWith("[")) "[$it]" else it }
        SettingsGroup("") {
            SettingsValueRow(stringResource(Res.string.pairing_server_address), "${response.scheme}://$host:${response.port}")
            SettingsRow(stringResource(Res.string.pairing_code)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SelectionContainer { Text(response.code, style = typography.mono, color = colors.fg) }
                    CopyTextButton(response.code, stringResource(Res.string.settings_pair_device_copy))
                }
            }
        }
        if (response.localOnly) PageBanner(stringResource(Res.string.settings_pair_device_local_only), SettingsNoticeKind.WARNING)
    }
}
