package expo.modules.hbotssecure

import java.io.File
import java.nio.file.Files
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The cache file format, run on the JVM with an in-memory AES key in place of the Keystore. */
class CacheCryptoTest {
  private class MemoryKeys(private var current: SecretKey = newKey()) : CacheKeys {
    var deleted = 0
      private set

    override fun key(): SecretKey = current

    override fun delete() {
      deleted += 1
      current = newKey()
    }

    companion object {
      fun newKey(): SecretKey =
        KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    }
  }

  private lateinit var dir: File

  @Before fun makeDirectory() {
    dir = Files.createTempDirectory("cache-crypto").toFile()
  }

  @After fun removeDirectory() {
    dir.deleteRecursively()
  }

  private fun path(name: String) = File(dir, name).path

  @Test fun textSurvivesARoundTripAndIsNotStoredAsPlaintext() {
    val crypto = FileCrypto(MemoryKeys())
    val secret = "a private reply é中"
    crypto.writeText(path("t"), secret)

    assertEquals(secret, crypto.readText(path("t")))
    val raw = File(path("t")).readBytes()
    assertFalse(String(raw, Charsets.ISO_8859_1).contains("private reply"))
    assertEquals('v'.code.toByte(), raw[0])
    assertEquals('1'.code.toByte(), raw[1])
  }

  @Test fun filesRoundTripByteForByte() {
    val crypto = FileCrypto(MemoryKeys())
    val bytes = ByteArray(100_000) { (it * 31).toByte() }
    crypto.encryptFile(bytes.inputStream(), path("blob"))

    assertTrue(crypto.decryptFile(path("blob"), path("plain")))
    assertArrayEquals(bytes, File(path("plain")).readBytes())
  }

  @Test fun everyFileGetsItsOwnIv() {
    val crypto = FileCrypto(MemoryKeys())
    val ivs = (1..20).map { index ->
      crypto.writeText(path("f$index"), "same text")
      File(path("f$index")).readBytes().copyOfRange(2, 14).toList()
    }

    assertEquals(20, ivs.toSet().size)
    // The same text under a different IV is a different file.
    assertNotEquals(File(path("f1")).readBytes().toList(), File(path("f2")).readBytes().toList())
  }

  @Test fun aChangedByteIsDetectedAndTheFileIsDeleted() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.writeText(path("t"), "do not alter me")
    val raw = File(path("t")).readBytes()
    raw[raw.size - 5] = (raw[raw.size - 5].toInt() xor 0x01).toByte()
    File(path("t")).writeBytes(raw)

    assertNull(crypto.readText(path("t")))
    assertFalse(File(path("t")).exists())
  }

  @Test fun aTamperedAttachmentIsRefusedAndNothingIsLeftBehind() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.encryptFile("attachment".toByteArray().inputStream(), path("blob"))
    val raw = File(path("blob")).readBytes()
    raw[raw.size - 1] = (raw[raw.size - 1].toInt() xor 0x80).toByte()
    File(path("blob")).writeBytes(raw)

    assertFalse(crypto.decryptFile(path("blob"), path("plain")))
    assertFalse(File(path("plain")).exists())
    assertFalse(File(path("blob")).exists())
  }

  @Test fun aTruncatedFileIsRefused() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.writeText(path("t"), "a longer text so the tag is cut")
    val raw = File(path("t")).readBytes()
    File(path("t")).writeBytes(raw.copyOf(raw.size - 8))

    assertNull(crypto.readText(path("t")))
  }

  @Test fun theWrongKeyCannotReadAFile() {
    FileCrypto(MemoryKeys()).writeText(path("t"), "for the first key only")

    assertNull(FileCrypto(MemoryKeys()).readText(path("t")))
    assertFalse(File(path("t")).exists())
  }

  @Test fun aKeyThatWasDeletedLeavesOldFilesUnreadable() {
    val keys = MemoryKeys()
    val crypto = FileCrypto(keys)
    crypto.writeText(path("t"), "gone with the key")

    crypto.deleteKey()

    assertEquals(1, keys.deleted)
    assertNull(crypto.readText(path("t")))
  }

  @Test fun aFileFromBeforeEncryptionIsDeletedNotServed() {
    val crypto = FileCrypto(MemoryKeys())
    File(path("old")).writeText("{\"plain\":\"json\"}")

    assertNull(crypto.readText(path("old")))
    assertFalse(File(path("old")).exists())
  }

  /** Counts key requests: a file refused before decryption never asks for the key. */
  private class CountingKeys(private val inner: CacheKeys = MemoryKeys()) : CacheKeys {
    var requests = 0
      private set

    override fun key(): SecretKey {
      requests += 1
      return inner.key()
    }

    override fun delete() = inner.delete()
  }

  /** A v1-headed file of `bytes` bytes, sparse so the test stays fast. */
  private fun oversizedFile(name: String, bytes: Long): File {
    val file = File(path(name))
    java.io.RandomAccessFile(file, "rw").use {
      it.write(byteArrayOf('v'.code.toByte(), '1'.code.toByte()))
      it.setLength(bytes)
    }
    return file
  }

  @Test fun anOversizedFileIsRefusedAndDeletedWithoutDecrypting() {
    val keys = CountingKeys()
    val crypto = FileCrypto(keys)
    val file = oversizedFile("big", MAX_CACHED_TEXT_BYTES + 100L)

    assertNull(crypto.readText(file.path))

    assertEquals(0, keys.requests)
    assertFalse(file.exists())
  }

  @Test fun aTwentyMegabyteFileIsRefusedWithoutDecrypting() {
    val keys = CountingKeys()
    val file = oversizedFile("huge", 20L * 1024 * 1024)

    assertNull(FileCrypto(keys).readText(file.path))

    assertEquals(0, keys.requests)
    assertFalse(file.exists())
  }

  @Test fun aTextRightAtTheLimitStillReads() {
    val crypto = FileCrypto(MemoryKeys())
    val text = "x".repeat(MAX_CACHED_TEXT_BYTES)
    crypto.writeText(path("edge"), text)

    assertEquals(text, crypto.readText(path("edge")))
  }

  @Test fun anOutOfMemoryErrorBecomesNoCacheAndTheFileIsDeleted() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.writeText(path("t"), "small")
    val exploding = FileCrypto(object : CacheKeys {
      override fun key(): SecretKey = throw OutOfMemoryError("simulated")

      override fun delete() {}
    })

    assertNull(exploding.readText(path("t")))
    assertFalse(File(path("t")).exists())
  }

  @Test fun aMissingFileReadsAsNothing() {
    assertNull(FileCrypto(MemoryKeys()).readText(path("nope")))
    assertFalse(FileCrypto(MemoryKeys()).decryptFile(path("nope"), path("out")))
  }

  @Test fun purgeDeletesPlaintextFilesAndKeepsEncryptedOnes() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.writeText(path("kept"), "encrypted reply")
    File(path("old-thread.json")).writeText("{\"plain\":\"json\"}")
    File(path("tiny")).writeText("v")
    File(path("half.part")).writeBytes(byteArrayOf('v'.code.toByte(), '1'.code.toByte(), 1))
    File(dir, "nested").mkdirs()
    File(dir, "nested/old-blob").writeText("plain attachment")

    val removed = crypto.purgeUnencrypted(dir)

    assertEquals(4, removed)
    assertEquals("encrypted reply", crypto.readText(path("kept")))
    assertFalse(File(path("old-thread.json")).exists())
    assertFalse(File(path("tiny")).exists())
    assertFalse(File(path("half.part")).exists())
    assertFalse(File(dir, "nested/old-blob").exists())
  }

  @Test fun purgeOfAMissingFolderRemovesNothing() {
    assertEquals(0, FileCrypto(MemoryKeys()).purgeUnencrypted(File(dir, "nope")))
  }
}
