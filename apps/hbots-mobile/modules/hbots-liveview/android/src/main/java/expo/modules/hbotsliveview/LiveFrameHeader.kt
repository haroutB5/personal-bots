package expo.modules.hbotsliveview

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** The size and scale a frame was captured at. Width and height are CSS pixels. */
data class LiveFrameMeta(val width: Int, val height: Int, val deviceScaleFactor: Float)

/**
 * The 8-byte big-endian header the shared browser and the desktop both put in
 * front of every JPEG frame: u16 width, u16 height, u16 scale x100, u16 version.
 * Parsing it per frame means a dropped frame can never leave taps mapped
 * against a stale viewport.
 */
object LiveFrameHeader {
  const val BYTES = 8
  const val VERSION = 1

  fun parse(frame: ByteArray, offset: Int = 0, length: Int = frame.size): LiveFrameMeta? {
    if (length <= BYTES) return null
    val header = ByteBuffer.wrap(frame, offset, BYTES).order(ByteOrder.BIG_ENDIAN)
    if (header.getShort(6).toInt() != VERSION) return null
    val width = header.getShort(0).toInt() and 0xFFFF
    val height = header.getShort(2).toInt() and 0xFFFF
    if (width == 0 || height == 0) return null
    val scale = (header.getShort(4).toInt() and 0xFFFF) / 100f
    return LiveFrameMeta(width, height, if (scale > 0f) scale else 1f)
  }

  fun jpegOffset(): Int = BYTES
}
