package expo.modules.hbotsshare

import java.io.File
import java.net.URI

/** Draft copies nobody sent or removed are unreachable photos after this long. */
private const val DRAFT_KEEP_MS = 24L * 60 * 60 * 1000

/**
 * The draft's own copy of a camera capture. The camera module keeps its file in filesDir/camera
 * under the launch record; once this copy exists the capture file can go, so a sent or abandoned
 * draft never leaves a file in the camera folder.
 */
internal object CameraDraftFile {
  const val DIR = "camera-drafts"

  fun dir(cacheDir: File): File = File(cacheDir, DIR)

  /** Copies [source] into [dir] and deletes it, or returns null and keeps it when the copy fails. */
  fun adopt(source: File, dir: File): File? {
    val target = File(dir, source.name)
    return try {
      dir.mkdirs()
      source.copyTo(target, overwrite = true)
      if (source.delete()) {
        target
      } else {
        target.delete()
        null
      }
    } catch (_: Exception) {
      target.delete()
      null
    }
  }

  /**
   * A sent or removed draft lets go of its copy. Only a file inside [dir] is deleted, so a
   * picker's cache file or a path outside the draft folder is never touched.
   */
  fun discard(dir: File, uriOrPath: String): Boolean {
    val target = owned(dir, uriOrPath) ?: return false
    return !target.exists() || target.delete()
  }

  /**
   * App start: deletes copies older than [maxAgeMs] that no path in [keep] points at. A draft
   * still on screen passes its file in [keep], so its photo survives the sweep.
   */
  fun prune(
    dir: File,
    keep: Collection<String>,
    now: Long,
    maxAgeMs: Long = DRAFT_KEEP_MS,
  ) {
    val kept = keep.mapNotNull { owned(dir, it)?.path }.toSet()
    val cutoff = now - maxAgeMs
    dir.listFiles()?.forEach { file ->
      val target = runCatching { file.canonicalFile }.getOrNull() ?: return@forEach
      if (target.isFile && target.path !in kept && target.lastModified() < cutoff) target.delete()
    }
  }

  /** The path a `file://` uri names, or a raw path, only when it sits inside [dir]. */
  private fun owned(dir: File, uriOrPath: String): File? {
    val root = runCatching { dir.canonicalFile }.getOrNull() ?: return null
    val path = runCatching { URI(uriOrPath).path }.getOrNull() ?: uriOrPath
    val target = runCatching { File(path).canonicalFile }.getOrNull() ?: return null
    return if (target.parentFile == root) target else null
  }
}
