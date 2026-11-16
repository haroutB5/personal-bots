package expo.modules.hbotscamera

import java.io.File
import java.util.UUID

/** One camera launch, committed before the intent fires so a recreated activity still names its chat. */
data class CameraLaunch(val owner: String, val path: String, val at: Long)

/** Capture files no launch points to are old, unreachable photos after this long. */
private const val CAPTURE_KEEP_MS = 24L * 60 * 60 * 1000

/**
 * What a claim answers. A photo belongs to the chat that asked; a launch is either still another
 * chat's or gone, so a claimed photo can never be handed out twice.
 */
sealed interface CameraClaim {
  data class Photo(val file: File, val bytes: Long) : CameraClaim
  data object Empty : CameraClaim
  data class Other(val owner: String) : CameraClaim
}

/** The durable launch record. SharedPreferences in the module, a map in the JVM tests. */
interface LaunchRecords {
  fun read(): CameraLaunch?

  fun write(record: CameraLaunch?)
}

/**
 * The one camera launch and the file it will fill. `begin` overwrites the previous launch and
 * deletes its file; `claim` answers a chat once and clears the record. Every decision lives here
 * so the behaviour tests on the JVM, away from the Android lifecycle.
 */
class CameraLaunchStore(private val records: LaunchRecords, private val dir: File) {
  /** Starts a launch for this chat and returns the file the camera writes. */
  fun begin(owner: String, at: Long): File {
    records.read()?.let { owned(it.path)?.delete() }
    dir.mkdirs()
    val file = File(dir, "${UUID.randomUUID()}.jpg")
    records.write(CameraLaunch(owner, file.path, at))
    return file
  }

  /** A launch this chat opened returns its photo or an empty file; another chat's stays put. */
  fun claim(owner: String): CameraClaim? {
    val record = records.read() ?: return null
    if (record.owner != owner) return CameraClaim.Other(record.owner)
    records.write(null)
    val file = owned(record.path) ?: return CameraClaim.Empty
    if (!file.isFile || file.length() == 0L) {
      file.delete()
      return CameraClaim.Empty
    }
    return CameraClaim.Photo(file, file.length())
  }

  /** The camera never opened: forget the launch and its file. */
  fun abandon() {
    val record = records.read() ?: return
    drop(record)
  }

  /** The record still waiting for its composer, without consuming it. */
  fun peek(): CameraLaunch? = records.read()

  /** Its chat no longer exists: forget the launch and delete its file, never another chat's. */
  fun discard(owner: String) {
    val record = records.read() ?: return
    if (record.owner != owner) return
    drop(record)
  }

  /** Deletes capture files older than [maxAgeMs] that no recorded launch points to. */
  fun prune(now: Long, maxAgeMs: Long = CAPTURE_KEEP_MS) {
    val keep = records.read()?.let { owned(it.path) }?.path
    val cutoff = now - maxAgeMs
    dir.listFiles()?.forEach { file ->
      // The record is canonical, and on a device this folder is reached through /data/user/0.
      val target = runCatching { file.canonicalFile }.getOrNull() ?: return@forEach
      if (target.isFile && target.path != keep && target.lastModified() < cutoff) target.delete()
    }
  }

  private fun drop(record: CameraLaunch) {
    records.write(null)
    owned(record.path)?.delete()
  }

  /** A recorded path counts only inside this store's folder, so a tampered record deletes nothing. */
  private fun owned(path: String): File? {
    val root = runCatching { dir.canonicalFile }.getOrNull() ?: return null
    val target = runCatching { File(path).canonicalFile }.getOrNull() ?: return null
    return if (target.parentFile == root) target else null
  }
}
