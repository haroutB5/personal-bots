package expo.modules.hbotsshare

import java.io.File

/**
 * The draft's own copy of a camera capture. The camera module keeps its file in filesDir/camera
 * under the launch record; once this copy exists the capture file can go, so a sent or abandoned
 * draft never leaves a file in the camera folder.
 */
internal object CameraDraftFile {
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
}
