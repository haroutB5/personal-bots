package expo.modules.hbotsvoice

import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

object Pcm {
  const val CAPTURE_RATE = 16_000
  const val FRAME_SAMPLES = 1024
  const val PLAYBACK_RATE = 24_000

  fun toBytes(samples: ShortArray, length: Int = samples.size): ByteArray {
    val out = ByteArray(length * 2)
    for (i in 0 until length) {
      val value = samples[i].toInt()
      out[i * 2] = (value and 0xFF).toByte()
      out[i * 2 + 1] = ((value shr 8) and 0xFF).toByte()
    }
    return out
  }

  fun fromBytes(bytes: ByteArray): ShortArray {
    val count = bytes.size / 2
    val out = ShortArray(count)
    for (i in 0 until count) {
      out[i] = ((bytes[i * 2].toInt() and 0xFF) or (bytes[i * 2 + 1].toInt() shl 8)).toShort()
    }
    return out
  }

  fun rms(samples: ShortArray, length: Int = samples.size): Float {
    if (length == 0) return 0f
    var sum = 0.0
    for (i in 0 until length) {
      val value = samples[i] / 32768.0
      sum += value * value
    }
    return sqrt(sum / length).toFloat()
  }
}

class Downsampler(fromRate: Int, toRate: Int = Pcm.CAPTURE_RATE) {
  init {
    require(toRate > 0 && fromRate >= toRate) { "can only reduce the rate: $fromRate to $toRate" }
  }

  private val step = fromRate.toDouble() / toRate
  private var position = 0.0
  private var sum = 0L
  private var count = 0

  fun process(input: ShortArray, length: Int = input.size): ShortArray {
    if (step == 1.0) return input.copyOf(length)
    val out = ShortArray((length / step).toInt() + 2)
    var written = 0
    for (i in 0 until length) {
      sum += input[i]
      count += 1
      position += 1.0
      if (position >= step) {
        out[written++] = (sum / count).toShort()
        sum = 0
        count = 0
        position -= step
      }
    }
    return out.copyOf(written)
  }
}

class PcmFramer(private val frameSamples: Int = Pcm.FRAME_SAMPLES) {
  private val frame = ShortArray(frameSamples)
  private var filled = 0

  fun push(samples: ShortArray, length: Int = samples.size, onFrame: (ShortArray) -> Unit) {
    var offset = 0
    while (offset < length) {
      val take = minOf(frameSamples - filled, length - offset)
      System.arraycopy(samples, offset, frame, filled, take)
      filled += take
      offset += take
      if (filled == frameSamples) {
        onFrame(frame.copyOf())
        filled = 0
      }
    }
  }
}

class CaptureProcessor(
  sourceRate: Int,
  private val onFrame: (ByteArray) -> Unit,
  private val onLevel: (Float) -> Unit,
) {
  private val downsampler = Downsampler(sourceRate)
  private val framer = PcmFramer()

  @Volatile var muted: Boolean = false

  fun feed(samples: ShortArray, length: Int) {
    val reduced = downsampler.process(samples, length)
    framer.push(reduced) { frame ->
      if (muted) {
        onLevel(0f)
        onFrame(ByteArray(frame.size * 2))
      } else {
        onLevel(Pcm.rms(frame))
        onFrame(Pcm.toBytes(frame))
      }
    }
  }
}

class PlaybackLevels(private val gain: Float = 3f) {
  private class Segment(val start: Long, val end: Long, val level: Float)

  private val segments = ArrayDeque<Segment>()

  @Synchronized
  fun add(now: Long, samples: ShortArray, rate: Int) {
    val durationMs = samples.size * 1000L / rate
    val start = maxOf(now, segments.lastOrNull()?.end ?: now)
    segments.addLast(Segment(start, start + durationMs, minOf(1f, Pcm.rms(samples) * gain)))
  }

  @Synchronized
  fun levelAt(now: Long): Float {
    while (segments.isNotEmpty() && segments.first().end <= now) segments.removeFirst()
    val current = segments.firstOrNull() ?: return 0f
    return if (now >= current.start) current.level else 0f
  }

  @Synchronized
  fun clear() = segments.clear()
}

object CueTones {
  private const val AMPLITUDE = 0.15
  private const val RAMP_MS = 10

  private data class Beep(val hz: Int, val ms: Int, val gapAfterMs: Int = 0)

  private fun beeps(kind: String): List<Beep> = when (kind) {
    "connected" -> listOf(Beep(660, 90, 30), Beep(880, 90))
    "incoming" -> listOf(Beep(740, 300))
    "mute" -> listOf(Beep(440, 60))
    "unmute" -> listOf(Beep(560, 60))
    "ended" -> listOf(Beep(880, 90, 30), Beep(660, 90))
    "error" -> listOf(Beep(330, 150))
    else -> emptyList()
  }

  fun known(kind: String): Boolean = beeps(kind).isNotEmpty()

  fun render(kind: String, rate: Int = Pcm.PLAYBACK_RATE): ShortArray {
    val parts = beeps(kind).map { beep ->
      val count = beep.ms * rate / 1000
      val ramp = RAMP_MS * rate / 1000
      val tone = ShortArray(count) { i ->
        val envelope = minOf(1.0, i.toDouble() / ramp, (count - 1 - i).toDouble() / ramp)
        (sin(2 * PI * beep.hz * i / rate) * AMPLITUDE * envelope * 32767).toInt().toShort()
      }
      tone + ShortArray(beep.gapAfterMs * rate / 1000)
    }
    return parts.fold(ShortArray(0)) { acc, part -> acc + part }
  }
}
