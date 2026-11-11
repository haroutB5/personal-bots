package expo.modules.hbotslauncher

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log

/**
 * Every launcher shortcut opens here, not on the app's main screen. Android adds NEW_TASK and CLEAR_TASK
 * to the first intent of a shortcut. Aimed at the main screen, that clears the running app and starts a
 * second one with no live connection ("not connected", 4 of 4 on device). Here those flags only touch
 * this activity's own empty task. It then hands the link to the running app (the main activity is
 * singleTask, so the app's own task comes forward and its router opens the link) and finishes, which
 * leaves exactly one hbots task in recents.
 */
class ShortcutTrampolineActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val link = TrampolineTarget.link(intent?.dataString)
    val open = if (link != null) {
      Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(packageName)
    } else {
      packageManager.getLaunchIntentForPackage(packageName)
    }
    try {
      if (open != null) startActivity(open)
    } catch (cause: ActivityNotFoundException) {
      Log.w(TAG, "shortcut target not found")
    }
    finish()
  }

  private companion object {
    const val TAG = "HbotsLauncher"
  }
}

/** Which links a shortcut may hand on. Only the app's own scheme, and nothing that is not a plain link. */
object TrampolineTarget {
  private const val SCHEME = "hbots://"
  private const val MAX_LENGTH = 2048

  fun link(raw: String?): String? {
    if (raw == null || raw.length > MAX_LENGTH) return null
    if (!raw.startsWith(SCHEME) || raw.length == SCHEME.length) return null
    if (raw.any { it.isWhitespace() || it.isISOControl() }) return null
    return raw
  }
}
