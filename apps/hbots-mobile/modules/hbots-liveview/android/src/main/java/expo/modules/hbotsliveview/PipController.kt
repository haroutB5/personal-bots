package expo.modules.hbotsliveview

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.core.util.Consumer
import androidx.core.app.PictureInPictureModeChangedInfo

/** Applies [PipPlan] to the main activity and reports when the window enters or leaves PiP. */
internal class PipController(private val onChanged: (Boolean) -> Unit) {
  private var watched: ComponentActivity? = null
  private val listener = Consumer<PictureInPictureModeChangedInfo> { onChanged(it.isInPictureInPictureMode) }

  /** Returns false when this phone cannot do PiP and nothing was changed. */
  fun apply(activity: Activity?, enabled: Boolean, frameWidth: Int, frameHeight: Int): Boolean {
    if (activity == null) return false
    val has = activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
    val request = PipPlan.plan(Build.VERSION.SDK_INT, has, enabled, frameWidth, frameHeight) ?: return false
    watch(activity)
    try {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(request.ratioWidth, request.ratioHeight))
        .setAutoEnterEnabled(request.autoEnter)
        .build()
      activity.setPictureInPictureParams(params)
    } catch (_: IllegalStateException) {
      // The manifest did not allow PiP or the activity is going away: no window to change.
      return false
    }
    return true
  }

  private fun watch(activity: Activity) {
    val host = activity as? ComponentActivity ?: return
    if (watched === host) return
    unwatch()
    host.addOnPictureInPictureModeChangedListener(listener)
    watched = host
  }

  fun unwatch() {
    watched?.removeOnPictureInPictureModeChangedListener(listener)
    watched = null
  }
}
