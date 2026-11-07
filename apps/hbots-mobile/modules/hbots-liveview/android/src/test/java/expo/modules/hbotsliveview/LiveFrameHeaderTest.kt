package expo.modules.hbotsliveview

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class LiveFrameHeaderTest {
  private fun frame(
    width: Int,
    height: Int,
    scale: Int = 100,
    version: Int = LiveFrameHeader.VERSION,
    jpegBytes: Int = 16,
  ): ByteArray {
    val bytes = ByteArray(LiveFrameHeader.BYTES + jpegBytes)
    val header = ByteBuffer.wrap(bytes, 0, LiveFrameHeader.BYTES).order(ByteOrder.BIG_ENDIAN)
    header.putShort(0, width.toShort())
    header.putShort(2, height.toShort())
    header.putShort(4, scale.toShort())
    header.putShort(6, version.toShort())
    for (index in LiveFrameHeader.BYTES until bytes.size) bytes[index] = 0x5A
    return bytes
  }

  @Test
  fun `reads the size and scale of a frame`() {
    val meta = LiveFrameHeader.parse(frame(width = 390, height = 640, scale = 275))
    assertNotNull(meta)
    assertEquals(390, meta!!.width)
    assertEquals(640, meta.height)
    assertEquals(2.75f, meta.deviceScaleFactor, 0.0001f)
  }

  @Test
  fun `rejects a frame with no jpeg after the header`() {
    assertNull(LiveFrameHeader.parse(frame(width = 390, height = 640, jpegBytes = 0)))
  }

  @Test
  fun `rejects an unknown frame version`() {
    assertNull(LiveFrameHeader.parse(frame(width = 390, height = 640, version = 2)))
  }

  @Test
  fun `rejects a zero sized frame`() {
    assertNull(LiveFrameHeader.parse(frame(width = 0, height = 640)))
    assertNull(LiveFrameHeader.parse(frame(width = 390, height = 0)))
  }

  @Test
  fun `a missing scale reads as one`() {
    val meta = LiveFrameHeader.parse(frame(width = 10, height = 20, scale = 0))
    assertEquals(1f, meta!!.deviceScaleFactor, 0.0001f)
  }
}
