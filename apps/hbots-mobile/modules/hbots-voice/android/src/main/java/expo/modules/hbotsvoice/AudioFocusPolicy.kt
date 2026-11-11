package expo.modules.hbotsvoice

import android.media.AudioManager

object AudioFocusPolicy {
  fun eventFor(change: Int): CallEvent? = when (change) {
    AudioManager.AUDIOFOCUS_GAIN -> CallEvent.FocusRegained
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> CallEvent.FocusLostTransient
    AudioManager.AUDIOFOCUS_LOSS -> CallEvent.Stop(EndReason.FOCUS_LOST)
    else -> null
  }
}
