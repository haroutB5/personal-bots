package expo.modules.hbotsshare

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.ExifInterface
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class PhotoShrinkTest {
  @get:Rule val folder = TemporaryFolder()

  /** Left half red, right half blue, as stored. */
  private fun photo(name: String, width: Int, height: Int, format: Bitmap.CompressFormat): File {
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.BLUE)
    canvas.drawRect(0f, 0f, width / 2f, height.toFloat(), Paint().apply { color = Color.RED })
    val file = folder.newFile(name)
    file.outputStream().use { bitmap.compress(format, 95, it) }
    bitmap.recycle()
    return file
  }

  /** 51.5074 N, 0.1278 W. */
  private fun ExifInterface.setLondon() {
    setAttribute(ExifInterface.TAG_GPS_LATITUDE, "51/1,30/1,2664/100")
    setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
    setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "0/1,7/1,4008/100")
    setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "W")
  }

  private fun isRed(pixel: Int) = Color.red(pixel) > 200 && Color.blue(pixel) < 60
  private fun isBlue(pixel: Int) = Color.blue(pixel) > 200 && Color.red(pixel) < 60

  @Test fun aSidewaysCameraPhotoComesOutUprightAt1932By2576WithNoLocation() {
    val source = photo("IMG_0001.jpg", 4000, 3000, Bitmap.CompressFormat.JPEG)
    ExifInterface(source.path).apply {
      setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
      setLondon()
      saveAttributes()
    }
    assertNotNull(ExifInterface(source.path).getAttribute(ExifInterface.TAG_GPS_LATITUDE))

    val shrunk = PhotoShrink.shrink(source, "image/jpeg")

    assertNotNull(shrunk)
    shrunk!!
    assertEquals(1932, shrunk.width)
    assertEquals(2576, shrunk.height)
    val image = BitmapFactory.decodeFile(shrunk.file.path)
    assertEquals(1932, image.width)
    assertEquals(2576, image.height)
    // Turned 90 degrees clockwise: the stored left half (red) is now on top.
    assertTrue(isRed(image.getPixel(966, 200)))
    assertTrue(isBlue(image.getPixel(966, 2376)))
    val exif = ExifInterface(shrunk.file.path)
    assertNull(exif.getAttribute(ExifInterface.TAG_GPS_LATITUDE))
    assertNull(exif.getAttribute(ExifInterface.TAG_GPS_LONGITUDE))
    assertEquals(
      ExifInterface.ORIENTATION_UNDEFINED,
      exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED),
    )
    assertTrue(shrunk.file.length() < source.length())
  }

  @Test fun aScreenshotUnderTheLimitGoesByteForByte() {
    val source = photo("Screenshot_20261115.png", 1080, 2354, Bitmap.CompressFormat.PNG)
    val before = source.readBytes()

    assertNull(PhotoShrink.shrink(source, "image/png"))
    assertArrayEquals(before, source.readBytes())
    assertEquals(listOf(source.name), folder.root.list()!!.toList())
  }

  /** The in-app capture the emulator saved: one flat black frame. */
  private fun blackFrame(name: String): File {
    val bitmap = Bitmap.createBitmap(934, 1179, Bitmap.Config.ARGB_8888)
    Canvas(bitmap).drawColor(Color.BLACK)
    val file = folder.newFile(name)
    file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 100, it) }
    bitmap.recycle()
    return file
  }

  @Test fun anAllBlackCaptureReadsAsBlack() {
    val mean = PhotoShrink.lumaOf(blackFrame("black.jpg"))

    assertNotNull(mean)
    assertTrue(mean!! <= 0.005)
  }

  @Test fun aPhotoOfASceneDoesNotReadAsBlack() {
    val mean = PhotoShrink.lumaOf(photo("scene.jpg", 400, 300, Bitmap.CompressFormat.JPEG))

    assertNotNull(mean)
    assertTrue(mean!! > 0.02)
  }

  @Test fun meanLumaWeightsGreenMost() {
    assertEquals(0.0, PhotoShrink.meanLuma(intArrayOf(0xFF000000.toInt())), 0.0001)
    assertEquals(1.0, PhotoShrink.meanLuma(intArrayOf(0xFFFFFFFF.toInt())), 0.0001)
    assertEquals(0.2126, PhotoShrink.meanLuma(intArrayOf(0xFFFF0000.toInt())), 0.0001)
    assertEquals(0.7152, PhotoShrink.meanLuma(intArrayOf(0xFF00FF00.toInt())), 0.0001)
    assertEquals(0.0722, PhotoShrink.meanLuma(intArrayOf(0xFF0000FF.toInt())), 0.0001)
  }

  @Test fun aSmallPhotoWithALocationLosesTheLocation() {
    val source = photo("small.jpg", 1600, 1200, Bitmap.CompressFormat.JPEG)
    ExifInterface(source.path).apply {
      setLondon()
      saveAttributes()
    }

    val shrunk = PhotoShrink.shrink(source, "image/jpeg")!!

    assertEquals(1600, shrunk.width)
    assertEquals(1200, shrunk.height)
    assertNull(ExifInterface(shrunk.file.path).getAttribute(ExifInterface.TAG_GPS_LATITUDE))
  }

  @Test fun aGifKeepsItsAnimation() {
    val source = photo("sticker.gif", 3000, 3000, Bitmap.CompressFormat.PNG)
    assertNull(PhotoShrink.shrink(source, "image/gif"))
  }

  @Test fun everyExifOrientationHasItsUprightSize() {
    val sizes = (1..8).map { PhotoShrink.target(4000, 3000, it, hasLocation = false) }
    assertEquals(
      listOf(
        PhotoShrink.Size(2576, 1932),
        PhotoShrink.Size(2576, 1932),
        PhotoShrink.Size(2576, 1932),
        PhotoShrink.Size(2576, 1932),
        PhotoShrink.Size(1932, 2576),
        PhotoShrink.Size(1932, 2576),
        PhotoShrink.Size(1932, 2576),
        PhotoShrink.Size(1932, 2576),
      ),
      sizes,
    )
  }

  @Test fun aCaptureReportsItsStoredSize() {
    val source = photo("IMG_0001.jpg", 400, 300, Bitmap.CompressFormat.JPEG)

    assertEquals(PhotoShrink.Size(400, 300), PhotoShrink.measure(source))
    assertNull(PhotoShrink.measure(folder.newFile("not-an-image.jpg").apply { writeText("x") }))
  }

  @Test fun onlyFilesInTheCacheAreRead() {
    val cache = folder.newFolder("cache")
    val inside = File(cache, "ImagePicker").apply { mkdirs() }.resolve("a.jpg").apply { writeText("x") }
    val outside = folder.newFile("secret.db")

    assertEquals(inside.canonicalFile, cachedFile(cache, inside.toURI().toString()))
    assertNull(cachedFile(cache, outside.toURI().toString()))
    assertNull(cachedFile(cache, "file://${cache.path}/ImagePicker/../../secret.db"))
    assertNull(cachedFile(cache, "content://media/external/images/1"))
  }

  @Test fun theCameraFolderIsReadOnlyWhenNamed() {
    val cache = folder.newFolder("cache")
    val camera = folder.newFolder("files", "camera")
    val photo = File(camera, "a.jpg").apply { writeText("x") }
    val outside = folder.newFile("secret.db")

    assertEquals(photo.canonicalFile, cachedFile(cache, photo.toURI().toString(), camera))
    assertNull(cachedFile(cache, photo.toURI().toString()))
    assertNull(cachedFile(cache, outside.toURI().toString(), camera))
  }
}
