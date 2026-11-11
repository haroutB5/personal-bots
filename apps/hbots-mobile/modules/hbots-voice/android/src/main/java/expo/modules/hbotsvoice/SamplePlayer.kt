package expo.modules.hbotsvoice

import android.media.AudioAttributes
import android.util.Base64

interface SampleSink {
  fun flush()
  fun enqueue(samples: ShortArray, rate: Int)
  fun release()
}

private class PcmSampleSink : SampleSink {
  private val player = PcmPlayer(AudioAttributes.USAGE_MEDIA)

  override fun flush() = player.flush()

  override fun enqueue(samples: ShortArray, rate: Int) = player.enqueue(samples, rate)

  override fun release() = player.release()
}

class SamplePlayer(
  private val sink: SampleSink = PcmSampleSink(),
  private val decode: (String) -> ByteArray = { Base64.decode(it, Base64.DEFAULT) },
) {
  fun play(base64: String, rate: Int) {
    sink.flush()
    val bytes = try {
      decode(base64)
    } catch (error: IllegalArgumentException) {
      return
    }
    val usable = bytes.size - bytes.size % 2
    if (usable == 0) return
    sink.enqueue(Pcm.fromBytes(bytes.copyOf(usable)), rate)
  }

  fun stop() = sink.flush()

  fun release() = sink.release()
}
