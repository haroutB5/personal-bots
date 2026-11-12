package expo.modules.hbotswindow

import android.content.Context
import android.view.View
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * A Modal is its own window. While a sheet plays its close motion that window still covers the
 * screen and eats taps meant for the screen beneath. This switches the window's touchable flag so
 * the taps fall through, then back if the sheet reopens. The flag lives on the window, so it ends
 * with it.
 */
class HbotsWindowModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HbotsWindow")

    /** Sets whether the window holding the view takes touches. */
    Function("setTouchable") { viewTag: Int, touchable: Boolean ->
      val activity = appContext.currentActivity
      activity?.runOnUiThread {
        val view = appContext.findView<View>(viewTag)
        val decor = view?.rootView
        val params = decor?.layoutParams as? WindowManager.LayoutParams
        if (decor != null && params != null && decor.isAttachedToWindow && decor !== activity.window.decorView) {
          val flags =
            if (touchable) params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
            else params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
          if (flags != params.flags) {
            params.flags = flags
            val manager = decor.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            manager.updateViewLayout(decor, params)
          }
        }
      }
    }
  }
}
