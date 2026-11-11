package expo.modules.hbotsvoice

import android.media.AudioAttributes
import android.util.Base64

class SamplePlayer {
  private val player = PcmPlayer(AudioAttributes.USAGE_MEDIA)

  fun play(base64: String, rate: Int) {
    player.flush()
    val bytes = try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
      return
    }
    val usable = bytes.size - bytes.size % 2
    if (usable == 0) return
    player.enqueue(Pcm.fromBytes(bytes.copyOf(usable)), rate)
  }

  fun stop() = player.flush()

  fun release() = player.release()
}
