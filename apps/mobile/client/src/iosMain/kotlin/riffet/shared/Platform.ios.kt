@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package riffet.shared

import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.value
import kotlinx.coroutines.suspendCancellableCoroutine
import platform.CoreFoundation.*
import platform.LocalAuthentication.LAContext
import platform.LocalAuthentication.LAPolicyDeviceOwnerAuthentication
import platform.Security.*
import platform.UIKit.UIDevice
import kotlin.coroutines.resume

/** Legacy credentials and the paired-service snapshot use the same Keychain item. */
internal class IosKeychainTokenStore(private val service: String = "io.github.riffable.iphone.credentials") : DeviceTokenStore {
    private data class Credential(val token: String? = null, val origin: String? = null, val server: String? = null)

    private fun read(): Credential {
        val raw = keychainRead(service) ?: return Credential()
        val json = runCatching { riffet.contracts.RiffetJson.instance.parseToJsonElement(raw) as? kotlinx.serialization.json.JsonObject }.getOrNull()
            ?: return Credential()
        fun field(name: String) = (json[name] as? kotlinx.serialization.json.JsonPrimitive)?.content
        return Credential(field("token"), field("origin"), field("server"))
    }

    private fun write(value: Credential) {
        val json = kotlinx.serialization.json.buildJsonObject {
            value.token?.let { put("token", kotlinx.serialization.json.JsonPrimitive(it)) }
            value.origin?.let { put("origin", kotlinx.serialization.json.JsonPrimitive(it)) }
            value.server?.let { put("server", kotlinx.serialization.json.JsonPrimitive(it)) }
        }.toString()
        keychainWrite(service, json)
    }

    override suspend fun loadPairings(): String? {
        val raw = keychainRead(service) ?: return null
        val json = runCatching {
            riffet.contracts.RiffetJson.instance.parseToJsonElement(raw) as? kotlinx.serialization.json.JsonObject
        }.getOrNull() ?: throw IllegalStateException("无法读取配对记录")
        // Even an incomplete snapshot belongs to the shared decoder; it must never trigger migration.
        if (json.keys.any { it == "version" || it == "servers" || it == "activeOrigin" }) return raw
        val legacy = json.isNotEmpty() && json.all { (key, value) ->
            (key == "token" || key == "origin" || key == "server") &&
                (value as? kotlinx.serialization.json.JsonPrimitive)?.isString == true
        }
        // Legacy clear() deleted the item. An empty object is not a known legacy credential.
        check(legacy) { "无法读取配对记录" }
        return null
    }

    override suspend fun savePairings(value: String) = keychainWrite(service, value)

    override suspend fun load(): String? = read().token
    override suspend fun loadOrigin(): String? = read().origin
    override suspend fun loadServer(): String? = read().server
    override suspend fun save(token: String, origin: String) = write(read().copy(token = token, origin = origin))
    override suspend fun saveServer(baseUrl: String) = write(read().copy(server = baseUrl))
    override suspend fun clear() = keychainWrite(service, null)
}

/** Security receives real CF containers and values; no Kotlin collection or number boxes cross it. */
private inline fun <T> withDictionary(action: (CFMutableDictionaryRef) -> T): T {
    val dictionary = CFDictionaryCreateMutable(null, 0, kCFTypeDictionaryKeyCallBacks.ptr, kCFTypeDictionaryValueCallBacks.ptr)
        ?: error("Could not allocate Keychain query")
    try { return action(dictionary) } finally { CFRelease(dictionary) }
}

private inline fun <T> withKeychainQuery(service: String, action: (CFMutableDictionaryRef) -> T): T =
    withDictionary { query ->
        val serviceName = CFStringCreateWithCString(null, service, kCFStringEncodingUTF8) ?: error("Invalid Keychain service")
        try {
            val account = CFStringCreateWithCString(null, "paired-server", kCFStringEncodingUTF8) ?: error("Invalid Keychain account")
            try {
                CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword)
                CFDictionarySetValue(query, kSecAttrService, serviceName)
                CFDictionarySetValue(query, kSecAttrAccount, account)
                action(query)
            } finally { CFRelease(account) }
        } finally { CFRelease(serviceName) }
    }

private fun keychainRead(service: String): String? = memScoped {
    val result = alloc<CFTypeRefVar>()
    result.value = null
    val status = withKeychainQuery(service) { query ->
        CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue)
        CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne)
        SecItemCopyMatching(query, result.ptr)
    }
    if (status == errSecItemNotFound) return@memScoped null
    check(status == errSecSuccess) { "Keychain read failed ($status)" }
    val data = result.value ?: error("Keychain returned no credential data")
    try {
        check(CFGetTypeID(data) == CFDataGetTypeID()) { "Keychain returned an unexpected data type" }
        val count = CFDataGetLength(data.reinterpret())
        check(count in 0..Int.MAX_VALUE.toLong()) { "Invalid Keychain data size" }
        if (count == 0L) return@memScoped ""
        val bytes = CFDataGetBytePtr(data.reinterpret()) ?: error("Keychain returned empty bytes")
        bytes.reinterpret<ByteVar>().readBytes(count.toInt()).decodeToString()
    } finally { CFRelease(data) }
}

private fun keychainWrite(service: String, value: String?) {
    withKeychainQuery(service) { query ->
        if (value == null) {
            val status = SecItemDelete(query)
            check(status == errSecSuccess || status == errSecItemNotFound) { "Keychain delete failed ($status)" }
        } else {
            val bytes = value.encodeToByteArray()
            val data = bytes.usePinned { pinned ->
                CFDataCreate(null, if (bytes.isEmpty()) null else pinned.addressOf(0).reinterpret(), bytes.size.toLong())
            } ?: error("Could not encode Keychain credential")
            try {
                val status = withDictionary { attributes ->
                    CFDictionarySetValue(attributes, kSecValueData, data)
                    CFDictionarySetValue(attributes, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
                    SecItemUpdate(query, attributes)
                }
                if (status == errSecItemNotFound) {
                    CFDictionarySetValue(query, kSecValueData, data)
                    CFDictionarySetValue(query, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
                    val added = SecItemAdd(query, null)
                    check(added == errSecSuccess) { "Keychain write failed ($added)" }
                } else check(status == errSecSuccess) { "Keychain update failed ($status)" }
            } finally { CFRelease(data) }
        }
    }
}

private class IosDeviceInfo : DeviceInfo {
    override val deviceName: String get() = UIDevice.currentDevice.name
}

/** Device-owner policy allows a passcode fallback; a cancellation or unavailable lock always fails. */
private class IosBiometricGate : BiometricGate {
    override suspend fun authenticate(reason: String): Boolean = suspendCancellableCoroutine { continuation ->
        val context = LAContext()
        if (!context.canEvaluatePolicy(LAPolicyDeviceOwnerAuthentication, error = null)) {
            continuation.resume(false)
        } else {
            continuation.invokeOnCancellation { context.invalidate() }
            context.evaluatePolicy(LAPolicyDeviceOwnerAuthentication, localizedReason = reason) { success, _ ->
                if (continuation.isActive) continuation.resume(success)
            }
        }
    }
}

actual fun createDeviceTokenStore(): DeviceTokenStore = IosKeychainTokenStore()
actual fun createDeviceInfo(): DeviceInfo = IosDeviceInfo()
actual fun createBiometricGate(): BiometricGate = IosBiometricGate()
