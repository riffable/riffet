package riffet.contracts

import kotlinx.serialization.Serializable

/*
 * The workbench owner's personal info (个人资料), mirroring packages/contracts/src/owner.ts; see
 * docs/OWNER.md. One per server, shared by every paired device. `type` stays a string.
 */

const val OWNER_NAME_MAX = 32
/** Clients crop and scale to a square of this side before uploading; the server does not resize. */
const val OWNER_AVATAR_SIDE = 512
const val OWNER_AVATAR_MAX_BYTES = 1024 * 1024

@Serializable
data class OwnerAvatar(
    val sha256: String,
    val type: String,
    val size: Long,
    /** `/api/owner/avatar/<sha256>`: content-addressed, cached for good. */
    val url: String,
    /** Set when the avatar came from a generated style rather than an upload. */
    val generated: OwnerAvatarGenerated? = null,
)

@Serializable
data class OwnerAvatarGenerated(val style: String, val seed: String)

const val OWNER_AVATAR_SEED_MAX = 64
const val OWNER_AVATAR_HISTORY_MAX = 12
const val OWNER_AVATAR_PREVIEW_SIDE = 128

/** An enabled plugin's generated avatar style, from `GET /api/owner/avatar-styles`. */
@Serializable
data class OwnerAvatarStyle(
    /** Contribution id, `<pluginId>/<name>`. */
    val id: String,
    val pluginId: String,
    val title: Map<String, String> = emptyMap(),
    val credit: String? = null,
    /** Draws the owner's name; offered only when there is one. */
    val needsName: Boolean = false,
)

@Serializable
data class OwnerAvatarStyleList(val styles: List<OwnerAvatarStyle> = emptyList())

/** `GET /api/owner`, `Bootstrap.owner`, and the `owner` event of `/api/lists/stream`. */
@Serializable
data class OwnerInfo(
    val revision: Long = 0,
    val name: String? = null,
    val avatar: OwnerAvatar? = null,
    /** Earlier avatars, most recently used first; never includes the current one. */
    val history: List<OwnerAvatar> = emptyList(),
    val updatedAt: String? = null,
) {
    /** The name's first character, upper-cased; null without a name. */
    val monogram: String? get() = name?.trim()?.takeIf { it.isNotEmpty() }?.let(::firstCharacter)?.uppercase()
}

/** The first user-perceived character, close enough without a grapheme library: a surrogate pair stays whole. */
private fun firstCharacter(text: String): String =
    if (text.length > 1 && text[0].isHighSurrogate() && text[1].isLowSurrogate()) text.substring(0, 2) else text.substring(0, 1)
