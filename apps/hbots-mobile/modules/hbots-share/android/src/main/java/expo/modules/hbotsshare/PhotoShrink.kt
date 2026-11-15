package expo.modules.hbotsshare

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.media.ExifInterface
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * A photo leaves the phone at most 2576 px on its long edge, upright, as a quality 85 JPEG with
 * no metadata, so its location never leaves the phone and a 6 MB camera photo uploads as well
 * under 1 MB. A picture that is already that small, upright and carries no location (a
 * screenshot) is left byte for byte.
 */
internal object PhotoShrink {
  const val LONG_EDGE = 2576
  const val QUALITY = 85
  private val TYPES = setOf("image/jpeg", "image/png", "image/heic", "image/heif")

  /** What EXIF orientation asks for: turn the stored pixels clockwise, then mirror left to right. */
  data class Turn(val degrees: Int, val mirror: Boolean) {
    val swapsSides get() = degrees % 180 != 0
  }

  private val UPRIGHT = Turn(0, false)

  private val TURNS = mapOf(
    ExifInterface.ORIENTATION_FLIP_HORIZONTAL to Turn(0, true),
    ExifInterface.ORIENTATION_ROTATE_180 to Turn(180, false),
    ExifInterface.ORIENTATION_FLIP_VERTICAL to Turn(180, true),
    ExifInterface.ORIENTATION_TRANSPOSE to Turn(90, true),
    ExifInterface.ORIENTATION_ROTATE_90 to Turn(90, false),
    ExifInterface.ORIENTATION_TRANSVERSE to Turn(270, true),
    ExifInterface.ORIENTATION_ROTATE_270 to Turn(270, false),
  )

  fun turnFor(orientation: Int): Turn = TURNS[orientation] ?: UPRIGHT

  data class Size(val width: Int, val height: Int)

  /** The upright size to write, or null when the file can go as it is. */
  fun target(width: Int, height: Int, orientation: Int, hasLocation: Boolean): Size? {
    val turn = turnFor(orientation)
    val (w, h) = if (turn.swapsSides) height to width else width to height
    val long = max(w, h)
    if (long <= LONG_EDGE && turn == UPRIGHT && !hasLocation) return null
    if (long <= LONG_EDGE) return Size(w, h)
    val scale = LONG_EDGE.toDouble() / long
    return Size((w * scale).roundToInt(), (h * scale).roundToInt())
  }

  data class Shrunk(val file: File, val width: Int, val height: Int)

  /**
   * Writes the shrunk photo next to `source` and returns it, or null when the source goes as it
   * is: already small and clean, a type this does not re-encode (a GIF keeps its animation), or
   * a file that cannot be decoded. The source is never changed.
   */
  fun shrink(source: File, mimeType: String): Shrunk? {
    if (mimeType.lowercase() !in TYPES) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(source.path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val exif = readExif(source)
    val orientation = exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      ?: ExifInterface.ORIENTATION_NORMAL
    val hasLocation = exif?.getAttribute(ExifInterface.TAG_GPS_LATITUDE) != null ||
      exif?.getAttribute(ExifInterface.TAG_GPS_LONGITUDE) != null
    val size = target(bounds.outWidth, bounds.outHeight, orientation, hasLocation) ?: return null

    var sample = 1
    val storedLong = max(bounds.outWidth, bounds.outHeight)
    val targetLong = max(size.width, size.height)
    while (storedLong / (sample * 2) >= targetLong) sample *= 2
    val decoded = BitmapFactory.decodeFile(source.path, BitmapFactory.Options().apply { inSampleSize = sample })
      ?: return null
    val upright = try {
      draw(decoded, turnFor(orientation), size)
    } finally {
      decoded.recycle()
    }
    val out = File(source.parentFile, "${source.nameWithoutExtension}-$LONG_EDGE.jpg")
    val part = File(out.path + ".part")
    try {
      part.outputStream().use { stream ->
        if (!upright.compress(Bitmap.CompressFormat.JPEG, QUALITY, stream)) return null
      }
      if (!part.renameTo(out)) return null
    } finally {
      upright.recycle()
      part.delete()
    }
    return Shrunk(out, size.width, size.height)
  }

  private fun readExif(source: File): ExifInterface? =
    try {
      ExifInterface(source.path)
    } catch (_: Exception) {
      null
    }

  /** Turns, mirrors and scales in one pass onto white, so a transparent PNG does not go black. */
  private fun draw(decoded: Bitmap, turn: Turn, size: Size): Bitmap {
    val matrix = Matrix()
    matrix.postRotate(turn.degrees.toFloat())
    if (turn.mirror) matrix.postScale(-1f, 1f)
    val bounds = RectF(0f, 0f, decoded.width.toFloat(), decoded.height.toFloat())
    matrix.mapRect(bounds)
    matrix.postTranslate(-bounds.left, -bounds.top)
    matrix.postScale(size.width / bounds.width(), size.height / bounds.height())
    val out = Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawColor(Color.WHITE)
    canvas.drawBitmap(decoded, matrix, Paint(Paint.FILTER_BITMAP_FLAG))
    return out
  }
}
