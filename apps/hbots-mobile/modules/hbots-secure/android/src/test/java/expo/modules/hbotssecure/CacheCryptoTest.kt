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

  @Test fun aMissingFileReadsAsNothing() {
    assertNull(FileCrypto(MemoryKeys()).readText(path("nope")))
    assertFalse(FileCrypto(MemoryKeys()).decryptFile(path("nope"), path("out")))
  }
}
