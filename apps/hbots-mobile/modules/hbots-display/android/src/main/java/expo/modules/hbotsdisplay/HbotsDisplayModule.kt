package expo.modules.hbotsdisplay

import android.app.Activity
import android.view.Display
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Asks for the display's fastest refresh rate while a list scrolls, and hands the choice back
 * after. It sets the window's preferred display mode, nothing global: the preference ends
 * with the window, and 0 gives the choice back to the system.
 */
class HbotsDisplayModule : Module() {
  @Suppress("DEPRECATION")
  private fun display(activity: Activity): Display = activity.windowManager.defaultDisplay

  private fun modes(display: Display): List<DisplayMode> =
    display.supportedModes.map {
      DisplayMode(it.modeId, it.physicalWidth, it.physicalHeight, it.refreshRate)
    }

  override fun definition() = ModuleDefinition {
    Name("HbotsDisplay")

    /** False on a display with a single refresh rate: JavaScript then never asks. */
    Function("available") {
      val activity = appContext.currentActivity
      if (activity == null) {
        false
      } else {
        val display = display(activity)
        RefreshPlanner.hasHighMode(modes(display), display.mode.modeId)
      }
    }

    /** True asks for the fastest mode, false gives the choice back to the system. */
    Function("request") { high: Boolean ->
      val activity = appContext.currentActivity
      if (activity != null) {
        val display = display(activity)
        val target =
          if (high) RefreshPlanner.highModeId(modes(display), display.mode.modeId) else RefreshPlanner.NO_PREFERENCE
        if (target != null) {
          activity.runOnUiThread {
            val params = activity.window.attributes
            if (params.preferredDisplayModeId != target) {
              params.preferredDisplayModeId = target
              activity.window.attributes = params
            }
          }
        }
      }
    }
  }
}
