package expo.modules.hbotsnotify

import android.app.NotificationManager
import android.content.Context
import android.util.Log

/**
 * Takes our notifications out of the shade when what they say is no longer true or no longer allowed:
 * the chat was opened (a question answered in the app must not stay as a button), the bot's previews
 * were switched off, or the app lock was turned on. Without FCM there is no cancel push, so the phone
 * does it itself. The "bots working" notice is never touched here.
 */
object ShadeCleanup {
  private const val TAG = "HbotsNotify"

  sealed interface Scope {
    data object Nothing : Scope
    data object Everything : Scope
    data class Bots(val ids: Set<String>) : Scope
  }

  /** Our message notifications carry the tag of a server id. Anything else (the working notice) does not. */
  internal fun isMessage(tag: String?): Boolean = tag != null && tag.startsWith(NotificationSender.TAG_PREFIX)

  internal fun belongsToChat(tag: String?, group: String?, threadId: String): Boolean =
    isMessage(tag) && threadId.isNotEmpty() && group == "chat.$threadId"

  internal fun belongsToBot(tag: String?, channelId: String?, botId: String): Boolean =
    isMessage(tag) && channelId == NotificationPlanner.botChannelId(botId)

  /**
   * What a policy change leaves behind. Turning the lock on clears every message. A bot that now hides
   * previews clears that bot's. A bot that was not known before was already shown without content.
   */
  fun scopeAfter(before: NotifyPolicy, after: NotifyPolicy): Scope {
    if (!before.appLockOn && after.appLockOn) return Scope.Everything
    val nowHidden = after.bots.filter { (id, info) -> info.hidePreviews && before.bots[id]?.hidePreviews == false }.keys
    return if (nowHidden.isEmpty()) Scope.Nothing else Scope.Bots(nowHidden)
  }

  fun cancelChat(context: Context, threadId: String) = cancelWhere(context) { tag, notification ->
    belongsToChat(tag, notification.group, threadId)
  }

  fun cancelScope(context: Context, scope: Scope) {
    when (scope) {
      Scope.Nothing -> Unit
      Scope.Everything -> cancelWhere(context) { tag, _ -> isMessage(tag) }
      is Scope.Bots -> cancelWhere(context) { tag, notification ->
        scope.ids.any { belongsToBot(tag, notification.channelId, it) }
      }
    }
  }

  private fun cancelWhere(context: Context, matches: (String?, android.app.Notification) -> Boolean) {
    try {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      for (active in manager.activeNotifications) {
        if (matches(active.tag, active.notification)) manager.cancel(active.tag, active.id)
      }
    } catch (cause: RuntimeException) {
      Log.i(TAG, "shade cleanup skipped ${cause.javaClass.simpleName}")
    }
  }
}
