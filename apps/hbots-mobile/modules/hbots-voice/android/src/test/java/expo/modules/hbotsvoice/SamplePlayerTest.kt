package expo.modules.hbotsvoice

import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class RecordingSink : SampleSink {
  val log = mutableListOf<String>()
  val queued = mutableListOf<Pair<List<Short>, Int>>()

  override fun flush() {
    log.add("flush")
  }

  override fun enqueue(samples: ShortArray, rate: Int) {
    log.add("enqueue")
    queued.add(samples.toList() to rate)
  }

  override fun release() {
    log.add("release")
  }
}

class SamplePlayerTest {
  private val sink = RecordingSink()
  private val player = SamplePlayer(sink) { Base64.getDecoder().decode(it) }

  private fun encode(vararg bytes: Int): String =
    Base64.getEncoder().encodeToString(ByteArray(bytes.size) { bytes[it].toByte() })

  @Test
  fun aSampleIsDecodedLittleEndianAndQueuedAtItsRate() {
    player.play(encode(0x01, 0x00, 0xFF, 0x7F), 24_000)
    assertEquals(listOf(listOf<Short>(1, 32767) to 24_000), sink.queued)
  }

  @Test
  fun aNewSampleCutsOffTheOneStillPlaying() {
    player.play(encode(0x01, 0x00), 24_000)
    assertEquals(listOf("flush", "enqueue"), sink.log)
  }

  @Test
  fun anOddTrailingByteIsDropped() {
    player.play(encode(0x01, 0x00, 0x09), 24_000)
    assertEquals(listOf(listOf<Short>(1) to 24_000), sink.queued)
  }

  @Test
  fun aSingleByteQueuesNothing() {
    player.play(encode(0x09), 24_000)
    assertTrue(sink.queued.isEmpty())
  }

  @Test
  fun textThatIsNotBase64QueuesNothingAndStillStopsThePreviousSample() {
    player.play("***not base64***", 24_000)
    assertTrue(sink.queued.isEmpty())
    assertEquals(listOf("flush"), sink.log)
  }

  @Test
  fun stopFlushesAndReleaseReleases() {
    player.stop()
    player.release()
    assertEquals(listOf("flush", "release"), sink.log)
  }

  @Test
  fun theQueuedSamplesRoundTripThroughThePcmHelpers() {
    val original = shortArrayOf(-3, 0, 12, 32767, -32768)
    player.play(Base64.getEncoder().encodeToString(Pcm.toBytes(original)), 16_000)
    assertArrayEquals(original, sink.queued.single().first.toShortArray())
  }
}
