package expo.modules.hbotssecure

import java.io.File
import java.nio.file.Files
import java.security.AlgorithmParameters
import java.security.Key
import java.security.Provider
import java.security.SecureRandom
import java.security.Security
import java.security.spec.AlgorithmParameterSpec
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.CipherSpi
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
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
    assertEquals('2'.code.toByte(), raw[1])
  }

  @Test fun theDataKeyIsStoredOnlyWrappedBesideTheChats() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.writeText(path("t"), "text")

    val stored = File(dir, DATA_KEY_FILE).readBytes()
    assertEquals(2 + 12 + 32 + 16, stored.size)
    assertEquals('k'.code.toByte(), stored[0])
    assertEquals('2'.code.toByte(), stored[1])
  }

  @Test fun attachmentsKeepTheV1FormatSoQueuedOnesSurviveTheUpdate() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.encryptFile("queued photo".toByteArray().inputStream(), path("blob"))

    assertEquals('1'.code.toByte(), File(path("blob")).readBytes()[1])
    assertTrue(crypto.decryptFile(path("blob"), path("plain")))
    assertEquals("queued photo", File(path("plain")).readText())
  }

  @Test fun aChatCopyInTheOldV1FormatIsDeletedWithoutAskingTheKeystore() {
    val keys = CountingKeys()
    FileCrypto(keys).encryptFile("{\"old\":\"v1 chat\"}".toByteArray().inputStream(), path("t"))
    val requestsBefore = keys.requests

    assertNull(FileCrypto(keys).readText(path("t")))

    assertEquals(requestsBefore, keys.requests)
    assertFalse(File(path("t")).exists())
  }

  @Test fun aProcessUnwrapsTheDataKeyFromTheKeystoreOnce() {
    val keys = CountingKeys()
    FileCrypto(keys).writeText(path("first"), "written by the last run")
    val afterFirstRun = keys.requests

    val crypto = FileCrypto(keys)
    repeat(10) { assertEquals("written by the last run", crypto.readText(path("first"))) }
    repeat(5) { crypto.writeText(path("w$it"), "more $it") }
    repeat(5) { assertEquals("more $it", crypto.readText(path("w$it"))) }

    assertEquals(1, keys.requests - afterFirstRun)
  }

  @Test fun aLostKeyFileMakesOldCopiesMissesAndANewKeyForNewOnes() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.writeText(path("old"), "under the lost key")
    File(dir, DATA_KEY_FILE).delete()

    assertNull(crypto.readText(path("old")))
    assertFalse(File(path("old")).exists())

    crypto.writeText(path("new"), "under a new key")
    assertEquals("under a new key", crypto.readText(path("new")))
  }

  @Test fun aDamagedKeyFileIsDroppedAndItsCopiesAreMisses() {
    val keys = MemoryKeys()
    FileCrypto(keys).writeText(path("t"), "sealed")
    val stored = File(dir, DATA_KEY_FILE).readBytes()
    stored[20] = (stored[20].toInt() xor 0x01).toByte()
    File(dir, DATA_KEY_FILE).writeBytes(stored)

    assertNull(FileCrypto(keys).readText(path("t")))
    assertFalse(File(path("t")).exists())
    assertFalse(File(dir, DATA_KEY_FILE).exists())
  }

  @Test fun deletingTheKeyOnSignOutForgetsTheInMemoryDataKey() {
    val keys = MemoryKeys()
    val crypto = FileCrypto(keys)
    crypto.writeText(path("t"), "before sign-out")
    val oldKeyFile = File(dir, DATA_KEY_FILE).readBytes()

    crypto.deleteKey()

    assertNull(crypto.readText(path("t")))
    crypto.writeText(path("next"), "next session")
    assertFalse(oldKeyFile.contentEquals(File(dir, DATA_KEY_FILE).readBytes()))
    assertEquals("next session", crypto.readText(path("next")))
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

  @Test fun aTwoMegabyteChatReadsAndOneByteMoreIsRefused() {
    val keys = CountingKeys()
    val crypto = FileCrypto(keys)
    val fits = "x".repeat(2 * 1024 * 1024)
    crypto.writeText(path("fits"), fits)
    crypto.writeText(path("over"), fits + "y")
    val requestsBefore = keys.requests

    assertEquals(fits, crypto.readText(path("fits")))
    assertNull(crypto.readText(path("over")))
    assertFalse(File(path("over")).exists())
    assertEquals(requestsBefore, keys.requests)
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

  private fun randomBytes(size: Int) = ByteArray(size).also(SecureRandom()::nextBytes)

  /**
   * Every Keystore cipher call is a binder round trip on the phone, so a send pays per call.
   * The 5,991,003 byte size is the lab's 6 MB photo, which is not a multiple of any chunk size.
   */
  @Test fun aSixMegabyteAttachmentTakesAtMostAHundredCipherCallsEachWay() {
    val crypto = FileCrypto(MemoryKeys())
    val bytes = randomBytes(5_991_003)
    val counting = CountingGcm.provider()
    Security.insertProviderAt(counting, 1)
    try {
      CountingGcm.updates = 0
      crypto.encryptFile(bytes.inputStream(), path("blob"))
      val encryptCalls = CountingGcm.updates

      CountingGcm.updates = 0
      assertTrue(crypto.decryptFile(path("blob"), path("plain")))
      val decryptCalls = CountingGcm.updates

      if (encryptCalls == 0 || decryptCalls == 0) fail("the counting cipher was not used")
      assertTrue(
        "encrypt made $encryptCalls and decrypt made $decryptCalls cipher calls",
        encryptCalls <= 100 && decryptCalls <= 100,
      )
      assertArrayEquals(bytes, File(path("plain")).readBytes())
    } finally {
      Security.removeProvider(counting.name)
    }
  }

  private val edgeSizes = listOf(0, 1, 65_535, 65_536, 65_537, 5_991_003)

  @Test fun anAttachmentSealedByTheStreamCodeOf1_67_22StillOpens() {
    val keys = MemoryKeys()
    val crypto = FileCrypto(keys)
    for (size in edgeSizes) {
      val bytes = randomBytes(size)
      File(path("blob")).writeBytes(StreamCodec1_67_22.seal(keys.key(), bytes))

      assertTrue("size $size", crypto.decryptFile(path("blob"), path("plain")))
      assertArrayEquals("size $size", bytes, File(path("plain")).readBytes())
    }
  }

  @Test fun anAttachmentSealedNowOpensWithTheStreamCodeOf1_67_22() {
    val keys = MemoryKeys()
    val crypto = FileCrypto(keys)
    for (size in edgeSizes) {
      val bytes = randomBytes(size)
      crypto.encryptFile(bytes.inputStream(), path("blob"))

      assertArrayEquals("size $size", bytes, StreamCodec1_67_22.open(keys.key(), File(path("blob")).readBytes()))
    }
  }

  @Test fun aTruncatedAttachmentIsRefusedAndNothingIsLeftBehind() {
    val crypto = FileCrypto(MemoryKeys())
    crypto.encryptFile(randomBytes(200_000).inputStream(), path("blob"))
    val raw = File(path("blob")).readBytes()
    File(path("blob")).writeBytes(raw.copyOf(raw.size - 8))

    assertFalse(crypto.decryptFile(path("blob"), path("plain")))
    assertFalse(File(path("plain")).exists())
    assertFalse(File(path("plain.part")).exists())
    assertFalse(File(path("blob")).exists())
  }
}

/** The v1 attachment code as shipped through 1.67.22, copied here to pin the format on disk. */
private object StreamCodec1_67_22 {
  fun seal(key: SecretKey, plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    val out = java.io.ByteArrayOutputStream()
    out.write(byteArrayOf('v'.code.toByte(), '1'.code.toByte()))
    out.write(cipher.iv)
    CipherOutputStream(out, cipher).use { plain.inputStream().copyTo(it) }
    return out.toByteArray()
  }

  fun open(key: SecretKey, sealed: ByteArray): ByteArray {
    assertEquals('v'.code.toByte(), sealed[0])
    assertEquals('1'.code.toByte(), sealed[1])
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 2, 12))
    return CipherInputStream(sealed.inputStream(14, sealed.size - 14), cipher).use { it.readBytes() }
  }
}

/** AES/GCM from SunJCE that counts `update` calls, registered ahead of every other provider in a test. */
class CountingGcm : CipherSpi() {
  private val inner = Cipher.getInstance("AES/GCM/NoPadding", "SunJCE")

  override fun engineSetMode(mode: String?) {}

  override fun engineSetPadding(padding: String?) {}

  override fun engineGetBlockSize() = 16

  override fun engineGetOutputSize(inputLen: Int) = inner.getOutputSize(inputLen)

  override fun engineGetIV(): ByteArray? = inner.iv

  override fun engineGetParameters(): AlgorithmParameters? = inner.parameters

  override fun engineInit(opmode: Int, key: Key?, random: SecureRandom?) = inner.init(opmode, key, random)

  override fun engineInit(opmode: Int, key: Key?, params: AlgorithmParameterSpec?, random: SecureRandom?) =
    inner.init(opmode, key, params, random)

  override fun engineInit(opmode: Int, key: Key?, params: AlgorithmParameters?, random: SecureRandom?) =
    inner.init(opmode, key, params, random)

  override fun engineUpdate(input: ByteArray, inputOffset: Int, inputLen: Int): ByteArray? {
    updates += 1
    return inner.update(input, inputOffset, inputLen)
  }

  override fun engineUpdate(input: ByteArray, inputOffset: Int, inputLen: Int, output: ByteArray, outputOffset: Int): Int {
    updates += 1
    return inner.update(input, inputOffset, inputLen, output, outputOffset)
  }

  override fun engineDoFinal(input: ByteArray?, inputOffset: Int, inputLen: Int): ByteArray =
    if (input == null) inner.doFinal() else inner.doFinal(input, inputOffset, inputLen)

  override fun engineDoFinal(input: ByteArray?, inputOffset: Int, inputLen: Int, output: ByteArray, outputOffset: Int): Int =
    if (input == null) inner.doFinal(output, outputOffset) else inner.doFinal(input, inputOffset, inputLen, output, outputOffset)

  companion object {
    @Volatile var updates = 0

    fun provider(): Provider =
      object : Provider("CountingGcm", 1.0, "counts AES/GCM update calls") {
        init {
          put("Cipher.AES/GCM/NoPadding", CountingGcm::class.java.name)
        }
      }
  }
}
