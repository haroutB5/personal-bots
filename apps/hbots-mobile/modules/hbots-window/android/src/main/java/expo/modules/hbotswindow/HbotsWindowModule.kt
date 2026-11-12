package expo.modules.hbotswindow

import android.content.Context
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.Window
import android.view.ViewGroup
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
  private var probed = false
  override fun definition() = ModuleDefinition {
    Name("HbotsWindow")

    /** Sets whether the window holding the view takes touches. */
    Function("setTouchable") { viewTag: Int, touchable: Boolean ->
      Log.i("HbotsWin", "call tag=$viewTag touchable=$touchable")
      val activity = appContext.currentActivity
      activity?.runOnUiThread {
        if (!probed) {
          probed = true
          val inner = activity.window.callback
          activity.window.callback = object : Window.Callback by inner {
            override fun dispatchTouchEvent(event: MotionEvent): Boolean {
              val handled = inner.dispatchTouchEvent(event)
              Log.i("HbotsWin", "activity touch action=${event.actionMasked} x=${event.x} y=${event.y} focus=${activity.window.decorView.hasWindowFocus()} handled=$handled")
              return handled
            }
          }
        }
        val byManager = appContext.findView<View>(viewTag)
        val view = byManager ?: findInTree(activity.window.decorView, viewTag)
        Log.i("HbotsWin", "manager=${byManager != null} tree=${view != null}")
        val decor = view?.rootView
        val params = decor?.layoutParams as? WindowManager.LayoutParams
        Log.i("HbotsWin", "view=${view != null} decor=${decor?.javaClass?.simpleName} params=${params != null} attached=${decor?.isAttachedToWindow} main=${decor === activity.window.decorView} flags=${params?.flags}")
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

  private fun findInTree(root: View, tag: Int): View? {
    if (root.id == tag) return root
    if (root is ViewGroup) {
      for (index in 0 until root.childCount) {
        val found = findInTree(root.getChildAt(index), tag)
        if (found != null) return found
      }
    }
    return null
  }
}
