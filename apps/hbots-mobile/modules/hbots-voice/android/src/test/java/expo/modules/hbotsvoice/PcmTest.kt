package expo.modules.hbotsvoice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PcmTest {
  @Test
  fun bytesAreLittleEndianAndRoundTrip() {
    val samples = shortArrayOf(0, 1, -1, 0x1234, -0x1234, Short.MAX_VALUE, Short.MIN_VALUE)
    val bytes = Pcm.toBytes(samples)
    assertEquals(14, bytes.size)
    assertEquals(0x34.toByte(), bytes[6])
    assertEquals(0x12.toByte(), bytes[7])
    assertArrayEquals(samples, Pcm.fromBytes(bytes))
  }

  @Test
  fun anOddTrailingByteIsDropped() {
    assertArrayEquals(shortArrayOf(0x0201), Pcm.fromBytes(byteArrayOf(1, 2, 3)))
  }

  @Test
  fun rmsOfSilenceIsZeroAndOfFullScaleIsNearOne() {
    assertEquals(0f, Pcm.rms(ShortArray(100)), 0f)
    assertEquals(1f, Pcm.rms(ShortArray(100) { Short.MIN_VALUE }), 0.0001f)
    assertEquals(0.5f, Pcm.rms(ShortArray(100) { 16384 }), 0.0001f)
  }

  @Test
  fun downsamplingByThreeAveragesEachWindow() {
    val out = Downsampler(48_000).process(shortArrayOf(3, 6, 9, 30, 30, 30, 100, 200, 300))
    assertArrayEquals(shortArrayOf(6, 30, 200), out)
  }

  @Test
  fun downsamplingKeepsTheRateRatioOnNonIntegerSteps() {
    val out = Downsampler(44_100).process(ShortArray(44_100) { 1000 })
    assertTrue("got ${out.size}", out.size in 15_999..16_000)
    assertTrue(out.all { it == 1000.toShort() })
  }

  @Test
  fun downsamplingIsTheSameWhenTheInputArrivesInPieces() {
    val input = ShortArray(4410) { ((it * 37) % 2000 - 1000).toShort() }
    val whole = Downsampler(44_100).process(input)
    val pieces = Downsampler(44_100)
    val joined = pieces.process(input, 1001) +
      pieces.process(input.copyOfRange(1001, 3000)) +
      pieces.process(input.copyOfRange(3000, 4410))
    assertArrayEquals(whole, joined)
  }

  @Test
  fun theSameRateIsPassedThrough() {
    val input = shortArrayOf(5, 6, 7)
    assertArrayEquals(input, Downsampler(16_000).process(input))
  }

  @Test(expected = IllegalArgumentException::class)
  fun upsamplingIsRefused() {
    Downsampler(8_000)
  }

  @Test
  fun framerEmitsWholeFramesAndKeepsTheRemainder() {
    val framer = PcmFramer(4)
    val frames = mutableListOf<List<Short>>()
    framer.push(shortArrayOf(1, 2, 3)) { frames.add(it.toList()) }
    assertTrue(frames.isEmpty())
    framer.push(shortArrayOf(4, 5, 6, 7, 8, 9)) { frames.add(it.toList()) }
    assertEquals(listOf(listOf<Short>(1, 2, 3, 4), listOf<Short>(5, 6, 7, 8)), frames)
    framer.push(shortArrayOf(10, 11, 12)) { frames.add(it.toList()) }
    assertEquals(listOf<Short>(9, 10, 11, 12), frames.last())
  }

  @Test
  fun aFrameIsNotChangedByTheNextPush() {
    val framer = PcmFramer(2)
    val frames = mutableListOf<ShortArray>()
    framer.push(shortArrayOf(1, 2)) { frames.add(it) }
    framer.push(shortArrayOf(3, 4)) { frames.add(it) }
    assertArrayEquals(shortArrayOf(1, 2), frames[0])
    assertArrayEquals(shortArrayOf(3, 4), frames[1])
  }

  @Test
  fun captureSendsWholeFramesOf16kHzPcm() {
    val frames = mutableListOf<ByteArray>()
    val levels = mutableListOf<Float>()
    val capture = CaptureProcessor(48_000, { frames.add(it) }, { levels.add(it) })
    capture.feed(ShortArray(48_000 / 50) { 8000 }, 960)
    capture.feed(ShortArray(3_072) { 8000 }, 3_072)
    assertEquals(1, frames.size)
    assertEquals(Pcm.FRAME_SAMPLES * 2, frames[0].size)
    assertEquals(1, levels.size)
    assertEquals(8000 / 32768f, levels[0], 0.001f)
    assertEquals(8000, Pcm.fromBytes(frames[0])[0].toInt())
  }

  @Test
  fun mutedCaptureSendsSilenceAndReportsNoLevel() {
    val frames = mutableListOf<ByteArray>()
    val levels = mutableListOf<Float>()
    val capture = CaptureProcessor(16_000, { frames.add(it) }, { levels.add(it) })
    capture.muted = true
    capture.feed(ShortArray(Pcm.FRAME_SAMPLES) { 20_000 }, Pcm.FRAME_SAMPLES)
    assertEquals(1, frames.size)
    assertTrue(frames[0].all { it == 0.toByte() })
    assertEquals(listOf(0f), levels)
    capture.muted = false
    capture.feed(ShortArray(Pcm.FRAME_SAMPLES) { 20_000 }, Pcm.FRAME_SAMPLES)
    assertEquals(20_000, Pcm.fromBytes(frames[1])[0].toInt())
  }

  @Test
  fun playbackLevelFollowsTheQueuedChunksInTime() {
    val levels = PlaybackLevels(gain = 1f)
    val loud = ShortArray(2400) { 16384 }
    levels.add(1_000, loud, 24_000)
    levels.add(1_000, ShortArray(2400), 24_000)
    assertEquals(0.5f, levels.levelAt(1_050), 0.0001f)
    assertEquals(0f, levels.levelAt(1_150), 0f)
    assertEquals(0f, levels.levelAt(1_300), 0f)
    levels.add(5_000, loud, 24_000)
    levels.clear()
    assertEquals(0f, levels.levelAt(5_010), 0f)
  }

  @Test
  fun cuesRenderAtTheWebFrequenciesAndLengths() {
    assertEquals(24_000 * 60 / 1000, CueTones.render("mute").size)
    assertEquals(24_000 * (90 + 30 + 90) / 1000, CueTones.render("connected").size)
    assertEquals(0, CueTones.render("nonsense").size)
    val mute = CueTones.render("mute")
    var crossings = 0
    for (i in 1 until mute.size) if ((mute[i - 1] < 0) != (mute[i] < 0)) crossings++
    assertTrue("440 Hz for 60 ms crosses zero about 53 times, got $crossings", crossings in 50..56)
    assertTrue(mute.maxOf { it.toInt() } <= (0.15 * 32767).toInt() + 1)
  }
}
