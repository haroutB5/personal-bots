package expo.modules.hbotsupdater

import android.content.Context
import java.math.BigInteger
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECParameterSpec
import java.util.UUID
import org.json.JSONObject

data class DpopKey(
  val privateKey: java.security.PrivateKey,
  val publicJwk: JSONObject,
)

object DpopKeySource {
  private const val KEY = "hbots.dpop-key.v1"

  fun read(context: Context, secureStore: String? = SecureStoreSource.readString(context, KEY)): DpopKey? =
    runCatching {
      val raw = secureStore ?: return null
      val json = JSONObject(raw)
      val x = json.optString("x")
      val y = json.optString("y")
      val d = json.optString("d")
      if (x.isBlank() || y.isBlank() || d.isBlank()) return null
      val params = java.security.AlgorithmParameters.getInstance("EC").apply {
        init(ECGenParameterSpec("secp256r1"))
      }.getParameterSpec(ECParameterSpec::class.java)
      val privateKey = KeyFactory.getInstance("EC").generatePrivate(
        ECPrivateKeySpec(BigInteger(1, DpopProof.base64Url(d)), params),
      )
      DpopKey(
        privateKey,
        JSONObject()
          .put("kty", "EC")
          .put("crv", "P-256")
          .put("x", x)
          .put("y", y),
      )
    }.getOrNull()
}

object DpopProof {
  private val encoder = java.util.Base64.getUrlEncoder().withoutPadding()
  private val decoder = java.util.Base64.getUrlDecoder()

  fun create(key: DpopKey, method: String, url: String, accessToken: String, nowSeconds: Long = System.currentTimeMillis() / 1000): String? =
    runCatching {
      val header = base64Url(
        JSONObject()
          .put("typ", "dpop+jwt")
          .put("alg", "ES256")
          .put("jwk", key.publicJwk)
          .toString()
          .toByteArray(StandardCharsets.US_ASCII),
      )
      val payload = base64Url(
        JSONObject()
          .put("htm", method.uppercase())
          .put("htu", normalizeHtu(url) ?: return null)
          .put("jti", UUID.randomUUID().toString())
          .put("iat", nowSeconds)
          .put("ath", base64Url(sha256(accessToken.toByteArray(StandardCharsets.US_ASCII))))
          .toString()
          .toByteArray(StandardCharsets.US_ASCII),
      )
      val signingInput = "$header.$payload".toByteArray(StandardCharsets.US_ASCII)
      val signer = Signature.getInstance("SHA256withECDSA")
      signer.initSign(key.privateKey)
      signer.update(signingInput)
      val raw = derToRawJose(signer.sign()) ?: return null
      "$header.$payload.${base64Url(raw)}"
    }.getOrNull()

  internal fun normalizeHtu(url: String): String? = runCatching {
    val uri = URI(url)
    val scheme = uri.scheme ?: return null
    val authority = uri.rawAuthority ?: return null
    val path = uri.rawPath?.ifEmpty { "/" } ?: "/"
    "$scheme://$authority$path"
  }.getOrNull()

  internal fun derToRawJose(der: ByteArray): ByteArray? = runCatching {
    if (der.size < 8 || der[0] != 0x30.toByte()) return null
    var offset = 2
    if (der[1].toInt() and 0x80 != 0) {
      offset += der[1].toInt() and 0x7f
    }
    if (der[offset] != 0x02.toByte()) return null
    val rLength = der[offset + 1].toInt()
    val r = der.copyOfRange(offset + 2, offset + 2 + rLength)
    offset += 2 + rLength
    if (der[offset] != 0x02.toByte()) return null
    val sLength = der[offset + 1].toInt()
    val s = der.copyOfRange(offset + 2, offset + 2 + sLength)
    val raw = ByteArray(64)
    copyPadded(r, raw, 0)
    copyPadded(s, raw, 32)
    raw
  }.getOrNull()

  private fun copyPadded(value: ByteArray, target: ByteArray, at: Int) {
    val trimmed = value.dropWhile { it == 0.toByte() }.toByteArray()
    if (trimmed.size > 32) return
    trimmed.copyInto(target, at + 32 - trimmed.size)
  }

  internal fun sha256(bytes: ByteArray): ByteArray =
    java.security.MessageDigest.getInstance("SHA-256").digest(bytes)

  internal fun base64Url(bytes: ByteArray): String = encoder.encodeToString(bytes)

  internal fun base64Url(value: String): ByteArray = decoder.decode(value)
}
