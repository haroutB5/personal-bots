package expo.modules.hbotsvoice

class MicCapture(
  private val onFrame: (ByteArray) -> Unit,
  private val onFailure: (String) -> Unit,
  private val source: MicSource = AndroidMicSource(),
) {
  private var record: MicRecorder? = null
  private var thread: Thread? = null
  private var processor: CaptureProcessor? = null

  private var closed = false

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
    if (closed) {
      onStarted(Result.failure(IllegalStateException("The call is over.")))
      return
    }
    if (running) {
      onStarted(Result.success(Unit))
      return
    }
    val opened = source.open()
    if (opened == null) {
      onStarted(Result.failure(IllegalStateException("The microphone could not be opened.")))
      return
    }
    val audioRecord = opened.recorder
    val rate = opened.rate
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

  @Synchronized
  fun stop() {
    closed = true
    running = false
    val audioRecord = record
    record = null
    try {
      audioRecord?.stop()
    } catch (error: IllegalStateException) {
    }
    thread?.join(500)
    thread = null
    audioRecord?.release()
    processor = null
    level = 0f
  }
}
