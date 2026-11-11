package expo.modules.hbotsshare

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Receives SEND, SEND_MULTIPLE and PROCESS_TEXT ("Ask hbots"). It has no UI: it
 * copies the shared items off the main thread, then opens hbots on
 * hbots://share/<id>, where the bot picker shows. Nothing is sent from here.
 */
class ShareActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val received = intent
    val context = applicationContext
    Thread {
      val id = try {
        ShareStore.intake(context, received)
      } catch (_: Exception) {
        null
      }
      runOnUiThread {
        if (id != null) {
          val open = Intent(Intent.ACTION_VIEW, Uri.parse("hbots://share/$id"))
            .setPackage(packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
          startActivity(open)
        }
        finish()
      }
    }.start()
  }
}
