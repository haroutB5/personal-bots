package expo.modules.hbotscamera

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

private const val REQUEST = 0x4842
private const val PREFS = "hbots_camera_launch"

/** The launch record survives process death in SharedPreferences, with the file beside it. */
private class PrefsRecords(private val prefs: SharedPreferences) : LaunchRecords {
  override fun read(): CameraLaunch? {
    val owner = prefs.getString("owner", null) ?: return null
    val path = prefs.getString("path", null) ?: return null
    return CameraLaunch(owner, path, prefs.getLong("at", 0L))
  }

  override fun write(record: CameraLaunch?) {
    val editor = prefs.edit()
    if (record == null) {
      editor.clear()
    } else {
      editor
        .putString("owner", record.owner)
        .putString("path", record.path)
        .putLong("at", record.at)
    }
    editor.commit()
  }
}

/**
 * The system camera's own launch, so the photo belongs to the chat that asked for it even when
 * Android destroys the activity or kills the process while the camera is in front.
 */
class HbotsCameraModule : Module() {
  private var waiting: Promise? = null

  private fun context(): Context? = appContext.reactContext?.applicationContext

  private fun store(context: Context) = CameraLaunchStore(
    PrefsRecords(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)),
    File(context.filesDir, "camera"),
  )

  /**
   * Length, picture size and a small JPEG still for a picked video, for the
   * composer chip. The still goes to the cache folder, which sign-out wipes.
   */
  private fun videoInfo(uri: String): Map<String, Any?>? {
    val context = context() ?: return null
    val retriever = MediaMetadataRetriever()
    return try {
      val parsed = Uri.parse(uri)
      if (parsed.scheme == "content") retriever.setDataSource(context, parsed)
      else retriever.setDataSource(parsed.path ?: uri)
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      if (width == null || height == null) return null
      // A frame a little in, so a recording that starts on a black screen still shows something.
      val at = minOf(500_000L, (durationMs ?: 0L) * 500L)
      val still = retriever.getScaledFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 240, 240)
      var thumbnailUri: String? = null
      if (still != null) {
        val dir = File(context.cacheDir, "hbots-video-thumbs").apply { mkdirs() }
        val file = File(dir, "${Integer.toHexString(uri.hashCode())}-${System.currentTimeMillis()}.jpg")
        file.outputStream().use { still.compress(Bitmap.CompressFormat.JPEG, 80, it) }
        still.recycle()
        thumbnailUri = Uri.fromFile(file).toString()
      }
      val turned = rotation == 90 || rotation == 270
      mapOf(
        "durationMs" to durationMs?.toDouble(),
        "width" to if (turned) height else width,
        "height" to if (turned) width else height,
        "thumbnailUri" to thumbnailUri,
      )
    } catch (_: Exception) {
      null
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HbotsCamera")

    /** Null when Android cannot read the file as a video. */
    AsyncFunction("videoInfo") { uri: String -> videoInfo(uri) }

    // App start: drop camera files no launch can reach any more.
    OnCreate {
      context()?.let { store(it).prune(System.currentTimeMillis()) }
    }

    /** True when the camera saved a photo, false when the user backed out. */
    AsyncFunction("launch") { owner: String, promise: Promise ->
      val context = context()
        ?: return@AsyncFunction promise.reject("E_NO_ACTIVITY", "No app context.", null)
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("E_NO_ACTIVITY", "No activity to open the camera from.", null)
      val store = store(context)
      val file = store.begin(owner, System.currentTimeMillis())
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.HbotsCameraFileProvider", file)
      val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        .putExtra(MediaStore.EXTRA_OUTPUT, uri)
        .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      waiting = promise
      try {
        activity.startActivityForResult(intent, REQUEST)
      } catch (error: ActivityNotFoundException) {
        waiting = null
        store.abandon()
        promise.reject("E_NO_CAMERA_APP", "No camera app opened the capture intent.", error)
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST) return@OnActivityResult
      val saved = payload.resultCode == Activity.RESULT_OK
      // Backing out of the camera drops the launch, so no later claim can turn it into a draft.
      if (!saved) context()?.let { store(it).abandon() }
      val pending = waiting ?: return@OnActivityResult
      waiting = null
      pending.resolve(saved)
    }

    /** The photo this chat launched, once; null when no launch is recorded. */
    AsyncFunction("claim") { owner: String ->
      val context = context() ?: return@AsyncFunction null
      when (val claim = store(context).claim(owner)) {
        null -> null
        CameraClaim.Empty -> mapOf("status" to "empty")
        is CameraClaim.Other -> mapOf("status" to "other", "owner" to claim.owner)
        is CameraClaim.Photo -> mapOf(
          "status" to "photo",
          "uri" to Uri.fromFile(claim.file).toString(),
          "bytes" to claim.bytes,
        )
      }
    }

    /** The launch still waiting for a composer, without consuming it. */
    AsyncFunction("pending") {
      val context = context() ?: return@AsyncFunction null
      store(context).peek()?.let { mapOf("owner" to it.owner, "at" to it.at) }
    }

    /** Its chat no longer exists: drop this launch and its file. */
    AsyncFunction("discard") { owner: String ->
      val context = context() ?: return@AsyncFunction
      store(context).discard(owner)
    }
  }
}
