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
}
