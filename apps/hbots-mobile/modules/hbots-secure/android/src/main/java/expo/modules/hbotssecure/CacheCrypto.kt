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
 * The most text a cache file may hold, in UTF-8 bytes. Mirrors `MAX_CACHED_THREAD_BYTES` in
 * nativeCache.ts. A bigger file is never decrypted: it is deleted and read as "no cache".
 */
const val MAX_CACHED_TEXT_BYTES = 1_048_576

/** Where the AES key lives. The phone uses the Keystore; a JVM test passes an in-memory key. */
interface CacheKeys {
  fun key(): SecretKey

  fun delete()
}

/** The Keystore key that never leaves the device. */
object KeystoreCacheKeys : CacheKeys {
  private const val PROVIDER = "AndroidKeyStore"
  private const val ALIAS = "hbots-cache-v1"

  private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  @Synchronized
  override fun key(): SecretKey {
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
  override fun delete() {
    val store = keyStore()
    if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
  }
}

/**
 * Files at rest for the offline cache: `v1 | iv | ciphertext`, AES-256-GCM
 * under a key from [CacheKeys]. Anything that does not parse, including a
 * file from before encryption, is deleted by the caller.
 */
class FileCrypto(private val keys: CacheKeys) {
  private companion object {
    const val TRANSFORM = "AES/GCM/NoPadding"
    val MAGIC = byteArrayOf('v'.code.toByte(), '1'.code.toByte())
    const val IV_BYTES = 12
    const val TAG_BITS = 128
  }

  fun deleteKey() = keys.delete()

  /**
   * One-time migration for files written before encryption existed: deletes every
   * file under [root] that does not start with the v1 header (and every leftover
   * partial write). Returns how many files it removed. A readable v1 file stays.
   */
  fun purgeUnencrypted(root: File): Int {
    if (!root.exists()) return 0
    var removed = 0
    root.walkBottomUp().forEach { entry ->
      if (entry.isFile && (entry.name.endsWith(".part") || !hasHeader(entry))) {
        if (entry.delete()) removed += 1
      }
    }
    return removed
  }

  private fun hasHeader(file: File): Boolean =
    try {
      file.inputStream().use { raw ->
        val head = ByteArray(MAGIC.size)
        readFully(raw, head) == head.size && head.contentEquals(MAGIC)
      }
    } catch (_: Exception) {
      false
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
    // The key store picks a fresh random 12 byte IV for every file; it refuses a caller-supplied one.
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, keys.key())
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
    cipher.init(Cipher.DECRYPT_MODE, keys.key(), GCMParameterSpec(TAG_BITS, iv))
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

/** The app's cache files, encrypted under the Keystore key. */
object CacheCrypto {
  private val files = FileCrypto(KeystoreCacheKeys)

  fun deleteKey() = files.deleteKey()

  fun purgeUnencrypted(root: File): Int = files.purgeUnencrypted(root)

  fun writeText(path: String, text: String) = files.writeText(path, text)

  fun readText(path: String): String? = files.readText(path)

  fun encryptFile(source: InputStream, destination: String) = files.encryptFile(source, destination)

  fun decryptFile(source: String, destination: String): Boolean = files.decryptFile(source, destination)
}
