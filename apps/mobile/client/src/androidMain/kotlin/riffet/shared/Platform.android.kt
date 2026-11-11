package riffet.shared

import android.annotation.TargetApi
import android.app.Activity
import android.content.Context
import android.content.DialogInterface
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume

/**
 * The Android side of the platform seams.
 *
 * The application context is captured once from `Application.onCreate`, which is the only lifetime
 * long enough to outlive an Activity recreation. The current Activity is tracked separately for
 * [BiometricGate], which must attach to a foreground Activity, and is cleared when it stops so a
 * finished Activity is not leaked.
 */
object RiffetAndroid {
    private var appContext: Context? = null
    private var contextForLanguage: (Context) -> Context = { it }
    private var foregroundActivity: Activity? = null

    fun initialize(context: Context, localize: (Context) -> Context = { it }) {
        appContext = context.applicationContext
        contextForLanguage = localize
    }

    fun attachActivity(activity: Activity?) {
        foregroundActivity = activity
    }

    fun requireContext(): Context = contextForLanguage(appContext
        ?: error("Call RiffetAndroid.initialize(application) from Application.onCreate first."))

    fun currentActivity(): Activity? = foregroundActivity
}

/** Also named in `androidApp`'s backup and data-extraction rules, which exclude this file. */
private const val TOKEN_PREFS = "riffet.device"

/** Where builds before the Keystore seal kept the token in the clear; read once, then removed. */
private const val PLAIN_TOKEN_KEY = "device-token"
private const val SEALED_TOKEN_KEY = "device-token-sealed"
private const val ORIGIN_KEY = "token-origin"
private const val SERVER_KEY = "server-url"
private const val PAIRINGS_KEY = "paired-services-sealed"

/**
 * Persists the device token, its origin and its server in a `SharedPreferences` file, with the token
 * sealed by [TokenCipher]: the file on its own — a copied data directory, a backup — does not reveal
 * it. A plaintext token left by an older build is sealed the first time it is read.
 */
private class AndroidDeviceTokenStore(private val context: Context) : DeviceTokenStore {
    private val preferences get() = context.getSharedPreferences(TOKEN_PREFS, Context.MODE_PRIVATE)

    override suspend fun loadPairings(): String? = withContext(Dispatchers.IO) {
        val sealed = preferences.getString(PAIRINGS_KEY, null) ?: return@withContext null
        // A missing Keystore key cannot recover a credential. Keep the original ciphertext until
        // an explicit successful pairing replaces it; a read must not migrate it to an empty file.
        TokenCipher.open(sealed) ?: PairedServices().encoded()
    }

    override suspend fun savePairings(value: String) = withContext(Dispatchers.IO) {
        // Pairing snapshots contain every service's token. Never fall back to plaintext or
        // remove the legacy credential until the sealed snapshot is durably written.
        val sealed = TokenCipher.seal(value)
        val stored = preferences
        val previous = listOf(PAIRINGS_KEY, PLAIN_TOKEN_KEY, SEALED_TOKEN_KEY, ORIGIN_KEY, SERVER_KEY)
            .associateWith { key -> stored.getString(key, null) }
        try {
            check(
                stored.edit()
                    .putString(PAIRINGS_KEY, sealed)
                    .remove(PLAIN_TOKEN_KEY)
                    .remove(SEALED_TOKEN_KEY)
                    .remove(ORIGIN_KEY)
                    .remove(SERVER_KEY)
                    .commit(),
            ) { "无法保存配对服务器" }
        } catch (failure: Exception) {
            // commit updates SharedPreferences' in-memory map before reporting a disk failure.
            // Restore every touched key so reads cannot adopt a snapshot the caller rejected.
            val rollback = stored.edit()
            previous.forEach { (key, value) ->
                if (value == null) rollback.remove(key) else rollback.putString(key, value)
            }
            try {
                // Even if this disk write also returns false, commit restores the memory map.
                rollback.commit()
            } catch (rollbackFailure: Exception) {
                failure.addSuppressed(rollbackFailure)
            }
            throw failure
        }
    }

    override suspend fun load(): String? = withContext(Dispatchers.IO) {
        val stored = preferences
        stored.getString(SEALED_TOKEN_KEY, null)?.let { sealed -> return@withContext TokenCipher.open(sealed) }
        val plain = stored.getString(PLAIN_TOKEN_KEY, null) ?: return@withContext null
        try {
            stored.edit().putString(SEALED_TOKEN_KEY, TokenCipher.seal(plain)).remove(PLAIN_TOKEN_KEY).apply()
        } catch (failure: Exception) {
            // Kept in the clear rather than lost; the next read tries to seal it again.
            AppLog.log("auth", "token seal failed ${failure::class.simpleName}")
        }
        plain
    }

    override suspend fun loadOrigin(): String? = preferences.getString(ORIGIN_KEY, null)

    override suspend fun save(token: String, origin: String) {
        val sealed = withContext(Dispatchers.IO) {
            try {
                TokenCipher.seal(token)
            } catch (failure: Exception) {
                AppLog.log("auth", "token seal failed ${failure::class.simpleName}")
                null
            }
        }
        val edit = preferences.edit().putString(ORIGIN_KEY, origin)
        // A Keystore that cannot seal must not make pairing impossible: the token is kept in the
        // clear, as an older build would have left it, and [load] tries to seal it again.
        if (sealed != null) edit.putString(SEALED_TOKEN_KEY, sealed).remove(PLAIN_TOKEN_KEY)
        else edit.putString(PLAIN_TOKEN_KEY, token).remove(SEALED_TOKEN_KEY)
        edit.apply()
    }

    override suspend fun clear() {
        // Forgetting the device drops the server with it: a base URL without a credential is an
        // unpaired device, and keeping it would only make the next launch show a dead connection.
        preferences.edit()
            .remove(PAIRINGS_KEY)
            .remove(PLAIN_TOKEN_KEY)
            .remove(SEALED_TOKEN_KEY)
            .remove(ORIGIN_KEY)
            .remove(SERVER_KEY)
            .apply()
    }

    override suspend fun loadServer(): String? = preferences.getString(SERVER_KEY, null)

    override suspend fun saveServer(baseUrl: String) {
        preferences.edit().putString(SERVER_KEY, baseUrl).apply()
    }
}

/**
 * AES-256-GCM under a key generated inside the Android Keystore, which never hands the key material
 * out. A sealed value is `base64(iv ‖ ciphertext ‖ tag)`.
 */
private object TokenCipher {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "riffet.device-token"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    /**
     * The last value sealed or opened. Every request reads the token, and a Keystore operation is a
     * call into another process; the cache is process-wide because stores are created freely.
     */
    @Volatile
    private var last: Pair<String, String>? = null

    fun seal(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        if (iv.size != IV_BYTES) throw GeneralSecurityException("unexpected GCM IV length ${iv.size}")
        val sealed = Base64.encodeToString(iv + cipher.doFinal(plain.encodeToByteArray()), Base64.NO_WRAP)
        last = sealed to plain
        return sealed
    }

    /**
     * Null when the value can never be opened: it is mangled, or the key that sealed it is gone with
     * the app's credentials. Any other failure is thrown, so a Keystore that is briefly unavailable
     * is not mistaken for an unpaired device.
     */
    fun open(sealed: String): String? {
        last?.let { (known, plain) -> if (known == sealed) return plain }
        return try {
            val bytes = Base64.decode(sealed, Base64.NO_WRAP)
            if (bytes.size <= IV_BYTES) return null
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
            val plain = cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES).decodeToString()
            last = sealed to plain
            plain
        } catch (failure: Exception) {
            AppLog.log("auth", "token open failed ${failure::class.simpleName}")
            when (failure) {
                is IllegalArgumentException, is AEADBadTagException, is KeyPermanentlyInvalidatedException,
                is UnrecoverableKeyException -> null
                else -> throw failure
            }
        }
    }

    /** Synchronized so two first reads cannot each generate a key and seal under the one discarded. */
    @Synchronized
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
}

/** `Build.MANUFACTURER Build.MODEL` is stable across launches and readable in the device list. */
private class AndroidDeviceInfo : DeviceInfo {
    override val deviceName: String =
        listOf(Build.MANUFACTURER, Build.MODEL)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(" ")
            .ifEmpty { "Android device" }
}

/**
 * Framework `BiometricPrompt`. Kept behind an API-28 guard in a separate object because the class
 * does not exist on API 26/27 (minSdk is 26) and loading it would fail there.
 */
private class AndroidBiometricGate : BiometricGate {
    override suspend fun authenticate(reason: String): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        val activity = RiffetAndroid.currentActivity() ?: return false
        return Api28Biometrics.authenticate(activity, reason)
    }
}

@TargetApi(Build.VERSION_CODES.P)
private object Api28Biometrics {
    /**
     * The framework `BiometricPrompt` has **no public constructor and no `PromptInfo`** — verified
     * against `platforms/android-35/android.jar`, where only `Builder` and
     * `authenticate(CancellationSignal, Executor, AuthenticationCallback)` are public. The
     * androidx `PromptInfo`-style API is a different class (`androidx.biometric`), which this module
     * deliberately does not depend on, so the framework shape is used here.
     */
    suspend fun authenticate(activity: Activity, reason: String): Boolean = suspendCancellableCoroutine { continuation ->
        val executor = activity.mainExecutor
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) {
                if (continuation.isActive) continuation.resume(true)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
                if (continuation.isActive) continuation.resume(false)
            }

            // A single mismatched finger is not a final answer; the system dialog stays up.
            override fun onAuthenticationFailed() = Unit
        }
        // The screen-lock PIN, pattern or password is accepted too, as on iPhone. API 30 takes it
        // with any biometric; API 29 has only the older switch; API 28 has biometrics alone and a
        // cancel button, which then counts as a refusal.
        val builder = BiometricPrompt.Builder(activity).setTitle(reason)
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> builder.setAllowedAuthenticators(
                android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK or
                    android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            )
            Build.VERSION.SDK_INT == Build.VERSION_CODES.Q -> {
                @Suppress("DEPRECATION")
                builder.setDeviceCredentialAllowed(true)
            }
            else -> builder.setNegativeButton(RiffetAndroid.requireContext().getString(android.R.string.cancel), executor, DialogInterface.OnClickListener { _, _ ->
                if (continuation.isActive) continuation.resume(false)
            })
        }
        val prompt = builder.build()
        val cancellation = CancellationSignal()
        // There is no `cancelAuthentication()` in the public SDK; the signal is the cancel handle.
        continuation.invokeOnCancellation { cancellation.cancel() }
        prompt.authenticate(cancellation, executor, callback)
    }
}

actual fun createDeviceTokenStore(): DeviceTokenStore = AndroidDeviceTokenStore(RiffetAndroid.requireContext())

actual fun createDeviceInfo(): DeviceInfo = AndroidDeviceInfo()

actual fun createBiometricGate(): BiometricGate = AndroidBiometricGate()
