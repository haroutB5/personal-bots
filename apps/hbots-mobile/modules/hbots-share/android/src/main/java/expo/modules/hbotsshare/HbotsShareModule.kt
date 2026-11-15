package expo.modules.hbotsshare

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

/**
 * The file a file:// uri names, only when it sits inside `cacheDir` or one of `roots`. The camera
 * module keeps its captured photo in `filesDir/camera`; every picker still lands in cache.
 */
internal fun cachedFile(cacheDir: File, uri: String, vararg roots: File): File? {
  val parsed = try {
    URI(uri)
  } catch (_: Exception) {
    return null
  }
  if (parsed.scheme != "file" || parsed.path == null) return null
  val file = runCatching { File(parsed.path).canonicalFile }.getOrNull() ?: return null
  if (!file.isFile) return null
  val allowed = (listOf(cacheDir) + roots).any { root ->
    runCatching { file.path.startsWith(root.canonicalFile.path + File.separator) }.getOrDefault(false)
  }
  return if (allowed) file else null
}

class HbotsShareModule : Module() {
  private fun app() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("HbotsShare")

    /** The payload JSON the share activity wrote for this id, or null. */
    Function("read") { id: String ->
      val context = app()
      if (context == null) null else ShareStore.read(context, id)
    }

    /** Drops the copied files once they are queued or the picker closes. */
    Function("discard") { id: String ->
      val context = app()
      if (context != null) ShareStore.discard(context, id)
    }

    /** App start: drops every intake an earlier run left, keeping the one this launch opens. */
    Function("discardAllExcept") { keep: String? ->
      val context = app()
      if (context != null) ShareStore.discardAllExcept(context, keep)
    }

    /**
     * Wraps the composer's TextInput: a hardware Enter sends (Shift Enter is a line break) and a
     * keyboard image lands in the share intake dir, to be read like a shared image.
     */
    View(HbotsComposerHostView::class) {
      Events("onEnterSend", "onContent")
    }

    /**
     * Shrinks a photo the composer just took in (see PhotoShrink). Reads files in this app's cache,
     * where every picker and the share intake put their copies, and the camera module's capture.
     * Null keeps the original.
     */
    AsyncFunction("shrinkPhoto") { uri: String, mimeType: String ->
      val context = app() ?: return@AsyncFunction null
      // Same folder hbots-camera writes its launch into.
      val cameraDir = File(context.filesDir, "camera")
      val source = cachedFile(context.cacheDir, uri, cameraDir) ?: return@AsyncFunction null
      val shrunk = (
        try {
          PhotoShrink.shrink(source, mimeType)
        } catch (_: Exception) {
          null
        } catch (_: OutOfMemoryError) {
          null
        }
      ) ?: return@AsyncFunction null
      // A camera capture is single use: the draft now points at the shrunk copy.
      if (source.path.startsWith(cameraDir.canonicalFile.path + File.separator)) source.delete()
      mapOf(
        "uri" to Uri.fromFile(shrunk.file).toString(),
        "width" to shrunk.width,
        "height" to shrunk.height,
        "bytes" to shrunk.file.length(),
      )
    }

    /**
     * The mean luma of a captured photo, 0 (black) to 1 (white), for the in-app shutter's
     * black-frame guard. Null when the module cannot read the file.
     */
    AsyncFunction("photoMeanLuma") { uri: String ->
      val context = app() ?: return@AsyncFunction null
      val source = cachedFile(context.cacheDir, uri) ?: return@AsyncFunction null
      try {
        PhotoShrink.lumaOf(source)
      } catch (_: Exception) {
        null
      } catch (_: OutOfMemoryError) {
        null
      }
    }

    /** Whether the plus sheet can embed the system photo picker on this phone. */
    Function("embeddedPickerAvailable") {      val context = app()
      context != null && HbotsPhotoStripView.available(context)
    }

    View(HbotsPhotoStripView::class) {
      Events("onPicked", "onUnavailable")
    }
  }
}
