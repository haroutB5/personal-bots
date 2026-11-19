package expo.modules.hbotsgoogleauth

import java.security.MessageDigest

/** `AA:BB:..` in upper case, the form Google's Android client page and `keytool` both print. */
fun fingerprint(certificate: ByteArray, algorithm: String): String =
  MessageDigest.getInstance(algorithm)
    .digest(certificate)
    .joinToString(":") { "%02X".format(it) }

fun signingIdentityMap(packageName: String, certificate: ByteArray): Map<String, Any?> =
  mapOf(
    "packageName" to packageName,
    "sha1" to fingerprint(certificate, "SHA-1"),
    "sha256" to fingerprint(certificate, "SHA-256"),
  )
