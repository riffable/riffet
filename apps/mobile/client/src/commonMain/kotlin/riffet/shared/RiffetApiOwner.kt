package riffet.shared

import kotlin.io.encoding.Base64
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.OwnerAvatarStyle
import riffet.contracts.OwnerAvatarStyleList
import riffet.contracts.OwnerInfo

// RiffetApi endpoints — the owner's personal info (个人资料, docs/OWNER.md). Transport and auth rules: see RiffetApi.kt.

@Throws(Exception::class)
suspend fun RiffetApi.owner(): OwnerInfo = get("/api/owner").decode()

/** An empty [name] clears it. */
@Throws(Exception::class)
suspend fun RiffetApi.updateOwnerName(name: String): OwnerInfo =
    patch("/api/owner", buildJsonObject { put("name", if (name.isBlank()) JsonNull else JsonPrimitive(name.trim())) }).decode()

/** [bytes] already cropped square and scaled to `OWNER_AVATAR_SIDE`; [type] is image/png, image/jpeg or image/webp. */
@Throws(Exception::class)
suspend fun RiffetApi.uploadOwnerAvatar(bytes: ByteArray, type: String): OwnerInfo =
    put("/api/owner/avatar", buildJsonObject { put("type", type); put("data", Base64.encode(bytes)) }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.removeOwnerAvatar(): OwnerInfo = delete("/api/owner/avatar").decode()

/** An entry of [OwnerInfo.history] becomes the avatar again; the current one moves into history. */
@Throws(Exception::class)
suspend fun RiffetApi.restoreOwnerAvatar(sha256: String): OwnerInfo =
    post("/api/owner/avatar/restore", buildJsonObject { put("sha256", sha256) }).decode()

/** Drops one entry of [OwnerInfo.history]; one already gone succeeds. */
@Throws(Exception::class)
suspend fun RiffetApi.deleteOwnerAvatarHistory(sha256: String): OwnerInfo = delete("/api/owner/avatar/history/${sha256.enc()}").decode()

/** An avatar's absolute URL, current or from history. */
fun RiffetApi.ownerAvatarUrl(avatar: riffet.contracts.OwnerAvatar): String = "$baseUrl${avatar.url}"

/** The avatar's absolute URL on this server, for an image loader that sends the same credentials. */
fun RiffetApi.ownerAvatarUrl(owner: OwnerInfo): String? = owner.avatar?.let { "$baseUrl${it.url}" }

/** The generated avatar styles the enabled plugins offer. */
@Throws(Exception::class)
suspend fun RiffetApi.ownerAvatarStyles(): List<OwnerAvatarStyle> = get("/api/owner/avatar-styles").decode<OwnerAvatarStyleList>().styles

/** [ink] and [paper] are `#rrggbb` from the current theme; null uses the server's neutral pair. */
@Throws(Exception::class)
suspend fun RiffetApi.generateOwnerAvatar(style: String, seed: String, ink: String? = null, paper: String? = null): OwnerInfo =
    post("/api/owner/avatar/generate", buildJsonObject {
        put("style", style); put("seed", seed)
        if (ink != null) put("ink", ink)
        if (paper != null) put("paper", paper)
    }).decode()

/** A style's preview PNG, for an image loader that sends the same credentials. The same arguments give the same picture. */
fun RiffetApi.ownerAvatarPreviewUrl(style: String, seed: String, ink: String? = null, paper: String? = null): String {
    val query = buildList {
        add("seed=${seed.enc()}")
        if (ink != null) add("ink=${ink.enc()}")
        if (paper != null) add("paper=${paper.enc()}")
    }.joinToString("&")
    return "$baseUrl/api/owner/avatar-styles/${style.split('/').joinToString("/") { it.enc() }}/preview?$query"
}
