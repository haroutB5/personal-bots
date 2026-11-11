package expo.modules.hbotssecure

import android.net.Uri
import android.os.Build
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.InputStream

/**
 * FLAG_SECURE while a secret or sign-in card is on screen, and while the app
 * is in the background with the app lock on. It also holds the Keystore key
 * that encrypts the offline cache.
 */
class HbotsSecureModule : Module() {
  private var secure = false
  private var blankInRecents = false
  private var inBackground = false

  private fun apply() {
    val activity = appContext.currentActivity ?: return
    val shield = secure || (blankInRecents && inBackground)
    activity.runOnUiThread {
      if (shield) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      if (Build.VERSION.SDK_INT >= 33) {
        activity.setRecentsScreenshotEnabled(!blankInRecents)
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

    OnActivityEntersBackground {
      inBackground = true
      apply()
    }

    OnActivityEntersForeground {
      inBackground = false
      apply()
    }

    Function("writeEncryptedText") { path: String, text: String ->
      CacheCrypto.writeText(pathOf(path), text)
    }

    AsyncFunction("readDecryptedText") { path: String -> CacheCrypto.readText(pathOf(path)) }

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
  }
}
