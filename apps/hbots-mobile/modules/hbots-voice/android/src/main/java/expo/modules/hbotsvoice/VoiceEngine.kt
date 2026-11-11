package expo.modules.hbotsvoice

import android.content.Context
import android.util.Base64

class VoiceEngine(
  context: Context,
  private val emit: (String, Map<String, Any?>) -> Unit,
  private val onFocus: (CallEvent) -> Unit,
  private val onCaptureFailure: (String) -> Unit,
) {
  private val capture = MicCapture(
    onFrame = { frame -> emit("micFrame", mapOf("pcm" to Base64.encodeToString(frame, Base64.NO_WRAP))) },
    onFailure = onCaptureFailure,
  )
  private val player = PcmPlayer()
  private val router = AudioRouter(context) { route -> emit("route", mapOf("route" to route.wire)) }
  private val focus = CallFocus(context, onFocus)

  fun open(): Boolean {
    val granted = focus.acquire()
    if (granted) router.enter()
    return granted
  }

  fun startCapture(onStarted: (Result<Unit>) -> Unit) = capture.start(onStarted)

  fun play(base64: String, rate: Int) {
    val bytes = try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
      return
    }
    val usable = bytes.size - bytes.size % 2
    if (usable == 0) return
    player.enqueue(Pcm.fromBytes(bytes.copyOf(usable)), rate)
  }

  fun cue(kind: String) {
    if (CueTones.known(kind)) player.enqueue(CueTones.render(kind), Pcm.PLAYBACK_RATE)
  }

  fun stopPlayback() = player.flush()

  fun setMuted(muted: Boolean) {
    capture.userMuted = muted
  }

  fun hold(value: Boolean) {
    capture.onHold = value
    player.pause(value)
  }

  fun level(source: String): Float = when (source) {
    "mic" -> capture.level()
    "voice" -> player.level()
    else -> 0f
  }

  fun route(): Route = router.route()

  fun close() {
    capture.stop()
    player.release()
    router.leave()
    focus.abandon()
  }
}
