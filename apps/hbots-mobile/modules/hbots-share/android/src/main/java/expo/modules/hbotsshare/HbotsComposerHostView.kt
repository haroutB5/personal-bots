package expo.modules.hbotsshare

import android.content.Context
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.os.SystemClock
import android.util.Log
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Wraps the composer's TextInput. It does two things the TextInput cannot do from JavaScript:
 * tell a hardware Enter from the soft keyboard's, and receive an image from the keyboard.
 *
 * The image is copied into the share intake dir by [ShareStore], exactly like a shared image,
 * and JavaScript reads it through the same intake path and caps. Nothing is kept anywhere
 * else.
 */
class HbotsComposerHostView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {
  private val onEnterSend by EventDispatcher()
  private val onContent by EventDispatcher()
  private var bound: EditText? = null

  private companion object {
    const val TAG = "HbotsShare"
  }

  private val listener = OnReceiveContentListener { _, payload ->
    val startedAt = SystemClock.elapsedRealtime()
    val split = payload.partition { item -> ContentRoute.takesItem(item.uri != null) }
    val taken = split.first
    if (taken != null) take(taken)
    // Text goes back to the field, so a plain paste is unchanged.
    // Counts and timing only, never a uri or content: this is how a keyboard that reports a failed
    // commit (X6.5) is told apart from a slow copy.
    Log.i(
      TAG,
      "receive source=${payload.source} items=${payload.clip.itemCount} mime=${payload.clip.description.takeIf { it.mimeTypeCount > 0 }?.getMimeType(0)} " +
        "taken=${taken != null} remainder=${split.second != null} ms=${SystemClock.elapsedRealtime() - startedAt}",
    )
    split.second
  }

  /** Kept off the main thread would risk the keyboard revoking the grant; the copy is capped at 25 MB. */
  private fun take(content: ContentInfoCompat) {
    val clip = content.clip
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    val hint = ContentRoute.mimeHint(clip.description.takeIf { it.mimeTypeCount > 0 }?.getMimeType(0))
    val id = try {
      ShareStore.intakeContent(context.applicationContext, uris, hint)
    } catch (_: Exception) {
      null
    }
    // A missing id means the copy failed: the event then carries no id.
    onContent(if (id == null) emptyMap() else mapOf("id" to id))
  }

  /**
   * React Native lays out this view's child itself. ExpoView is a LinearLayout, which would
   * re-lay the TextInput at wrap-content size after every host layout and leave it narrower
   * than the frame Yoga measured, so a wrapping message grew the field but not the box.
   */
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(
      MeasureSpec.getSize(widthMeasureSpec),
      MeasureSpec.getSize(heightMeasureSpec),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val decision = EnterKeyPolicy.decide(event.keyCode, event.flags, event.metaState)
    if (EnterKeyPolicy.sendsNow(decision, event.action, event.repeatCount)) {
      onEnterSend(emptyMap())
    }
    if (EnterKeyPolicy.swallows(decision)) return true
    return super.dispatchKeyEvent(event)
  }

  override fun onViewAdded(child: View?) {
    super.onViewAdded(child)
    bind()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    bind()
  }

  private fun bind() {
    val field = findField(this) ?: return
    if (field === bound) return
    ViewCompat.setOnReceiveContentListener(field, ContentRoute.ACCEPTED_TYPES, listener)
    bound = field
  }

  override fun onDetachedFromWindow() {
    bound?.let { ViewCompat.setOnReceiveContentListener(it, null, null) }
    bound = null
    super.onDetachedFromWindow()
  }

  private fun findField(view: View): EditText? {
    if (view is EditText) return view
    if (view !is ViewGroup) return null
    for (index in 0 until view.childCount) {
      findField(view.getChildAt(index))?.let { return it }
    }
    return null
  }
}
