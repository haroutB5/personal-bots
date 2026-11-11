package expo.modules.hbotsvoice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue

class PcmPlayer {
  private class Chunk(val samples: ShortArray, val rate: Int)

  private val queue = LinkedBlockingQueue<Chunk>()
  private val levels = PlaybackLevels()
  private var track: AudioTrack? = null
  private var trackRate = 0

  @Volatile private var running = true
  @Volatile private var paused = false

  private val worker = Thread({
    while (running) {
      val chunk = try {
        queue.take()
      } catch (error: InterruptedException) {
        break
      }
      if (paused) continue
      write(chunk)
    }
  }, "hbots-voice-playback").also { it.start() }

  fun enqueue(samples: ShortArray, rate: Int) {
    if (samples.isEmpty() || paused || !running) return
    levels.add(System.currentTimeMillis(), samples, rate)
    queue.offer(Chunk(samples, rate))
  }

  fun level(): Float = levels.levelAt(System.currentTimeMillis())

  fun flush() {
    queue.clear()
    levels.clear()
    synchronized(this) {
      track?.let {
        try {
          it.pause()
          it.flush()
          it.play()
        } catch (error: IllegalStateException) {
        }
      }
    }
  }

  fun pause(value: Boolean) {
    paused = value
    if (value) flush()
  }

  @Synchronized
  private fun write(chunk: Chunk) {
    val audioTrack = trackFor(chunk.rate) ?: return
    audioTrack.write(chunk.samples, 0, chunk.samples.size)
  }

  private fun trackFor(rate: Int): AudioTrack? {
    if (track != null && trackRate == rate) return track
    track?.release()
    val minimum = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minimum <= 0) return null
    val created = try {
      AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(rate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        )
        .setBufferSizeInBytes(maxOf(minimum * 2, rate / 5 * 2))
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
    } catch (error: Exception) {
      return null
    }
    created.play()
    track = created
    trackRate = rate
    return created
  }

  fun release() {
    running = false
    queue.clear()
    worker.interrupt()
    worker.join(500)
    synchronized(this) {
      track?.let {
        try {
          it.stop()
        } catch (error: IllegalStateException) {
        }
        it.release()
      }
      track = null
    }
    levels.clear()
  }
}
