package expo.modules.hbotsupdater

import android.content.Context
import android.util.Base64
import android.util.Log
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

data class NativeSession(
  val httpBaseUrl: String,
  val accessToken: String,
  /** "dpop" when the token is bound to this phone's key and needs a proof on every request. */
  val authMethod: String = "bearer",
  /** Epoch milliseconds, or null when the stored session does not say. */
  val expiresAt: Long? = null,
) {
  companion object {
    fun parse(json: String): NativeSession? {
      val session = runCatching { JSONObject(json) }.getOrNull() ?: return null
      val base = session.optString("httpBaseUrl").trimEnd('/')
      if (!base.startsWith("https://")) return null
      val token = session.optString("accessToken")
      if (token.isBlank()) return null
      val method = if (session.optString("authMethod") == "dpop") "dpop" else "bearer"
      val expiresAt = session.optLong("expiresAt", 0L).takeIf { it > 0L }
      return NativeSession(base, token, method, expiresAt)
    }
  }
}

/**
 * Reads the session expo-secure-store wrote, through the same Android Keystore
 * key. The token stays in memory for one check and is never copied into the
 * updater prefs, WorkManager or a log.
 */
object SecureStoreSource {
  private const val PREFS = "SecureStore"
  private const val KEYSTORE = "AndroidKeyStore"
  private const val AES = "AES/GCM/NoPadding"

  fun readString(context: Context, storageKey: String): String? = runCatching {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString("key_v1-$storageKey", null) ?: return null
    val item = JSONObject(raw)
    if (item.optString("scheme") != "aes") return null
    val keychain = item.optString("keystoreAlias", "key_v1")
    val alias = keystoreAlias(keychain, item.optBoolean("usesKeystoreSuffix", false))
    val entry = KeyStore.getInstance(KEYSTORE).apply { load(null) }
      .getEntry(alias, null) as? KeyStore.SecretKeyEntry ?: return null
    val tagLength = item.getInt("tlen")
    if (tagLength < 96) return null
    val cipher = Cipher.getInstance(AES)
    val iv = Base64.decode(item.getString("iv"), Base64.DEFAULT)
    cipher.init(Cipher.DECRYPT_MODE, entry.secretKey, GCMParameterSpec(tagLength, iv))
    val plaintext = cipher.doFinal(Base64.decode(item.getString("ct"), Base64.DEFAULT))
    String(plaintext, StandardCharsets.UTF_8)
  }.getOrNull()

  /** Mirrors expo-secure-store 57 AESEncryptor: `AES/<mode>/<padding>:<keychain>:<suffix>`. */
  internal fun keystoreAlias(keychain: String, usesSuffix: Boolean): String =
    if (usesSuffix) "$AES:$keychain:keystoreUnauthenticated" else "$AES:$keychain"
}

object SessionSource {
  private const val TAG = "HbotsUpdate"
  private const val KEY = "hbots.session.v1"

  fun read(context: Context): NativeSession? = runCatching {
    val raw = SecureStoreSource.readString(context, KEY) ?: return null
    NativeSession.parse(raw)
  }.onFailure {
    Log.w(TAG, "session read failed ${it.javaClass.simpleName}")
  }.getOrNull()
}
