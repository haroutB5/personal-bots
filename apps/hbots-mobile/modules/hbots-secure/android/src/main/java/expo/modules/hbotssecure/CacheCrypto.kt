package expo.modules.hbotssecure

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The most text a cache file may hold, in UTF-8 bytes. Mirrors `MAX_CACHED_THREAD_BYTES` in
 * nativeCache.ts. A bigger file is never decrypted: it is deleted and read as "no cache".
 */
const val MAX_CACHED_TEXT_BYTES = 2_097_152

/** The wrapped data key, one per cache folder, beside the chat files it opens. */
const val DATA_KEY_FILE = "key.v2"

private const val TRANSFORM = "AES/GCM/NoPadding"
private const val IV_BYTES = 12
private const val TAG_BITS = 128
private val MAGIC_V1 = byteArrayOf('v'.code.toByte(), '1'.code.toByte())
private val MAGIC_V2 = byteArrayOf('v'.code.toByte(), '2'.code.toByte())
private val MAGIC_KEY = byteArrayOf('k'.code.toByte(), '2'.code.toByte())

/** Header (2) + IV + GCM tag: what a file holds beyond its plaintext. */
private const val FILE_OVERHEAD_BYTES = 2 + IV_BYTES + TAG_BITS / 8

private fun readFully(input: InputStream, into: ByteArray): Int {
  var read = 0
  while (read < into.size) {
    val n = input.read(into, read, into.size - read)
    if (n < 0) break
    read += n
  }
  return read
}

private fun startsWith(bytes: ByteArray, magic: ByteArray): Boolean =
  bytes.size >= magic.size && magic.indices.all { bytes[it] == magic[it] }

/**
 * The key that wraps the chat cache's data key and seals attachments. The phone uses the
 * Keystore; a JVM test passes an in-memory key.
 */
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
 * The chat cache's data key: a random AES-256 key, stored in [DATA_KEY_FILE] as
 * `k2 | iv | AES-GCM(key)` under the Keystore key. It is unwrapped once per process and
 * then held in memory, so the Keystore never sees bulk data. The key lives as long as its
 * file: a folder whose key file was deleted gets a new key, and what was written under
 * the old one fails its tag and is deleted on read.
 */
class DataKeys(private val wrapping: CacheKeys) {
  private class Held(val file: File, val key: SecretKey)

  @Volatile private var held: Held? = null
  private val random = SecureRandom()

  /** The key for reading files in [directory], or null when there is none to read with. */
  @Synchronized
  fun forRead(directory: File): SecretKey? {
    val file = File(directory, DATA_KEY_FILE)
    if (!file.exists()) return null
    held?.takeIf { it.file == file }?.let { return it.key }
    val key = unwrap(file)
    if (key == null) {
      file.delete()
      return null
    }
    held = Held(file, key)
    return key
  }

  /** The key for writing in [directory]; makes and stores one when the folder has none it can open. */
  @Synchronized
  fun forWrite(directory: File): SecretKey {
    val file = File(directory, DATA_KEY_FILE)
    if (file.exists()) {
      held?.takeIf { it.file == file }?.let { return it.key }
      unwrap(file)?.let { key ->
        held = Held(file, key)
        return key
      }
    }
    val bytes = ByteArray(32).also(random::nextBytes)
    val key = SecretKeySpec(bytes, "AES")
    val cipher = Cipher.getInstance(TRANSFORM)
    // The key store picks a fresh random IV; it refuses a caller-supplied one.
    cipher.init(Cipher.ENCRYPT_MODE, wrapping.key())
    check(cipher.iv.size == IV_BYTES) { "unexpected IV size" }
    val wrapped = MAGIC_KEY + cipher.iv + cipher.doFinal(bytes)
    bytes.fill(0)
    atomically(file) { it.write(wrapped) }
    held = Held(file, key)
    return key
  }

  /** Drops the in-memory key and the Keystore key that wraps every key file. */
  fun delete() {
    held = null
    wrapping.delete()
  }

  private fun unwrap(file: File): SecretKey? =
    try {
      val raw = file.readBytes()
      if (raw.size <= MAGIC_KEY.size + IV_BYTES || !startsWith(raw, MAGIC_KEY)) {
        null
      } else {
        val iv = raw.copyOfRange(MAGIC_KEY.size, MAGIC_KEY.size + IV_BYTES)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, wrapping.key(), GCMParameterSpec(TAG_BITS, iv))
        val bytes = cipher.doFinal(raw, MAGIC_KEY.size + IV_BYTES, raw.size - MAGIC_KEY.size - IV_BYTES)
        if (bytes.size != 32) null else SecretKeySpec(bytes, "AES").also { bytes.fill(0) }
      }
    } catch (_: Exception) {
      null
    }
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

/**
 * Files at rest for the offline cache. Chat copies are `v2 | iv | ciphertext`, AES-256-GCM
 * under the folder's [DataKeys] key. Attachments stay `v1 | iv | ciphertext` straight under
 * the Keystore key: they are streamed, rarely read, and a queued one must survive the update.
 * A chat copy in any other form, `v1` included, is deleted on read and counts as a miss.
 */
class FileCrypto(private val keys: CacheKeys) {
  private val dataKeys = DataKeys(keys)
  private val random = SecureRandom()

  fun deleteKey() = dataKeys.delete()

  /**
   * One-time migration for files written before encryption existed: deletes every
   * file under [root] that does not start with a v1, v2 or key header (and every leftover
   * partial write). Returns how many files it removed.
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
        val head = ByteArray(2)
        readFully(raw, head) == head.size &&
          (head.contentEquals(MAGIC_V1) || head.contentEquals(MAGIC_V2) || head.contentEquals(MAGIC_KEY))
      }
    } catch (_: Exception) {
      false
    }

  private fun encryptInto(plain: InputStream, out: OutputStream) {
    // The key store picks a fresh random 12 byte IV for every file; it refuses a caller-supplied one.
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, keys.key())
    check(cipher.iv.size == IV_BYTES) { "unexpected IV size" }
    out.write(MAGIC_V1)
    out.write(cipher.iv)
    CipherOutputStream(out, cipher).use { plain.copyTo(it) }
  }

  private fun decryptFrom(input: InputStream): InputStream {
    val magic = ByteArray(MAGIC_V1.size)
    val iv = ByteArray(IV_BYTES)
    if (readFully(input, magic) != magic.size || !magic.contentEquals(MAGIC_V1)) {
      throw java.io.IOException("not v1")
    }
    if (readFully(input, iv) != iv.size) throw java.io.IOException("short iv")
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.DECRYPT_MODE, keys.key(), GCMParameterSpec(TAG_BITS, iv))
    return CipherInputStream(input, cipher)
  }

  fun writeText(path: String, text: String) {
    val target = File(path)
    val key = dataKeys.forWrite(target.absoluteFile.parentFile ?: File("."))
    val iv = ByteArray(IV_BYTES).also(random::nextBytes)
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
    val sealed = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
    atomically(target) { out ->
      out.write(MAGIC_V2)
      out.write(iv)
      out.write(sealed)
    }
  }

  /** The text, or null after deleting a file that cannot be read back. */
  fun readText(path: String): String? {
    val file = File(path)
    if (!file.exists()) return null
    // Decrypting buffers the whole file. A copy over the cap (one saved before the cap existed)
    // is dropped by its size alone: it must never tie up the native thread or the heap.
    if (file.length() > MAX_CACHED_TEXT_BYTES + FILE_OVERHEAD_BYTES) {
      file.delete()
      return null
    }
    return try {
      val raw = file.readBytes()
      val key =
        if (raw.size >= FILE_OVERHEAD_BYTES && startsWith(raw, MAGIC_V2)) {
          dataKeys.forRead(file.absoluteFile.parentFile ?: File("."))
        } else {
          null
        }
      if (key == null) {
        file.delete()
        null
      } else {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, raw, MAGIC_V2.size, IV_BYTES))
        val start = MAGIC_V2.size + IV_BYTES
        String(cipher.doFinal(raw, start, raw.size - start), Charsets.UTF_8)
      }
    } catch (_: Exception) {
      file.delete()
      null
    } catch (_: OutOfMemoryError) {
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

/** The app's cache files: chat copies under the wrapped data key, attachments under the Keystore key. */
object CacheCrypto {
  private val files = FileCrypto(KeystoreCacheKeys)

  fun deleteKey() = files.deleteKey()

  fun purgeUnencrypted(root: File): Int = files.purgeUnencrypted(root)

  fun writeText(path: String, text: String) = files.writeText(path, text)

  fun readText(path: String): String? = files.readText(path)

  fun encryptFile(source: InputStream, destination: String) = files.encryptFile(source, destination)

  fun decryptFile(source: String, destination: String): Boolean = files.decryptFile(source, destination)
}
