package expo.modules.hbotssecure

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Files at rest for the offline cache: `v1 | iv | ciphertext`, AES-256-GCM
 * under a Keystore key that never leaves the device. Anything that does not
 * parse, including a file from before encryption, is deleted by the caller.
 */
object CacheCrypto {
  private const val PROVIDER = "AndroidKeyStore"
  private const val ALIAS = "hbots-cache-v1"
  private const val TRANSFORM = "AES/GCM/NoPadding"
  private val MAGIC = byteArrayOf('v'.code.toByte(), '1'.code.toByte())
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  @Synchronized
  private fun key(): SecretKey {
    val store = keyStore()
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
    generator.init(
      KeyGenParameterSpec.Builder(
          ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return generator.generateKey()
  }

  @Synchronized
  fun deleteKey() {
    val store = keyStore()
    if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
  }

  /** Writes to a sibling file and renames, so a crash never leaves half a file. */
  private fun atomically(target: File, write: (OutputStream) -> Unit) {
    target.parentFile?.mkdirs()
    val partial = File(target.parentFile, target.name + ".part")
    try {
      partial.outputStream().use { write(it) }
      if (!partial.renameTo(target)) {
        target.delete()
        if (!partial.renameTo(target)) throw java.io.IOException("rename failed")
      }
    } finally {
      if (partial.exists()) partial.delete()
    }
  }

  private fun encryptInto(plain: InputStream, out: OutputStream) {
    // The Keystore picks a fresh random 12 byte IV for every file; it refuses a caller-supplied one.
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    check(cipher.iv.size == IV_BYTES) { "unexpected IV size" }
    out.write(MAGIC)
    out.write(cipher.iv)
    CipherOutputStream(out, cipher).use { plain.copyTo(it) }
  }

  private fun decryptFrom(input: InputStream): InputStream {
    val magic = ByteArray(MAGIC.size)
    val iv = ByteArray(IV_BYTES)
    if (readFully(input, magic) != magic.size || !magic.contentEquals(MAGIC)) {
      throw java.io.IOException("not v1")
    }
    if (readFully(input, iv) != iv.size) throw java.io.IOException("short iv")
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
    return CipherInputStream(input, cipher)
  }

  private fun readFully(input: InputStream, into: ByteArray): Int {
    var read = 0
    while (read < into.size) {
      val n = input.read(into, read, into.size - read)
      if (n < 0) break
      read += n
    }
    return read
  }

  fun writeText(path: String, text: String) {
    atomically(File(path)) { out -> encryptInto(text.toByteArray(Charsets.UTF_8).inputStream(), out) }
  }

  /** The text, or null after deleting a file that cannot be read back. */
  fun readText(path: String): String? {
    val file = File(path)
    if (!file.exists()) return null
    return try {
      file.inputStream().use { raw ->
        val buffer = ByteArrayOutputStream()
        decryptFrom(raw).use { it.copyTo(buffer) }
        buffer.toString(Charsets.UTF_8.name())
      }
    } catch (_: Exception) {
      file.delete()
      null
    }
  }

  fun encryptFile(source: InputStream, destination: String) {
    atomically(File(destination)) { out -> source.use { encryptInto(it, out) } }
  }

  /** True when `destination` now holds the plaintext. A file that cannot be read is deleted. */
  fun decryptFile(source: String, destination: String): Boolean {
    val file = File(source)
    if (!file.exists()) return false
    return try {
      file.inputStream().use { raw ->
        atomically(File(destination)) { out -> decryptFrom(raw).use { it.copyTo(out) } }
      }
      true
    } catch (_: Exception) {
      file.delete()
      File(destination).delete()
      false
    }
  }
}
