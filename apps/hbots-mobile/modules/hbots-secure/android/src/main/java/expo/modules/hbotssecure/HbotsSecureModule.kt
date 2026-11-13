package expo.modules.hbotssecure

import android.net.Uri
import android.os.Build
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.InputStream
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher

/**
 * One thread each for chat-copy reads and writes, for the whole process. A save of a large
 * chat can then never hold up the read of the chat being opened, or any other module call
 * on the shared async queue. Writes stay in order on theirs.
 */
private object CacheQueues {
  private fun single(name: String) =
    CoroutineScope(
      SupervisorJob() +
        Executors.newSingleThreadExecutor { task -> Thread(task, name).apply { isDaemon = true } }
          .asCoroutineDispatcher(),
    )

  val read = single("hbots-cache-read")
  val write = single("hbots-cache-write")
}

/**
 * FLAG_SECURE while a secret or sign-in card is on screen, and for the whole
 * life of the activity while the app lock is on (see [shieldFor]). It also
 * encrypts the offline cache (see [CacheCrypto]).
 */
class HbotsSecureModule : Module() {
  private var secure = false
  private var blankInRecents = false

  private fun apply() {
    val activity = appContext.currentActivity ?: return
    val shield = shieldFor(secureScreen = secure, appLockOn = blankInRecents)
    activity.runOnUiThread {
      if (shield.flagSecure) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      if (Build.VERSION.SDK_INT >= 33) {
        activity.setRecentsScreenshotEnabled(shield.recentsScreenshotAllowed)
      }
    }
  }

  private fun open(uri: String): InputStream {
    if (uri.startsWith("content://")) {
      val resolver = appContext.reactContext?.contentResolver ?: throw java.io.IOException("no context")
      return resolver.openInputStream(Uri.parse(uri)) ?: throw java.io.IOException("no stream")
    }
    return File(Uri.parse(uri).path ?: uri).inputStream()
  }

  private fun pathOf(value: String): String =
    if (value.startsWith("file://")) Uri.parse(value).path ?: value else value

  override fun definition() = ModuleDefinition {
    Name("HbotsSecure")

    Function("setSecure") { value: Boolean ->
      secure = value
      apply()
    }

    Function("setRecentsBlanked") { blank: Boolean ->
      blankInRecents = blank
      apply()
    }

    // A recreated activity has a fresh window; shield it again as soon as it is in front.
    OnActivityEntersForeground {
      apply()
    }

    AsyncFunction("writeEncryptedTextAsync") { path: String, text: String ->
      CacheCrypto.writeText(pathOf(path), text)
    }.runOnQueue(CacheQueues.write)

    AsyncFunction("readDecryptedText") { path: String -> CacheCrypto.readText(pathOf(path)) }
      .runOnQueue(CacheQueues.read)

    AsyncFunction("encryptFile") { sourceUri: String, destination: String ->
      try {
        CacheCrypto.encryptFile(open(sourceUri), pathOf(destination))
        true
      } catch (_: Exception) {
        File(pathOf(destination)).delete()
        false
      }
    }

    AsyncFunction("decryptFile") { source: String, destination: String ->
      CacheCrypto.decryptFile(pathOf(source), pathOf(destination))
    }

    Function("deleteCacheKey") { CacheCrypto.deleteKey() }

    // Files from before encryption: deleted, not served. Returns how many it removed.
    Function("purgeLegacyPlaintext") { directories: List<String> ->
      directories.sumOf { CacheCrypto.purgeUnencrypted(File(pathOf(it))) }
    }
  }
}
