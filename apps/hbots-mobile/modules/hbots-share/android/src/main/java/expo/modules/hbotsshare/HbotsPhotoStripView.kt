package expo.modules.hbotsshare

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ext.SdkExtensions
import android.provider.MediaStore
import android.util.Log
import android.widget.photopicker.EmbeddedPhotoPickerFeatureInfo
import android.widget.photopicker.EmbeddedPhotoPickerProviderFactory
import android.widget.photopicker.EmbeddedPhotoPickerSession
import androidx.photopicker.EmbeddedPhotoPickerView
import androidx.photopicker.ExperimentalPhotoPickerApi
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * The system photo picker drawn inside the plus sheet, so recent photos show at once with no
 * storage permission. A tap selects a photo: the picker grants its uri about 400 ms later and
 * the view reports the new count with `onSelection`, and a second tap revokes it. Nothing is
 * copied until `add()` (the sheet's Add button) or the picker's own `onSelectionComplete`: then
 * the selected photos, in tap order, are copied into the share intake like a keyboard image.
 * The picker's own Add button only exists in its expanded state, so the sheet draws its own.
 * JavaScript reads the intake through the same caps. When the device has no embedded picker, or
 * its session fails, the view reports `onUnavailable` and the sheet falls back to the full picker.
 */
@SuppressLint("NewApi")
@OptIn(ExperimentalPhotoPickerApi::class)
class HbotsPhotoStripView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {
  private val onPicked by EventDispatcher()
  private val onUnavailable by EventDispatcher()
  private val onSelection by EventDispatcher()
  private val selection = PhotoSelection<Uri>()
  private var picker: EmbeddedPhotoPickerView? = null
  private var ended = false

  /** How many photos one pick may hold: the room left in the draft. */
  var maxSelection: Int = 1

  override val shouldUseAndroidLayout = true

  companion object {
    private const val TAG = "HbotsShare"
    private const val SERVICE_ACTION = "com.android.photopicker.core.embedded.EmbeddedService.BIND"

    /** Android 14+ with SDK extension 15 and a photo picker module that serves the embedded picker. */
    fun available(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
      if (SdkExtensions.getExtensionVersion(Build.VERSION_CODES.UPSIDE_DOWN_CAKE) < 15) return false
      return context.packageManager.queryIntentServices(Intent(SERVICE_ACTION), 0).isNotEmpty()
    }
  }

  private val listener = object : EmbeddedPhotoPickerView.EmbeddedPhotoPickerStateChangeListener {
    override fun onSessionOpened(newSession: EmbeddedPhotoPickerSession) {
      Log.i(TAG, "embedded picker open ${width}x$height")
    }

    override fun onSessionError(throwable: Throwable) {
      Log.w(TAG, "embedded picker error ${throwable.javaClass.simpleName}")
      unavailable("session")
    }

    override fun onUriPermissionGranted(uris: List<Uri>) {
      selection.grant(uris)
      onSelection(mapOf("count" to selection.count))
    }

    override fun onUriPermissionRevoked(uris: List<Uri>) {
      selection.revoke(uris)
      onSelection(mapOf("count" to selection.count))
    }

    override fun onSelectionComplete() {
      deliver()
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    start()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    start()
  }

  /** Waits for a window and a size: the session is opened at the view's size on its host token. */
  private fun start() {
    if (picker != null || ended || !isAttachedToWindow || width == 0 || height == 0) return
    val activity = appContext.currentActivity
    if (activity == null || !available(activity)) {
      unavailable("unsupported")
      return
    }
    try {
      val view = EmbeddedPhotoPickerView(activity)
      view.addEmbeddedPhotoPickerStateChangeListener(listener)
      view.setProvider(EmbeddedPhotoPickerProviderFactory.create(activity))
      addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      picker = view
      view.setEmbeddedPhotoPickerFeatureInfo(
        EmbeddedPhotoPickerFeatureInfo.Builder()
          .setMimeTypes(listOf("image/*"))
          .setMaxSelectionLimit(maxSelection.coerceIn(1, MediaStore.getPickImagesMaxLimit()))
          .setOrderedSelection(true)
          .setThemeNightMode(Configuration.UI_MODE_NIGHT_YES)
          .build(),
      )
    } catch (error: Exception) {
      Log.w(TAG, "embedded picker start failed ${error.javaClass.simpleName}")
      unavailable("start")
    }
  }

  private fun unavailable(reason: String) {
    if (ended) return
    ended = true
    onUnavailable(mapOf("reason" to reason))
  }

  /** The sheet's Add button: copies the photos selected so far. A second call copies nothing. */
  fun add() {
    deliver()
  }

  /**
   * The grants last only while the session is open, so the copy runs before JavaScript closes the
   * sheet. It runs off the main thread: ten full-size photos can take longer than a frame budget.
   * `take` hands the selection over once, so a second Add never copies the photos twice.
   */
  private fun deliver() {
    if (ended) return
    val uris = selection.take() ?: return
    ended = true
    val app = context.applicationContext
    Thread {
      val id = try {
        ShareStore.intakeContent(app, uris, ContentRoute.mimeHint("image/*"))
      } catch (_: Exception) {
        null
      }
      Handler(Looper.getMainLooper()).post { onPicked(if (id == null) emptyMap() else mapOf("id" to id)) }
    }.start()
  }
}
