package expo.modules.hbotswindow

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * A Modal is its own window, and its host view still covers the screen while a sheet plays its
 * close motion. Both swallow taps meant for the screen beneath. This turns the window touchable
 * flag and the host view's enabled flag off together so the taps fall through, and back on if the
 * sheet reopens. Both die with the Modal.
 */
class HbotsWindowModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HbotsWindow")

    /** Sets whether the Modal holding the view takes touches. */
    Function("setTouchable") { viewTag: Int, touchable: Boolean ->
      val activity = appContext.currentActivity
      activity?.runOnUiThread {
        val view = appContext.findView<View>(viewTag)
        val decor = view?.rootView
        val params = decor?.layoutParams as? WindowManager.LayoutParams
        if (decor != null && params != null && decor.isAttachedToWindow && decor !== activity.window.decorView) {
          findHost(activity.window.decorView, decor)?.isEnabled = touchable
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

  private fun findHost(root: View, dialogDecor: View): View? {
    if (root.javaClass.simpleName == "ReactModalHostView") {
      val content = (root as? ViewGroup)?.takeIf { it.childCount > 0 }?.getChildAt(0)
      return if (content?.rootView === dialogDecor) root else null
    }
    if (root is ViewGroup) {
      for (index in 0 until root.childCount) {
        val found = findHost(root.getChildAt(index), dialogDecor)
        if (found != null) return found
      }
    }
    return null
  }
}
