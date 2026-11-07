package expo.modules.hbotsupdater

import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DpopProofTest {
  private val encoder = java.util.Base64.getUrlEncoder().withoutPadding()
  private val decoder = java.util.Base64.getUrlDecoder()

  @Test
  fun `proof carries the request and verifies with its public jwk`() {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
    val public = pair.public as ECPublicKey
    val jwk = JSONObject()
      .put("kty", "EC")
      .put("crv", "P-256")
      .put("x", fixed32(public.w.affineX))
      .put("y", fixed32(public.w.affineY))

    val proof = DpopProof.create(
      DpopKey(pair.private, jwk),
      "GET",
      "https://relay.example.test/api/personal/android/apk/1.66.117?x=1#fragment",
      "access-token",
      1_700_000_000,
    )
    assertNotNull(proof)
    val parts = proof!!.split(".")
    val header = decode(parts[0])
    val payload = JSONObject(decode(parts[1]))
    assertEquals("dpop+jwt", JSONObject(header).getString("typ"))
    assertEquals("GET", payload.getString("htm"))
    assertEquals(
      "https://relay.example.test/api/personal/android/apk/1.66.117",
      payload.getString("htu"),
    )
    assertEquals(1_700_000_000, payload.getInt("iat"))
    assertEquals(
      encoder.encodeToString(
        java.security.MessageDigest.getInstance("SHA-256")
          .digest("access-token".toByteArray(StandardCharsets.US_ASCII)),
      ),
      payload.getString("ath"),
    )

    val verifier = Signature.getInstance("SHA256withECDSA")
    verifier.initVerify(pair.public)
    verifier.update("${parts[0]}.${parts[1]}".toByteArray(StandardCharsets.US_ASCII))
    assertTrue(verifier.verify(rawToDer(decoder.decode(parts[2]))))
  }

  private fun fixed32(value: BigInteger): String {
    val bytes = value.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
    val padded = ByteArray(32)
    bytes.copyInto(padded, 32 - bytes.size)
    return encoder.encodeToString(padded)
  }

  private fun decode(value: String): String = String(decoder.decode(value), StandardCharsets.UTF_8)

  private fun rawToDer(raw: ByteArray): ByteArray {
    fun integer(bytes: ByteArray): ByteArray {
      val trimmed = bytes.dropWhile { it == 0.toByte() }.toByteArray().let {
        if (it.isNotEmpty() && it[0].toInt() and 0x80 != 0) byteArrayOf(0) + it else it
      }
      return byteArrayOf(0x02, trimmed.size.toByte()) + trimmed
    }

    val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
    return byteArrayOf(0x30, body.size.toByte()) + body
  }
}
