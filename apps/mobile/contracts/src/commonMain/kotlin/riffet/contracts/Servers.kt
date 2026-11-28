package riffet.contracts

import kotlinx.serialization.Serializable

/** Protocol feature naming multi-server links (`docs/SERVER-LINKS.md`). */
const val SERVER_LINKS_FEATURE = "server-links-v1"

/** Operating system and CPU architecture reported by a server during the link handshake. */
@Serializable
data class ServerPlatform(
    val os: String,
    val arch: String,
)

/** `GET /api/servers` and `Bootstrap.servers`: this server first, then its linked peers. */
@Serializable
data class ServerInfo(
    val id: String,
    val name: String,
    /** Short local alias for linked servers (and optional derived alias for self). */
    val alias: String? = null,
    val note: String? = null,
    val platform: ServerPlatform? = null,
    val self: Boolean? = null,
    val online: Boolean,
    val version: String? = null,
    val protocol: BootstrapProtocol? = null,
    /** Its protocol version is one this server reads. */
    val compatible: Boolean,
    /** The other server may operate this one. */
    val inbound: Boolean,
    /** This server may operate the other one. */
    val outbound: Boolean,
    val lastConnectedAt: String? = null,
) {
    /** Swift-friendly alias for [self] (`self` collides with Objective-C/Swift keywords). */
    val isSelf: Boolean get() = self == true
}

/** Reachability of one linked peer's lists as observed through the entry server. */
enum class LinkedServerStatus {
    LOADING,
    FRESH,
    OFFLINE,
}
