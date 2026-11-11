package expo.modules.hbotsshare

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Copies what another app shared into this app's cache. The read grant on a
 * content:// uri ends with the share activity, so the bytes are copied while it
 * is alive. The caps here only stop a copy from running away; the app applies the
 * same caps again and gives each refusal its reason.
 */
internal object ShareStore {
  const val MAX_ITEMS = 10
  const val MAX_BYTES = 25L * 1024 * 1024
  private const val DIR = "share-intake"
  private const val STALE_MS = 24L * 60 * 60 * 1000
  private val SAFE_ID = Regex("^[A-Za-z0-9-]{8,64}$")

  fun root(context: Context): File = File(context.cacheDir, DIR)

  fun validId(id: String): Boolean = SAFE_ID.matches(id)

  fun dirFor(context: Context, id: String): File? =
    if (validId(id)) File(root(context), id) else null

  fun discard(context: Context, id: String) {
    dirFor(context, id)?.deleteRecursively()
  }

  /** Removes intakes nobody opened. */
  fun sweep(context: Context) {
    val cutoff = System.currentTimeMillis() - STALE_MS
    root(context).listFiles()?.forEach { if (it.lastModified() < cutoff) it.deleteRecursively() }
  }

  fun read(context: Context, id: String): String? {
    val dir = dirFor(context, id) ?: return null
    val file = File(dir, "payload.json")
    return if (file.isFile) file.readText() else null
  }

  /** Reads the intent, copies its streams, and writes payload.json. Returns the new id, or null when there is nothing to share. */
  fun intake(context: Context, intent: Intent): String? {
    sweep(context)
    val id = UUID.randomUUID().toString()
    val dir = File(root(context), id)
    if (!dir.mkdirs()) return null
    val items = JSONArray()
    var count = 0
    var ask = false
    when (intent.action) {
      Intent.ACTION_PROCESS_TEXT -> {
        ask = true
        val selected = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
        if (selected != null) {
          items.put(JSONObject().put("kind", "text").put("text", selected))
          count = 1
        }
      }
      Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> {
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (text != null) {
          items.put(JSONObject().put("kind", "text").put("text", text))
          count += 1
        }
        for (uri in streams(intent)) {
          count += 1
          // One past the cap is enough for the app to see "too many".
          if (items.length() > MAX_ITEMS) continue
          items.put(copy(context, dir, uri, intent.type, items.length()))
        }
      }
    }
    if (count == 0) {
      dir.deleteRecursively()
      return null
    }
    val payload = JSONObject().put("ask", ask).put("count", count).put("items", items)
    File(dir, "payload.json").writeText(payload.toString())
    return id
  }

  @Suppress("DEPRECATION")
  private fun streams(intent: Intent): List<Uri> {
    val found = ArrayList<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      val list: List<Uri>? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
      if (list != null) found.addAll(list)
    } else {
      val one: Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)
      if (one != null) found.add(one)
    }
    return found
  }

  private fun copy(context: Context, dir: File, uri: Uri, intentType: String?, index: Int): JSONObject {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri) ?: intentType ?: "application/octet-stream"
    val name = displayName(resolver, uri) ?: "Shared ${index + 1}"
    val item = JSONObject().put("kind", "stream").put("name", name).put("mime", mime)
    // Only content:// uris are read: a file:// uri from another app could name this app's own files.
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) {
      return item.put("uri", JSONObject.NULL).put("bytes", MAX_BYTES + 1)
    }
    val target = File(dir, "$index-${safeName(name)}")
    var copied = 0L
    var overCap = false
    try {
      resolver.openInputStream(uri)?.use { input ->
        target.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            copied += read
            if (copied > MAX_BYTES) {
              overCap = true
              break
            }
            output.write(buffer, 0, read)
          }
        }
      }
    } catch (_: Exception) {
      target.delete()
      return item.put("uri", JSONObject.NULL).put("bytes", MAX_BYTES + 1)
    }
    if (overCap) {
      target.delete()
      return item.put("uri", JSONObject.NULL).put("bytes", MAX_BYTES + 1)
    }
    return item.put("uri", Uri.fromFile(target).toString()).put("bytes", copied)
  }

  private fun displayName(resolver: ContentResolver, uri: Uri): String? =
    try {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      }
    } catch (_: Exception) {
      null
    }

  private fun safeName(name: String): String =
    name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifEmpty { "file" }
}
