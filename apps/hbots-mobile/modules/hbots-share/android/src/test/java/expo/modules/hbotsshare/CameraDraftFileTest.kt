package expo.modules.hbotsshare

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class CameraDraftFileTest {
  @get:Rule val folder = TemporaryFolder()

  @Test
  fun aCameraCaptureIsCopiedForTheDraftThenDeleted() {
    val source = folder.newFile("launch.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
    val draftDir = File(folder.root, "camera-drafts")

    val copy = CameraDraftFile.adopt(source, draftDir)

    assertTrue(copy !== null)
    copy!!
    assertArrayEquals(byteArrayOf(1, 2, 3), copy.readBytes())
    assertEquals("launch.jpg", copy.name)
    assertTrue(copy.isFile)
    assertFalse(source.exists())
  }

  @Test
  fun aFailedCopyKeepsTheCameraCapture() {
    val source = folder.newFile("launch.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
    val notADirectory = folder.newFile("camera-drafts")

    assertNull(CameraDraftFile.adopt(source, notADirectory))
    assertTrue(source.isFile)
  }

  @Test
  fun aSentDraftCopyIsDeleted() {
    val draftDir = File(folder.root, "camera-drafts").apply { mkdirs() }
    val copy = File(draftDir, "launch-2576.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }

    assertTrue(CameraDraftFile.discard(draftDir, copy.toURI().toString()))

    assertFalse(copy.exists())
  }

  @Test
  fun aDiscardedDraftCopyIsDeleted() {
    val draftDir = File(folder.root, "camera-drafts").apply { mkdirs() }
    val copy = File(draftDir, "launch.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }

    assertTrue(CameraDraftFile.discard(draftDir, copy.path))

    assertFalse(copy.exists())
  }

  @Test
  fun aCopyOutsideTheDraftFolderIsNeverDeleted() {
    val draftDir = File(folder.root, "camera-drafts").apply { mkdirs() }
    val outside = folder.newFile("keep.jpg").apply { writeBytes(byteArrayOf(7)) }

    assertFalse(CameraDraftFile.discard(draftDir, outside.path))

    assertTrue(outside.isFile)
  }

  @Test
  fun aCopyALiveDraftPointsAtSurvivesTheSweep() {
    val now = 1_800_000_000_000L
    val draftDir = File(folder.root, "camera-drafts").apply { mkdirs() }
    val live = File(draftDir, "live.jpg").apply {
      writeBytes(byteArrayOf(1))
      setLastModified(now - 25 * HOUR)
    }
    val stale = File(draftDir, "stale.jpg").apply {
      writeBytes(byteArrayOf(2))
      setLastModified(now - 25 * HOUR)
    }
    val fresh = File(draftDir, "fresh.jpg").apply {
      writeBytes(byteArrayOf(3))
      setLastModified(now - HOUR)
    }

    CameraDraftFile.prune(draftDir, listOf(live.toURI().toString()), now)

    assertTrue(live.isFile)
    assertFalse(stale.exists())
    assertTrue(fresh.isFile)
  }

  private companion object {
    const val HOUR = 60 * 60 * 1000L
  }
}
