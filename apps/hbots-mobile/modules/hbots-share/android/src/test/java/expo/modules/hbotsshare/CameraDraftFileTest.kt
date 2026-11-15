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
}
