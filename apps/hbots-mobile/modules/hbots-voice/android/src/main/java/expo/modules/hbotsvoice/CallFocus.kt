package expo.modules.hbotsvoice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

class CallFocus(context: Context, private val onChange: (CallEvent) -> Unit) {
  private val manager = context.getSystemService(AudioManager::class.java)
  private var request: AudioFocusRequest? = null

  fun acquire(): Boolean {
    val built = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
      .setOnAudioFocusChangeListener({ change -> AudioFocusPolicy.eventFor(change)?.let(onChange) }, Handler(Looper.getMainLooper()))
      .build()
    request = built
    return manager.requestAudioFocus(built) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  fun abandon() {
    request?.let { manager.abandonAudioFocusRequest(it) }
    request = null
  }
}
