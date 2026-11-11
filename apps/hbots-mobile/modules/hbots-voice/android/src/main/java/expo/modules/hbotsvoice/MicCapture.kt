package expo.modules.hbotsvoice

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor

class MicCapture(
  private val onFrame: (ByteArray) -> Unit,
  private val onFailure: (String) -> Unit,
) {
  private var record: AudioRecord? = null
  private var thread: Thread? = null
  private var processor: CaptureProcessor? = null
  private val effects = mutableListOf<android.media.audiofx.AudioEffect>()

  @Volatile private var running = false
  @Volatile private var level = 0f
  @Volatile var userMuted: Boolean = false
    set(value) {
      field = value
      applyMute()
    }
  @Volatile var onHold: Boolean = false
    set(value) {
      field = value
      applyMute()
    }

  private fun applyMute() {
    processor?.muted = userMuted || onHold
  }

  fun level(): Float = level

  @Synchronized
  fun start(onStarted: (Result<Unit>) -> Unit) {
    if (running) {
      onStarted(Result.success(Unit))
      return
    }
    val opened = open()
    if (opened == null) {
      onStarted(Result.failure(IllegalStateException("The microphone could not be opened.")))
      return
    }
    val (audioRecord, rate) = opened
    val chunk = ShortArray(rate / 50)
    val capture = CaptureProcessor(rate, onFrame) { level = it }
    processor = capture
    applyMute()
    record = audioRecord
    running = true
    var reported = false
    thread = Thread({
      try {
        audioRecord.startRecording()
        while (running) {
          val read = audioRecord.read(chunk, 0, chunk.size)
          if (read < 0) {
            if (running) onFailure("read_error_$read")
            break
          }
          if (read == 0) continue
          if (!reported) {
            reported = true
            onStarted(Result.success(Unit))
          }
          capture.feed(chunk, read)
        }
      } catch (error: Exception) {
        if (!reported) onStarted(Result.failure(error)) else if (running) onFailure("read_exception")
      }
    }, "hbots-voice-capture").also { it.start() }
  }

  private fun open(): Pair<AudioRecord, Int>? {
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
      attachEffects(candidate.audioSessionId)
      return candidate to rate
    }
    return null
  }

  private fun attachEffects(session: Int) {
    if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(session)?.let { it.setEnabled(true); effects.add(it) }
    if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(session)?.let { it.setEnabled(true); effects.add(it) }
    if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(session)?.let { it.setEnabled(true); effects.add(it) }
  }

  @Synchronized
  fun stop() {
    running = false
    val audioRecord = record
    record = null
    try {
      audioRecord?.stop()
    } catch (error: IllegalStateException) {
    }
    thread?.join(500)
    thread = null
    effects.forEach { it.release() }
    effects.clear()
    audioRecord?.release()
    processor = null
    level = 0f
  }
}
