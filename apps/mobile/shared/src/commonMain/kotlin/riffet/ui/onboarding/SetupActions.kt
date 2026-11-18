package riffet.ui.onboarding

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.CancellationException
import org.jetbrains.compose.resources.stringResource
import riffet.shared.DiscoveredServer
import riffet.shared.RiffetConnection
import riffet.shared.createServerDiscovery
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.EmptyState
import riffet.ui.design.GroupRow
import riffet.ui.design.RiffetButton
import riffet.ui.icons.Icon
import riffet.ui.pairing.PairingIcons
import riffet.ui.theme.LocalRiffetColors
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.needs_server_title
import riffet_mobile.shared.generated.resources.onboarding_connect

/**
 * What the unconnected screens can do about it: the setup island, the onboarding and the empty
 * state all start the same pairing flow, so the app provides one set of entries.
 */
internal class SetupActions(
    val connection: RiffetConnection,
    /** The origin a pairing runs for, while one does. */
    val busy: State<String?>,
    /** Opens the pairing page on the scanner. */
    val scan: () -> Unit,
    /** Opens the pairing page with this address filled in; the code is still typed or scanned. */
    val connectTo: (String) -> Unit,
    /** Opens the pairing page on the address form. */
    val enterAddress: () -> Unit,
    /** Goes to the 新会话 tab, where the setup island is. */
    val showSetup: () -> Unit,
)

internal val LocalSetupActions = compositionLocalOf<SetupActions?> { null }

/** The servers the network answered for. */
internal class FoundServers(val servers: List<DiscoveredServer>)

/** One best-effort look at the local network; it never reports a failure, an empty list is the answer. */
@Composable
internal fun rememberFoundServers(): FoundServers {
    val discovery = remember { createServerDiscovery() }
    var found by remember { mutableStateOf(FoundServers(emptyList())) }
    LaunchedEffect(discovery) {
        val servers = try {
            discovery.discover()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            emptyList()
        }
        found = FoundServers(servers.distinctBy { it.host to it.port })
    }
    return found
}

/** A server the local network offers: its name and host, and the button that opens pairing with it. */
@Composable
internal fun FoundServerRow(server: DiscoveredServer, enabled: Boolean, onConnect: () -> Unit, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    GroupRow(
        title = server.name,
        subtitle = riffet.ui.pairing.formatServerAddress(server.host, server.port),
        titleLines = 1,
        modifier = modifier,
        leading = { Icon(PairingIcons.Wifi, null, Modifier.size(metrics.iconSize), LocalRiffetColors.current.fg3) },
        trailing = { RiffetButton(stringResource(Res.string.onboarding_connect), onConnect, enabled = enabled) },
    )
}

/** The page of a tab that needs a server: the server icon, what is missing, and the way to the setup. */
@Composable
internal fun NeedsServerState(onConnect: () -> Unit, modifier: Modifier = Modifier, fill: Boolean = true) {
    EmptyState(
        message = null,
        modifier = modifier,
        icon = PairingIcons.Server,
        title = stringResource(Res.string.needs_server_title),
        fill = fill,
        actions = { RiffetButton(stringResource(Res.string.onboarding_connect), onConnect) },
    )
}
