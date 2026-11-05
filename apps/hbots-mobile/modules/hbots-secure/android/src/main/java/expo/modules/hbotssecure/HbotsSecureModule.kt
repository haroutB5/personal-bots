package expo.modules.hbotssecure

import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Turns FLAG_SECURE on while a secret or sign-in card is on screen: Android
 * blocks screenshots, the Recents thumbnail and screen recording for the whole
 * activity until the card goes away.
 */
class HbotsSecureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HbotsSecure")

    Function("setSecure") { secure: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        if (secure) {
          activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
          activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
      }
    }
  }
}
