package riffet.ui.pairing

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.app.PageTopBar
import androidx.compose.ui.semantics.Role
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetTextField
import riffet.ui.design.AlertDialog
import riffet.ui.design.RiffetTextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import riffet.ui.app.PageBackHandler
import riffet.ui.app.LocalPageBack
import riffet.ui.app.PageLeaveGuard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.shared.DiscoveredServer
import riffet.shared.PairingPayload
import riffet.shared.PairingPayloadException
import riffet.shared.QrScanner
import riffet.shared.ServerDiscovery
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.shared.RiffetHttpException
import riffet.shared.RiffetNetworkException
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.createQrScanner
import riffet.shared.createServerDiscovery
import riffet.ui.icons.BrandMark
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion

/**
 * The phone-shaped pairing screen. It is the only way a device gets a server address and a device
 * token, so its main path is **typing**: an 8-symbol code read off the Mac, and a host.
 *
 * ## Scanning is an addition, never a replacement
 *
 * `riffet status` prints a QR for exactly this feature, and [QrScanner] reads it. The scanner is
 * reached from one affordance next to the code field and opens in a dialog over the form. It can fail
 * at every step — no camera, a refused permission, a camera another app is holding, an unreadable
 * frame — and every one of those failures just closes the dialog again. The typed fields are the
 * same widget they were before, and a successful scan *prefills* them, so even a scan that pairs
 * nothing usable leaves the user able to retry by hand.
 *
 * A decoded payload is complete (`scheme`, `host`, `port`, `code` — see [PairingPayload]), so it is
 * redeemed as-is rather than being round-tripped through [normalizeServerAddress]: the server decided
 * the scheme (docs/MOBILE.md, "scheme 由服务端决定"), and re-deriving it here could only lose that.
 *
 * ## Honest failure states
 *
 * [PairingError] has a case per distinct cause and the server's own message is shown for anything
 * unexpected. Nothing is collapsed into one "失败": an expired code and an unreachable Mac need
 * different actions from the user. The two scan-shaped cases follow the same rule — an unknown
 * payload *version* means "upgrade the app", not "the code is broken", which is precisely why
 * [PairingPayload.parse] distinguishes them.
 */
@Composable
fun PairingScreen(
    connection: RiffetConnection,
    onPaired: (RiffetApi) -> Unit,
    modifier: Modifier = Modifier,
    discovery: ServerDiscovery = rememberServerDiscovery(),
    scanner: QrScanner = rememberQrScanner(),
    onCancel: (() -> Unit)? = null,
    /** Opened because the server rejected this device's token: say so before anything is tried. */
    revoked: Boolean = false,
    initialAddress: String = "",
    operationScope: CoroutineScope? = null,
    connectionOperation: MutableState<String?> = remember { mutableStateOf<String?>(null) },
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val clipboard = LocalClipboardManager.current
    val composedScope = rememberCoroutineScope()
    val scope = operationScope ?: composedScope
    val scannedUnreadable = stringResource(Res.string.settings_extra_pair_scanned_unreadable)

    var address by remember(initialAddress) { mutableStateOf(initialAddress) }
    var serverName by remember(initialAddress) { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }
    var discovered by remember { mutableStateOf<List<DiscoveredServer>>(emptyList()) }
    var discovering by remember { mutableStateOf(true) }
    val pairing = connectionOperation.value != null
    var error by remember { mutableStateOf<PairingError?>(if (revoked) PairingError.DeviceRevoked else null) }
    var scanning by remember { mutableStateOf(false) }
    // Each open gets its own scanner: one that already decoded (or was left mid-exit) never fires again.
    var scanAttempt by remember { mutableStateOf(0) }

    PageBackHandler(enabled = pairing || onCancel != null && LocalPageBack.current == null) { if (!pairing) onCancel?.invoke() }
    PageLeaveGuard { !pairing }

    fun readClipboardCode(): String? =
        runCatching { clipboard.getText()?.text?.let(::normalizePairingCode) }.getOrNull()

    // Pasting the code is far more common than typing it, so an empty field starts from the
    // clipboard. A clipboard holding anything that is not a plausible code is ignored silently.
    LaunchedEffect(Unit) {
        if (code.isEmpty()) {
            readClipboardCode()?.takeIf(::isPlausiblePairingCode)?.let { code = it }
        }
    }

    // Discovery is best-effort: an empty list (no responder, no permission, unsupported platform)
    // just means the manual field is the path. It never sets an error.
    LaunchedEffect(discovery) {
        val found = try {
            discovery.discover()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            // The interface promises not to throw; this guards a broken actual anyway.
            emptyList()
        }
        val servers = found.distinctBy { it.host to it.port }
        discovered = servers
        if (address.isBlank()) {
            servers.firstOrNull()?.let {
                address = formatServerAddress(it.host, it.port)
                serverName = it.name
            }
        }
        discovering = false
    }

    val addressOk = normalizeServerAddress(address) != null
    val codeOk = isPlausiblePairingCode(code)
    val canSubmit = addressOk && codeOk && !pairing

    fun submit() {
        if (connectionOperation.value != null) return
        val target = normalizeServerAddress(address) ?: return
        val cleanCode = normalizePairingCode(code)
        connectionOperation.value = target.baseUrl
        error = null
        scope.launch {
            try {
                when (val outcome = attemptPair(connection, target, cleanCode, serverName)) {
                    is PairingOutcome.Success -> onPaired(connection.requireApi())
                    is PairingOutcome.Failure -> error = outcome.error
                }
            } finally {
                connectionOperation.value = null
            }
        }
    }

    /**
     * A decoded QR. Parsing comes first so a payload this build cannot understand is explained
     * ("升级应用") rather than redeemed as if it were garbage, and the preview closes on every path:
     * from here the typed form owns the screen again.
     */
    fun pairFromScan(raw: String) {
        if (connectionOperation.value != null) return
        scanning = false
        error = null

        val payload = try {
            PairingPayload.parse(raw)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (unknownVersion: PairingPayloadException.UnknownVersion) {
            // The parser tells these two apart on purpose; "二维码损坏" here would send the user to
            // reprint a perfectly good QR instead of updating the app.
            error = PairingError.ScannerNeedsUpgrade(unknownVersion.version)
            return
        } catch (invalid: PairingPayloadException.Invalid) {
            error = PairingError.ScannedPayloadInvalid(invalid.message ?: scannedUnreadable)
            return
        } catch (unexpected: Throwable) {
            error = PairingError.ScannedPayloadInvalid(unexpected.message ?: unexpected.toString())
            return
        }

        // Prefill *before* pairing, not after: if the pair fails, the fields already hold what was
        // scanned and one edit plus 配对 is all a retry costs. A payload that says https keeps its
        // scheme in the field, because the field is what a by-hand retry would use.
        address = formatServerAddress(payload.host, payload.port).let {
            if (payload.scheme == PairingPayload.HTTPS) "https://$it" else it
        }
        serverName = payload.name
        code = normalizePairingCode(payload.code).take(PAIRING_CODE_LENGTH)

        connectionOperation.value = payload.baseUrl
        scope.launch {
            try {
                when (val outcome = redeemPayload(connection, payload)) {
                    is PairingOutcome.Success -> onPaired(connection.requireApi())
                    is PairingOutcome.Failure -> error = outcome.error
                }
            } finally {
                connectionOperation.value = null
            }
        }
    }

    Column(modifier = modifier.fillMaxSize().background(LocalRiffetSurfaces.current.page)) {
        if (onCancel != null) {
            PageTopBar(title = if (initialAddress.isBlank()) stringResource(Res.string.pairing_title_new) else stringResource(Res.string.pairing_title_repair), onBack = { if (!pairing) onCancel() })
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            BrandMark(fg = colors.fg, accent = colors.accent, modifier = Modifier.size(40.dp))
            Spacer(Modifier.height(12.dp))
            Text(text = stringResource(Res.string.pairing_connect_title), style = typography.title, color = colors.fg)
            Spacer(Modifier.height(8.dp))
            Text(
                text = stringResource(Res.string.pairing_connect_hint),
                style = typography.bodySmall,
                color = colors.fg3,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(24.dp))

            DiscoverySection(
                discovering = discovering,
                servers = discovered,
                onPick = { server ->
                    address = formatServerAddress(server.host, server.port)
                    serverName = server.name
                    error = null
                },
            )

            Spacer(Modifier.height(16.dp))
            RiffetTextField(
                value = address,
                onValueChange = {
                    address = it
                    serverName = null
                    error = null
                },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(Res.string.pairing_server_address)) },
                placeholder = stringResource(Res.string.pairing_server_address_placeholder),
                singleLine = true,
                enabled = !pairing,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )

            Spacer(Modifier.height(16.dp))
            RiffetTextField(
                value = code,
                onValueChange = { raw ->
                    code = raw.uppercase().filter { it in PAIRING_CODE_ALPHABET }.take(PAIRING_CODE_LENGTH)
                    error = null
                },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(Res.string.pairing_code)) },
                placeholder = stringResource(Res.string.pairing_code_placeholder),
                singleLine = true,
                enabled = !pairing,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Ascii,
                    capitalization = KeyboardCapitalization.Characters,
                ),
                trailingIcon = {
                    riffet.ui.design.RiffetTextButton(
                        enabled = !pairing,
                        onClick = {
                            readClipboardCode()
                                ?.filter { char -> char in PAIRING_CODE_ALPHABET }
                                ?.take(PAIRING_CODE_LENGTH)
                                ?.let { code = it }
                        },
                    ) {
                        Text(stringResource(Res.string.pairing_paste), style = typography.label)
                    }
                },
            )
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Spacer(Modifier.weight(1f))
                // Offered only where there is a camera to offer: a device with none keeps exactly the
                // screen it had, rather than a button that can only fail.
                if (scanner.isSupported) {
                    riffet.ui.design.RiffetTextButton(
                        enabled = !pairing,
                        onClick = {
                            scanAttempt++
                            scanning = true
                            error = null
                        },
                    ) {
                        Text(stringResource(Res.string.pairing_scan_start), style = typography.label)
                    }
                }
            }

            // The card keeps the last failure while it collapses, so it does not empty out first.
            var lastError by remember { mutableStateOf(error) }
            if (error != null && error != lastError) lastError = error
            AnimatedVisibility(visible = error != null, enter = motion.expandIn(), exit = motion.collapseOut()) {
                lastError?.let { failure ->
                    Column {
                        Spacer(Modifier.height(20.dp))
                        ErrorCard(failure)
                    }
                }
            }

            Spacer(Modifier.height(24.dp))
            if (pairing) {
                CircularProgressIndicator(
                    modifier = Modifier.size(designMetrics.buttonIconSize).align(Alignment.CenterHorizontally),
                    strokeWidth = 2.dp,
                    color = colors.accent,
                )
                Spacer(Modifier.height(8.dp))
            }
            riffet.ui.design.RiffetButton(
                text = stringResource(if (pairing) Res.string.pairing_pairing else Res.string.pairing_pair),
                onClick = ::submit,
                enabled = canSubmit,
                primary = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }

    if (scanning) key(scanAttempt) {
        // Redeemed once the dialog has left, so the form it uncovers is the one that shows progress.
        var decoded by remember { mutableStateOf<String?>(null) }
        ScannerDialog(
            scanner = scanner,
            onDecoded = { decoded = it },
            onDismiss = {
                scanning = false
                decoded?.let(::pairFromScan)
            },
        )
    }
}

@Composable
private fun rememberServerDiscovery(): ServerDiscovery = remember { createServerDiscovery() }

@Composable
private fun rememberQrScanner(): QrScanner = remember { createQrScanner() }

/**
 * The live preview in a dialog over the form. It owns nothing: [QrScanner.Preview] binds the camera
 * while it is composed and releases it when the dialog is gone. A decode or a camera that cannot run
 * closes the dialog; the latter silently, by contract — whatever went wrong, the typed form behind it
 * does the same job, and a sixth error state would imply otherwise.
 */
@Composable
private fun ScannerDialog(
    scanner: QrScanner,
    onDecoded: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    // The camera can decode on consecutive frames; only the first one pairs and closes.
    val done = remember { booleanArrayOf(false) }
    fun finish() {
        if (done[0]) return
        done[0] = true
        onDismiss()
    }
    AlertDialog(
        onDismissRequest = ::finish,
        title = { Text(stringResource(Res.string.pairing_scan_start)) },
        text = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .clip(RoundedCornerShape(LocalInterfaceStyle.current.groupRadius))
                    // Black behind the preview, so the frame where the camera has not started yet is an
                    // empty viewfinder rather than a flash of the dialog's background.
                    .background(Color.Black),
            ) {
                scanner.Preview(
                    onDecoded = { raw ->
                        if (!done[0]) onDecoded(raw)
                        finish()
                    },
                    onUnavailable = { finish() },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        },
        confirmButton = { RiffetTextButton(onClick = ::finish) { Text(stringResource(Res.string.settings_cancel)) } },
    )
}

@Composable
private fun DiscoverySection(
    discovering: Boolean,
    servers: List<DiscoveredServer>,
    onPick: (DiscoveredServer) -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    when {
        discovering -> Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 1.5.dp, color = colors.accent)
            Spacer(Modifier.width(8.dp))
            Text(text = stringResource(Res.string.pairing_discovering), style = typography.caption, color = colors.fg3)
        }

        servers.isNotEmpty() -> Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(text = stringResource(Res.string.pairing_discovered_servers), style = typography.label, color = colors.fg2)
            servers.forEach { server ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(LocalInterfaceStyle.current.rowRadius))
                        .background(colors.bgSubtle)
                        .clickable { onPick(server) }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(text = server.name, style = typography.body, color = colors.fg, maxLines = 1)
                        Text(
                            text = formatServerAddress(server.host, server.port),
                            style = typography.monoSmall,
                            color = colors.fg4,
                            maxLines = 1,
                        )
                    }
                    Text(text = stringResource(Res.string.pairing_use), style = typography.label, color = colors.accent)
                }
            }
        }

        // Found nothing: say nothing. The manual field above is the path, and an error here would be
        // an error about an optimisation the user never asked for.
        else -> Unit
    }
}

@Composable
private fun ErrorCard(error: PairingError) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val title = when (error) {
        PairingError.InvalidCode -> stringResource(Res.string.settings_extra_pair_invalid_code_title)
        PairingError.DeviceRevoked -> stringResource(Res.string.settings_extra_pair_device_revoked_title)
        is PairingError.Unreachable -> stringResource(Res.string.settings_extra_pair_unreachable_title)
        PairingError.NotRiffet -> stringResource(Res.string.settings_extra_pair_not_riffet_title)
        is PairingError.Other -> stringResource(Res.string.settings_extra_pair_failed_title)
        is PairingError.ScannerNeedsUpgrade -> stringResource(Res.string.settings_extra_pair_upgrade_title)
        is PairingError.ScannedPayloadInvalid -> stringResource(Res.string.settings_extra_pair_scanned_invalid_title)
    }
    val body = when (error) {
        PairingError.InvalidCode -> stringResource(Res.string.settings_extra_pair_invalid_code_body)
        PairingError.DeviceRevoked -> stringResource(Res.string.settings_extra_pair_device_revoked_body)
        is PairingError.Unreachable -> stringResource(Res.string.settings_extra_pair_unreachable_body, error.address)
        PairingError.NotRiffet -> stringResource(Res.string.settings_extra_pair_not_riffet_body)
        is PairingError.Other -> error.detail
        is PairingError.ScannerNeedsUpgrade -> {
            val prefix = stringResource(Res.string.settings_extra_pair_upgrade_body_prefix)
            val version = error.version?.let { stringResource(Res.string.settings_extra_pair_upgrade_version, it) }.orEmpty()
            val suffix = stringResource(Res.string.settings_extra_pair_upgrade_body_suffix)
            prefix + version + suffix
        }
        is PairingError.ScannedPayloadInvalid -> stringResource(Res.string.settings_extra_pair_scanned_invalid_body, error.detail)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.dangerSoft, RoundedCornerShape(LocalInterfaceStyle.current.groupRadius))
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Icon(RiffetIcons.Error, contentDescription = null, tint = colors.danger, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(10.dp))
        Column {
            Text(text = title, style = typography.label, color = colors.fg, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(text = body, style = typography.bodySmall, color = colors.fg2)
        }
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Pairing attempt and its failure taxonomy                                                     */
/* ------------------------------------------------------------------------------------------- */

private sealed interface PairingOutcome {
    data object Success : PairingOutcome
    data class Failure(val error: PairingError) : PairingOutcome
}

/**
 * Every distinct way pairing can fail, each with its own user-facing message. A wrong address and an
 * expired code are not the same problem, so they are not the same message.
 */
internal sealed interface PairingError {
    /** The server answered `401 INVALID_PAIRING_CODE`: the code is wrong, used, or older than 5 min. */
    data object InvalidCode : PairingError

    /** A 401 with some other code: this device's credential was revoked and must be re-issued. */
    data object DeviceRevoked : PairingError

    /** Nothing answered: wrong network, server not running, or the port is closed. */
    data class Unreachable(val address: String) : PairingError

    /** Something answered, but it is not a Riffet API (a router page, another service, an old build). */
    data object NotRiffet : PairingError

    /** Anything else, with the server's or transport's own message kept verbatim. */
    data class Other(val detail: String) : PairingError

    /**
     * A scanned QR whose payload version this build does not know
     * ([PairingPayloadException.UnknownVersion]). The QR is fine — the app is older than the server
     * that printed it, so the only useful action is to update, which is what the title says.
     */
    data class ScannerNeedsUpgrade(val version: Int?) : PairingError

    /**
     * A scanned QR that is not a pairing payload at all: someone else's QR, a partially read frame,
     * or a payload missing its host/port/code. The parser's own message says which, and the typed
     * form is one tap away.
     */
    data class ScannedPayloadInvalid(val detail: String) : PairingError
}

/**
 * Proves it is talking to a Riffet server, then redeems the code.
 *
 * The probe is a single public `GET /api/auth/status`, sent without the device token: the address is
 * whatever was typed or discovered, and nothing has shown it to be the server that issued the token. Without it a wrong server is indistinguishable
 * from a Riffet error: an unrelated service's HTML 404 has no Riffet error code, so "answered but not
 * Riffet" and "Riffet refused" would collapse into one message. A typed Riffet error (for instance
 * `INVALID_HOST`, which a Riffet server answers with a code) still counts as a Riffet server.
 *
 * This is the *typed* path only. A scanned payload skips the probe and goes straight to
 * [redeemPayload]: the QR came from a Riffet server, and the redeem path below still separates "not
 * Riffet" from "Riffet refused", so nothing is weakened by not asking twice.
 */
private suspend fun attemptPair(
    connection: RiffetConnection,
    target: ServerAddress,
    code: String,
    name: String? = null,
): PairingOutcome {
    try {
        withTimeoutOrNull(10_000L) { connection.probe(target.baseUrl).authStatus() }
            ?: return PairingOutcome.Failure(PairingError.Unreachable(target.baseUrl.removePrefix("${target.scheme}://")))
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (_: RiffetNetworkException) {
        return PairingOutcome.Failure(PairingError.Unreachable(target.baseUrl.removePrefix("${target.scheme}://")))
    } catch (http: RiffetHttpException) {
        // A typed code proves a Riffet server; a bare HTML/plain status does not.
        if (http.code == null) return PairingOutcome.Failure(PairingError.NotRiffet)
    } catch (_: Throwable) {
        return PairingOutcome.Failure(PairingError.NotRiffet)
    }

    val payload = PairingPayload(
        v = PairingPayload.CURRENT_VERSION,
        host = target.host,
        port = target.port,
        code = code,
        name = name,
        // Carry through whatever the person typed: `https://` means a TLS front door is in front.
        scheme = target.scheme,
    )
    return redeemPayload(connection, payload)
}

/**
 * Redeems a complete [PairingPayload] — whether it was typed or scanned — and maps every way that can
 * fail onto one [PairingError]. Both entry points share it so a scanned pair and a typed pair report
 * an expired code, a revoked device, an unreachable Mac and a non-Riffet responder identically.
 */
private suspend fun redeemPayload(
    connection: RiffetConnection,
    payload: PairingPayload,
): PairingOutcome {
    // What the user sees for "could not reach it" is the host and port, not the URL scheme.
    val displayAddress = payload.baseUrl.removePrefix("${payload.scheme}://")
    return try {
        connection.pair(payload)
        PairingOutcome.Success
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (unauthenticated: RiffetUnauthenticatedException) {
        val error = if (unauthenticated.code == "INVALID_PAIRING_CODE") {
            PairingError.InvalidCode
        } else {
            PairingError.DeviceRevoked
        }
        PairingOutcome.Failure(error)
    } catch (_: RiffetNetworkException) {
        PairingOutcome.Failure(PairingError.Unreachable(displayAddress))
    } catch (http: RiffetHttpException) {
        val error = when (http.code) {
            "INVALID_PAIRING_CODE" -> PairingError.InvalidCode
            // Answered, but with no Riffet error code: a router page or another service.
            null -> PairingError.NotRiffet
            else -> PairingError.Other(http.message ?: getString(Res.string.settings_extra_pair_server_status, http.status))
        }
        PairingOutcome.Failure(error)
    } catch (error: Throwable) {
        PairingOutcome.Failure(PairingError.Other(error.message ?: error.toString()))
    }
}
