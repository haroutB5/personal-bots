package expo.modules.hbotsvoice

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor

interface MicRecorder {
  fun startRecording()
  fun read(buffer: ShortArray, offset: Int, size: Int): Int
  fun stop()
  fun release()
}

class OpenedMic(val recorder: MicRecorder, val rate: Int)

fun interface MicSource {
  fun open(): OpenedMic?
}

class AndroidMicSource : MicSource {
  override fun open(): OpenedMic? {
    for (rate in listOf(Pcm.CAPTURE_RATE, 48_000, 44_100)) {
      val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minimum <= 0) continue
      val size = maxOf(minimum * 2, rate / 5 * 2)
      val candidate = try {
        AudioRecord(
          MediaRecorder.AudioSource.VOICE_COMMUNICATION,
          rate,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          size,
        )
      } catch (error: Exception) {
        null
      }
      if (candidate == null) continue
      if (candidate.state != AudioRecord.STATE_INITIALIZED) {
        candidate.release()
        continue
      }
      return OpenedMic(AndroidRecorder(candidate, attachEffects(candidate.audioSessionId)), rate)
    }
    return null
  }

  private fun attachEffects(session: Int): List<AudioEffect> {
    val effects = mutableListOf<AudioEffect>()
    if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(session)?.let { it.setEnabled(true); effects.add(it) }
    if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(session)?.let { it.setEnabled(true); effects.add(it) }
    if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(session)?.let { it.setEnabled(true); effects.add(it) }
    return effects
  }

  private class AndroidRecorder(
    private val record: AudioRecord,
    private val effects: List<AudioEffect>,
  ) : MicRecorder {
    override fun startRecording() = record.startRecording()

    override fun read(buffer: ShortArray, offset: Int, size: Int): Int = record.read(buffer, offset, size)

    override fun stop() = record.stop()

    override fun release() {
      effects.forEach { it.release() }
      record.release()
    }
  }
}
