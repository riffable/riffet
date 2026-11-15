package riffet.ui.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.shared.DiscoveredServer
import riffet.shared.PairingPayload
import riffet.shared.PairingPayloadException
import riffet.shared.QrScanner
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.shared.RiffetHttpException
import riffet.shared.RiffetNetworkException
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.ServerDiscovery
import riffet.shared.createQrScanner
import riffet.shared.createServerDiscovery
import riffet.ui.app.LocalPageBack
import riffet.ui.app.PageBackHandler
import riffet.ui.app.PageBarAction
import riffet.ui.app.PageBarProgress
import riffet.ui.app.PageHost
import riffet.ui.app.PageLeaveGuard
import riffet.ui.app.PageNavigation
import riffet.ui.app.PageStack
import riffet.ui.app.PageTopBar
import riffet.ui.design.GroupRow
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.RiffetIconButton
import riffet.ui.design.RiffetTextButton
import riffet.ui.design.RiffetTextField
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.settings.SettingsFootnote
import riffet.ui.settings.SettingsGroup
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsPage
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** The two pages of pairing: the form, and the full-screen scanner pushed over it. */
private enum class PairingRoute { Form, Scan }

/**
 * The pairing page (an edit/new page, mobile.md §2.3): discovered servers first, then the address
 * and the code, with 配对 in the top bar beside the scan action. The bar carries the verb because
 * that is where every edit page keeps it and it stays put under the keyboard; while a pair runs it
 * becomes a spinner in the same place.
 *
 * Its main path is **typing**: an 8-symbol code read off the Mac, and a host. Scanning is an
 * addition, never a replacement: `riffet status` prints a QR for exactly this feature, and
 * [QrScanner] reads it. The scanner is a page pushed over the form; every failure (no camera, a
 * refused permission, a camera held by another app) just pops it again, and a successful scan
 * *prefills* the fields, so a scan that pairs nothing usable still leaves the user able to retry.
 *
 * A decoded payload is complete (`scheme`, `host`, `port`, `code` — see [PairingPayload]), so it is
 * redeemed as-is rather than being round-tripped through [normalizeServerAddress]: the server decided
 * the scheme (docs/MOBILE.md, "scheme 由服务端决定").
 *
 * Failures are honest and shown where they happened: a code problem under the code field, an address
 * problem under the address field, everything else in a banner. [PairingError] has a case per cause.
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
    val clipboard = LocalClipboardManager.current
    val composedScope = rememberCoroutineScope()
    val scope = operationScope ?: composedScope
    val scannedUnreadable = stringResource(Res.string.settings_extra_pair_scanned_unreadable)
    // Read here, outside the nested host below, which provides its own.
    val hostedBack = LocalPageBack.current

    var address by remember(initialAddress) { mutableStateOf(initialAddress) }
    var serverName by remember(initialAddress) { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }
    var discovered by remember { mutableStateOf<List<DiscoveredServer>>(emptyList()) }
    var discovering by remember { mutableStateOf(true) }
    val pairing = connectionOperation.value != null
    var error by remember { mutableStateOf<PairingError?>(if (revoked) PairingError.DeviceRevoked else null) }
    val pages = remember { PageStack(PairingRoute.Form) }

    PageBackHandler(enabled = pairing || onCancel != null && hostedBack == null) { if (!pairing) onCancel?.invoke() }
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

    val canSubmit = normalizeServerAddress(address) != null && isPlausiblePairingCode(code) && !pairing

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
     * ("升级应用") rather than redeemed as if it were garbage. The scanner page is already gone: the
     * form it uncovers is the one that shows progress.
     */
    fun pairFromScan(raw: String) {
        if (connectionOperation.value != null) return
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

    PageHost(pages, modifier) { route, back ->
        when (route) {
            PairingRoute.Form -> SettingsPage(
                title = stringResource(if (initialAddress.isBlank()) Res.string.pairing_title_new else Res.string.pairing_title_repair),
                onBack = { if (!pairing) onCancel?.invoke() },
                navigation = PageNavigation.CLOSE,
                actions = {
                    if (pairing) PageBarProgress() else {
                        // Offered only where there is a camera to offer: a device with none keeps exactly
                        // the page it had, rather than a button that can only fail.
                        if (scanner.isSupported) PageBarAction(PairingIcons.ScanLine, stringResource(Res.string.pairing_scan_start), {
                            error = null
                            pages.push(PairingRoute.Scan)
                        })
                        RiffetTextButton(onClick = ::submit, enabled = canSubmit) { Text(stringResource(Res.string.pairing_pair)) }
                    }
                },
            ) {
                val failure = error
                if (failure != null && failure.field == PairingField.PAGE) PairingBanner(failure)

                DiscoverySection(
                    discovering = discovering,
                    servers = discovered,
                    selected = address,
                    enabled = !pairing,
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
                    label = { Text(stringResource(Res.string.pairp_address)) },
                    placeholder = stringResource(Res.string.pairing_server_address_placeholder),
                    singleLine = true,
                    enabled = !pairing,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                if (failure != null && failure.field == PairingField.ADDRESS) FieldError(failure)

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
                        RiffetIconButton(
                            enabled = !pairing,
                            onClick = {
                                readClipboardCode()
                                    ?.filter { char -> char in PAIRING_CODE_ALPHABET }
                                    ?.take(PAIRING_CODE_LENGTH)
                                    ?.let { code = it }
                            },
                        ) {
                            Icon(PairingIcons.ClipboardPaste, contentDescription = stringResource(Res.string.pairing_paste), modifier = Modifier.size(20.dp))
                        }
                    },
                )
                if (failure != null && failure.field == PairingField.CODE) FieldError(failure)
                SettingsFootnote(stringResource(Res.string.pairing_connect_hint))
            }

            PairingRoute.Scan -> ScannerPage(
                scanner = scanner,
                onBack = back,
                onDecoded = { raw ->
                    back()
                    pairFromScan(raw)
                },
            )
        }
    }
}

@Composable
private fun rememberServerDiscovery(): ServerDiscovery = remember { createServerDiscovery() }

@Composable
private fun rememberQrScanner(): QrScanner = remember { createQrScanner() }

/**
 * The full-screen scanner page. It owns nothing: [QrScanner.Preview] binds the camera while it is
 * composed and releases it when the page is popped. A decode or a camera that cannot run pops the
 * page; the latter silently, by contract: whatever went wrong, the typed form behind it does the same
 * job, and one more error state would imply otherwise.
 */
@Composable
private fun ScannerPage(
    scanner: QrScanner,
    onBack: () -> Unit,
    onDecoded: (String) -> Unit,
) {
    // The camera can decode on consecutive frames; only the first one counts.
    val done = remember { booleanArrayOf(false) }
    fun finish(raw: String?) {
        if (done[0]) return
        done[0] = true
        if (raw != null) onDecoded(raw) else onBack()
    }
    Column(Modifier.fillMaxSize().background(LocalRiffetSurfaces.current.page)) {
        PageTopBar(title = stringResource(Res.string.pairing_scan_start), onBack = { finish(null) })
        // Black behind the preview, so the frame where the camera has not started yet is an empty
        // viewfinder rather than a flash of the page background.
        Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
            scanner.Preview(
                onDecoded = { raw -> finish(raw) },
                onUnavailable = { finish(null) },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
private fun DiscoverySection(
    discovering: Boolean,
    servers: List<DiscoveredServer>,
    selected: String,
    enabled: Boolean,
    onPick: (DiscoveredServer) -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    when {
        discovering -> Row(
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            riffet.ui.timeline.Spinner(size = 14.dp)
            Spacer(Modifier.width(8.dp))
            Text(text = stringResource(Res.string.pairing_discovering), style = typography.bodySmall, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }

        servers.isNotEmpty() -> SettingsGroup(stringResource(Res.string.pairing_discovered_servers)) {
            servers.forEach { server ->
                val serverAddress = formatServerAddress(server.host, server.port)
                GroupRow(
                    title = server.name,
                    subtitle = serverAddress,
                    enabled = enabled,
                    trailing = if (serverAddress == selected.trim()) {
                        { Icon(RiffetIcons.Check, contentDescription = null, tint = colors.accent, modifier = Modifier.size(18.dp)) }
                    } else null,
                    onClick = { onPick(server) },
                )
            }
        }

        // Found nothing: say nothing. The fields below are the path, and an error here would be
        // an error about an optimisation the user never asked for.
        else -> Unit
    }
}

/** Where a failure is shown: under the field it is about, or in a banner when it is about neither. */
private enum class PairingField { ADDRESS, CODE, PAGE }

private val PairingError.field: PairingField
    get() = when (this) {
        PairingError.InvalidCode -> PairingField.CODE
        is PairingError.Unreachable, PairingError.NotRiffet -> PairingField.ADDRESS
        else -> PairingField.PAGE
    }

@Composable
private fun pairingErrorTitle(error: PairingError): String = when (error) {
    PairingError.InvalidCode -> stringResource(Res.string.settings_extra_pair_invalid_code_title)
    PairingError.DeviceRevoked -> stringResource(Res.string.settings_extra_pair_device_revoked_title)
    is PairingError.Unreachable -> stringResource(Res.string.settings_extra_pair_unreachable_title)
    PairingError.NotRiffet -> stringResource(Res.string.settings_extra_pair_not_riffet_title)
    is PairingError.Other -> stringResource(Res.string.settings_extra_pair_failed_title)
    is PairingError.ScannerNeedsUpgrade -> stringResource(Res.string.settings_extra_pair_upgrade_title)
    is PairingError.ScannedPayloadInvalid -> stringResource(Res.string.settings_extra_pair_scanned_invalid_title)
}

@Composable
private fun pairingErrorBody(error: PairingError): String = when (error) {
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

/** A failure that belongs to the whole attempt, at the top of the page. */
@Composable
private fun PairingBanner(error: PairingError) {
    riffet.ui.design.Notice(pairingErrorBody(error), riffet.ui.design.NoticeKind.ERROR, title = pairingErrorTitle(error))
    Spacer(Modifier.height(12.dp))
}

/** A failure under the field it is about: the diagnosis in danger colour, what to do after it in grey. */
@Composable
private fun FieldError(error: PairingError) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(Modifier.fillMaxWidth().padding(top = 6.dp)) {
        Text(text = pairingErrorTitle(error), style = typography.bodySmall, color = colors.danger)
        Text(text = pairingErrorBody(error), style = typography.bodySmall, color = colors.fg3)
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
