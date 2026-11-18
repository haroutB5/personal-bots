package expo.modules.hbotstextselect

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.Selection
import android.text.Spannable
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.TextView
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues

/**
 * Carries a double tap on chat text into the Select text reader. `textHitAt` finds the word under
 * the second tap in the chat. `selectWordAt` selects the same word in the reader, with the system
 * handles and toolbar, by sending the reader's TextView a long press at that word. A synthetic double
 * tap selected the word but showed no handles or toolbar on the emulator.
 */
class HbotsTextSelectModule : Module() {
  private val main = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("HbotsTextSelect")

    /** The deepest TextView under a window point inside the surface: its text and the character offset. */
    AsyncFunction("textHitAt") { surfaceTag: Int, pageX: Double, pageY: Double ->
      val surface = appContext.findView<View>(surfaceTag) ?: return@AsyncFunction null
      val density = surface.resources.displayMetrics.density
      val x = (pageX * density).toFloat()
      val y = (pageY * density).toFloat()
      val hit = deepestTextView(surface, x, y) ?: return@AsyncFunction null
      val view = hit
      val location = IntArray(2)
      view.getLocationOnScreen(location)
      val localX = x - location[0]
      val localY = y - location[1]
      if (view.layout == null) return@AsyncFunction null
      val offset = view.getOffsetForPosition(localX, localY)
      mapOf("text" to view.text.toString(), "offset" to offset)
    }.runOnQueue(Queues.MAIN)

    /** Clears the reader's selection. True when there was one. */
    AsyncFunction("clearSelection") { textTag: Int ->
      val view = appContext.findView<TextView>(textTag) ?: return@AsyncFunction false
      clearSelection(view)
    }.runOnQueue(Queues.MAIN)

    /** Selects the word at `offset` in the reader's TextView, then reports where its line sits in dp. */
    AsyncFunction("selectWordAt") { textTag: Int, offset: Int, promise: Promise ->
      val view = appContext.findView<TextView>(textTag)
      val layout = view?.layout
      if (view == null || layout == null || offset < 0 || offset >= view.text.length) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val density = view.resources.displayMetrics.density
      val line = layout.getLineForOffset(offset)
      val lineTop = (layout.getLineTop(line) + view.totalPaddingTop) / density
      val point = pointForOffset(view, offset)
      view.requestFocus()
      sendLongPress(view, point.first, point.second) {
        promise.resolve(
          mapOf("lineTop" to lineTop, "mode" to if (hasSelection(view)) "longPress" else "none"),
        )
      }
    }.runOnQueue(Queues.MAIN)
  }

  /** Drops the reader's selection, handles and toolbar. Returns whether there was a selection. */
  private fun clearSelection(view: TextView): Boolean {
    val had = hasSelection(view)
    if (!had) return false
    (view.text as? Spannable)?.let { Selection.removeSelection(it) }
    view.clearFocus()
    view.setTextIsSelectable(false)
    view.setTextIsSelectable(true)
    return true
  }

  private fun hasSelection(view: TextView): Boolean {
    val text = view.text
    return text is Spannable && Selection.getSelectionStart(text) != Selection.getSelectionEnd(text)
  }

  /** The smallest TextView whose on-screen box holds the point, or null. */
  private fun deepestTextView(root: View, x: Float, y: Float): TextView? {
    var best: TextView? = null
    var bestArea = Long.MAX_VALUE
    fun walk(view: View) {
      if (view.visibility != View.VISIBLE) return
      if (view is TextView && view.layout != null) {
        val location = IntArray(2)
        view.getLocationOnScreen(location)
        val inside =
          x >= location[0] && x < location[0] + view.width && y >= location[1] && y < location[1] + view.height
        val area = view.width.toLong() * view.height
        if (inside && area < bestArea) {
          best = view
          bestArea = area
        }
      }
      if (view is ViewGroup) for (index in 0 until view.childCount) walk(view.getChildAt(index))
    }
    walk(root)
    return best
  }

  /** The middle of the character at `offset`, in the view's own pixels. */
  private fun pointForOffset(view: TextView, offset: Int): Pair<Float, Float> {
    val layout = view.layout
    val line = layout.getLineForOffset(offset)
    val left = layout.getPrimaryHorizontal(offset)
    val right = layout.getPrimaryHorizontal(minOf(offset + 1, view.text.length))
    val x = view.totalPaddingLeft - view.scrollX + (left + right) / 2f
    val y = view.totalPaddingTop - view.scrollY + (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
    return Pair(x, y)
  }

  private fun touch(view: View, downTime: Long, action: Int, x: Float, y: Float) {
    val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0)
    view.dispatchTouchEvent(event)
    event.recycle()
  }

  private fun sendLongPress(view: View, x: Float, y: Float, done: () -> Unit) {
    val downTime = SystemClock.uptimeMillis()
    touch(view, downTime, MotionEvent.ACTION_DOWN, x, y)
    main.postDelayed({
      touch(view, downTime, MotionEvent.ACTION_UP, x, y)
      main.postDelayed(done, SETTLE_MS)
    }, ViewConfiguration.getLongPressTimeout() + LONG_PRESS_MARGIN_MS)
  }

  private companion object {
    const val SETTLE_MS = 250L
    const val LONG_PRESS_MARGIN_MS = 80L
  }
}
