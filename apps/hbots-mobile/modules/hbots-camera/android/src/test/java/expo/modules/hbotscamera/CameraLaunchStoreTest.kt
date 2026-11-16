package expo.modules.hbotscamera

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class CameraLaunchStoreTest {
  private lateinit var dir: File
  private lateinit var records: MapRecords
  private lateinit var store: CameraLaunchStore

  private class MapRecords : LaunchRecords {
    var record: CameraLaunch? = null

    override fun read(): CameraLaunch? = record

    override fun write(record: CameraLaunch?) {
      this.record = record
    }
  }

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("hbots-camera").toFile()
    records = MapRecords()
    store = CameraLaunchStore(records, dir)
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun aClaimReturnsThePhotoOnce() {
    val owner = "env-1/thread-1"
    store.begin(owner, 1L).writeBytes(byteArrayOf(1, 2, 3))

    val first = store.claim(owner)

    assertTrue(first is CameraClaim.Photo)
    assertEquals(3L, (first as CameraClaim.Photo).bytes)
    assertTrue(first.file.isFile)
    assertNull(store.claim(owner))
  }

  @Test
  fun anotherChatKeepsTheLaunch() {
    val owner = "env-1/thread-1"
    val file = store.begin(owner, 1L)
    file.writeBytes(byteArrayOf(1, 2, 3))

    val other = store.claim("env-1/thread-2")

    assertTrue(other is CameraClaim.Other)
    assertEquals(owner, (other as CameraClaim.Other).owner)
    assertTrue(file.isFile)
    assertTrue(store.claim(owner) is CameraClaim.Photo)
  }

  @Test
  fun aBackedOutLaunchWritesNothing() {
    val owner = "env-1/thread-1"
    val file = store.begin(owner, 1L)

    val claim = store.claim(owner)

    assertTrue(claim is CameraClaim.Empty)
    assertFalse(file.exists())
    assertNull(records.read())
  }

  @Test
  fun aZeroByteFileIsEmpty() {
    val owner = "env-1/thread-1"
    val file = store.begin(owner, 1L)
    file.createNewFile()

    val claim = store.claim(owner)

    assertTrue(claim is CameraClaim.Empty)
    assertFalse(file.exists())
  }

  @Test
  fun aNewLaunchDropsTheUnclaimedPhoto() {
    val owner = "env-1/thread-1"
    val old = store.begin(owner, 1L)
    old.writeBytes(byteArrayOf(1, 2, 3))

    val fresh = store.begin(owner, 2L)

    assertFalse(old.exists())
    assertNotEquals(old, fresh)
    assertEquals(fresh.path, records.read()?.path)
  }

  @Test
  fun noRecordIsNoClaim() {
    assertNull(store.claim("env-1/thread-1"))
  }

  @Test
  fun aRecordOutsideTheFolderIsNeverClaimed() {
    val outside = File.createTempFile("hbots-camera-outside", ".jpg")
    try {
      outside.writeBytes(byteArrayOf(1, 2, 3))
      records.write(CameraLaunch("env-1/thread-1", outside.path, 1L))

      val claim = store.claim("env-1/thread-1")

      assertTrue(claim is CameraClaim.Empty)
      assertTrue(outside.isFile)
    } finally {
      outside.delete()
    }
  }

  @Test
  fun abandonClearsTheLaunchWhenTheCameraNeverOpens() {
    val owner = "env-1/thread-1"
    val file = store.begin(owner, 1L)

    store.abandon()

    assertNull(records.read())
    assertFalse(file.exists())
    assertNull(store.claim(owner))
  }

  @Test
  fun discardDropsTheRecordAndFileOnlyForItsOwner() {
    val owner = "env-1/thread-1"
    val file = store.begin(owner, 1L)
    file.writeBytes(byteArrayOf(1, 2, 3))

    store.discard("env-1/thread-2")

    assertTrue(file.isFile)
    assertEquals(owner, records.read()?.owner)

    store.discard(owner)

    assertNull(records.read())
    assertFalse(file.exists())
  }

  @Test
  fun pruneDropsOldFilesNoRecordPointsTo() {
    val now = 1_800_000_000_000L
    val shot = store.begin("env-1/thread-1", now)
    shot.writeBytes(byteArrayOf(1, 2, 3))
    val orphan = File(dir, "orphan.jpg").apply {
      writeBytes(byteArrayOf(4))
      setLastModified(now - 25 * HOUR)
    }
    val recent = File(dir, "recent.jpg").apply {
      writeBytes(byteArrayOf(5))
      setLastModified(now - HOUR)
    }

    store.prune(now)

    assertTrue(shot.isFile)
    assertFalse(orphan.exists())
    assertTrue(recent.isFile)
  }

  @Test
  fun pruneKeepsAnOldFileTheRecordStillPointsTo() {
    val now = 1_800_000_000_000L
    val shot = store.begin("env-1/thread-1", 1L)
    shot.writeBytes(byteArrayOf(1, 2, 3))
    shot.setLastModified(now - 25 * HOUR)

    store.prune(now)

    assertTrue(shot.isFile)
    assertTrue(store.claim("env-1/thread-1") is CameraClaim.Photo)
  }

  @Test
  fun pruneKeepsTheRecordsFileWhenTheStorePathIsASymlink() {
    val now = 1_800_000_000_000L
    val real = Files.createTempDirectory("hbots-camera-linked").toFile()
    val alias = File(real.parentFile, "${real.name}-alias")
    try {
      Files.createSymbolicLink(alias.toPath(), real.toPath())
      val linkedDir = File(alias, "camera")
      val linked = CameraLaunchStore(records, linkedDir)
      val shot = linked.begin("env-1/thread-1", 1L).apply {
        writeBytes(byteArrayOf(1, 2, 3))
        setLastModified(now - 25 * HOUR)
      }
      val orphan = File(linkedDir, "orphan.jpg").apply {
        writeBytes(byteArrayOf(4))
        setLastModified(now - 25 * HOUR)
      }

      linked.prune(now)

      assertTrue(shot.isFile)
      assertFalse(orphan.exists())
      assertTrue(linked.claim("env-1/thread-1") is CameraClaim.Photo)
    } finally {
      alias.delete()
      real.deleteRecursively()
    }
  }

  private companion object {
    const val HOUR = 60 * 60 * 1000L
  }
}
