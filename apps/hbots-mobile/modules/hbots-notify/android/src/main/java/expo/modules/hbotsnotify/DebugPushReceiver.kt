package expo.modules.hbotsnotify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.util.concurrent.Executors

/**
 * A stand-in for an FCM message on a build with no Firebase, so the whole path after arrival
 * can be tried on an emulator. Held by the shell only (the manifest requires DUMP), and inert
 * when Firebase is compiled in, because then a real message exists.
 *
 *   adb shell am broadcast -n <app id>/expo.modules.hbotsnotify.DebugPushReceiver \
 *     -a expo.modules.hbotsnotify.DEBUG_PUSH --es kind chat-reply --es notificationId N \
 *     --es botId B --es threadId T --es v 1
 */
class DebugPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (BuildConfig.FCM_CONFIGURED) return
    if (intent.action != ACTION) return
    val data = listOf("kind", "notificationId", "botId", "threadId", "v").associateWith { intent.getStringExtra(it) }
    val pending = goAsync()
    val app = context.applicationContext
    EXECUTOR.execute {
      try {
        PushIngest.handle(app, data)
      } catch (error: Throwable) {
        Log.w("HbotsNotify", "debug push failed ${error.javaClass.simpleName}")
      } finally {
        pending.finish()
      }
    }
  }

  private companion object {
    const val ACTION = "expo.modules.hbotsnotify.DEBUG_PUSH"
    val EXECUTOR = Executors.newSingleThreadExecutor()
  }
}
