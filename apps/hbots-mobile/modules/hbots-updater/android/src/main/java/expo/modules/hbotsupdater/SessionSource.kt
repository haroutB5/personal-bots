package expo.modules.hbotsupdater

import android.content.Context
import android.util.Base64
import android.util.Log
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

data class NativeSession(val httpBaseUrl: String, val accessToken: String) {
  companion object {
    fun parse(json: String): NativeSession? {
      val session = runCatching { JSONObject(json) }.getOrNull() ?: return null
      val base = session.optString("httpBaseUrl").trimEnd('/')
      if (!base.startsWith("https://")) return null
      val token = session.optString("accessToken")
      if (token.isBlank()) return null
      return NativeSession(base, token)
    }
  }
}

/**
 * Reads the session expo-secure-store wrote, through the same Android Keystore
 * key. The token stays in memory for one check and is never copied into the
 * updater prefs, WorkManager or a log.
 */
object SessionSource {
  private const val TAG = "HbotsUpdate"
  private const val PREFS = "SecureStore"
  private const val KEY = "key_v1-hbots.session.v1"
  private const val KEYSTORE = "AndroidKeyStore"
  private const val AES = "AES/GCM/NoPadding"

  fun read(context: Context): NativeSession? = runCatching {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
      ?: return null
    val item = JSONObject(raw)
    if (item.optString("scheme") != "aes") return null
    val keychain = item.optString("keystoreAlias", "key_v1")
    val alias = if (item.optBoolean("usesKeystoreSuffix", false)) {
      "AES:$keychain:keystoreUnauthenticated"
    } else {
      "AES:$keychain"
    }
    val entry = KeyStore.getInstance(KEYSTORE).apply { load(null) }
      .getEntry(alias, null) as? KeyStore.SecretKeyEntry ?: return null
    val tagLength = item.getInt("tlen")
    if (tagLength < 96) return null
    val cipher = Cipher.getInstance(AES)
    val iv = Base64.decode(item.getString("iv"), Base64.DEFAULT)
    cipher.init(Cipher.DECRYPT_MODE, entry.secretKey, GCMParameterSpec(tagLength, iv))
    val plaintext = cipher.doFinal(Base64.decode(item.getString("ct"), Base64.DEFAULT))
    NativeSession.parse(String(plaintext, StandardCharsets.UTF_8))
  }.onFailure {
    Log.w(TAG, "session read failed ${it.javaClass.simpleName}")
  }.getOrNull()
}
