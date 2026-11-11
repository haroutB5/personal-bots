package expo.modules.hbotsnotify

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput

/** Turns a plan into a system notification. Everything it shows came from the plan. */
object NotificationSender {
  private const val TAG = "HbotsNotify"
  const val KEY_REPLY = "hbots_reply_text"
  const val ACTION_REPLY = "expo.modules.hbotsnotify.REPLY"
  const val ACTION_ANSWER = "expo.modules.hbotsnotify.ANSWER"
  const val ACTION_RETRY = "expo.modules.hbotsnotify.RETRY"
  const val EXTRA_NOTIFICATION = "notificationId"
  const val EXTRA_KIND = "kind"
  const val EXTRA_BOT = "botId"
  const val EXTRA_THREAD = "threadId"
  const val EXTRA_CHOICE = "choice"
  private const val NOTICE_MS = 4_000L

  fun androidId(notificationId: String): Int = notificationId.hashCode()

  private fun canPost(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 33 &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return false
    return NotificationManagerCompat.from(context).areNotificationsEnabled()
  }

  fun post(context: Context, plan: NotificationPlan, retry: Boolean = false, quiet: Boolean = false) {
    if (!canPost(context)) {
      Log.i(TAG, "notification skipped permission off")
      return
    }
    NotifyChannels.ensureFor(context, plan)
    val builder = base(context, plan, plan.title, plan.text, quiet)
    val me = Person.Builder().setName("You").build()
    val sender = Person.Builder().setName(plan.title).build()
    builder.setStyle(NotificationCompat.MessagingStyle(me).addMessage(plan.text, System.currentTimeMillis(), sender))
    plan.errorLine?.let { builder.setSubText(it) }
    for ((index, action) in plan.actions.withIndex()) builder.addAction(actionFor(context, plan, action, index))
    if (retry) builder.addAction(retryAction(context, plan))
    notify(context, plan, builder.build())
  }

  /** One short line that replaces the notification. `autoCancel` removes it by itself. */
  fun postNotice(context: Context, plan: NotificationPlan, text: String, autoCancel: Boolean, opensApp: Boolean) {
    if (!canPost(context)) return
    NotifyChannels.ensureFor(context, plan)
    val shown = if (opensApp) plan.copy(deepLink = null) else plan
    val builder = base(context, shown, plan.title, text, quiet = true)
    if (autoCancel) builder.setTimeoutAfter(NOTICE_MS)
    notify(context, plan, builder.build())
  }

  fun cancel(context: Context, notificationId: String) {
    NotificationManagerCompat.from(context).cancel(androidId(notificationId))
  }

  fun cancelAll(context: Context) {
    NotificationManagerCompat.from(context).cancelAll()
  }

  private fun notify(context: Context, plan: NotificationPlan, notification: Notification) {
    try {
      NotificationManagerCompat.from(context).notify(androidId(plan.notificationId), notification)
    } catch (_: SecurityException) {
      Log.i(TAG, "notification refused by the system")
    }
  }

  private fun base(context: Context, plan: NotificationPlan, title: String, text: String, quiet: Boolean) =
    NotificationCompat.Builder(context, plan.channelId)
      .setSmallIcon(R.drawable.ic_stat_hbots)
      .setColor(0xFFC9C9C5.toInt())
      .setContentTitle(title)
      .setContentText(text)
      .setAutoCancel(true)
      .setOnlyAlertOnce(quiet)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion(context, plan))
      .setContentIntent(openIntent(context, plan))
      .also { builder -> plan.groupKey?.let { builder.setGroup(it) } }

  /** What the lock screen shows: no bot name, no text, no buttons. */
  private fun publicVersion(context: Context, plan: NotificationPlan): Notification =
    NotificationCompat.Builder(context, plan.channelId)
      .setSmallIcon(R.drawable.ic_stat_hbots)
      .setColor(0xFFC9C9C5.toInt())
      .setContentTitle(NotificationPlanner.GENERIC_TITLE)
      .setContentText("1 new notification")
      .build()

  private fun openIntent(context: Context, plan: NotificationPlan): PendingIntent {
    val intent = plan.deepLink?.let { Intent(Intent.ACTION_VIEW, Uri.parse(it)).setPackage(context.packageName) }
      ?: context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent()
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(
      context,
      androidId(plan.notificationId),
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun actionIntent(context: Context, plan: NotificationPlan, action: String, choice: String?): Intent =
    Intent(action).setComponent(ComponentName(context, NotificationActionReceiver::class.java))
      .setPackage(context.packageName)
      .putExtra(EXTRA_NOTIFICATION, plan.notificationId)
      .putExtra(EXTRA_KIND, plan.kind.wire)
      .putExtra(EXTRA_BOT, plan.botId)
      .putExtra(EXTRA_THREAD, plan.groupKey?.removePrefix("chat.").orEmpty())
      .also { if (choice != null) it.putExtra(EXTRA_CHOICE, choice) }

  private fun actionFor(context: Context, plan: NotificationPlan, action: PlanAction, index: Int): NotificationCompat.Action {
    val reply = action.kind == InlineAction.REPLY
    val intent = actionIntent(context, plan, if (reply) ACTION_REPLY else ACTION_ANSWER, action.choice)
    // A RemoteInput result is written into the intent, so that one must be mutable.
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (reply) mutableFlag() else PendingIntent.FLAG_IMMUTABLE
    val pending = PendingIntent.getBroadcast(context, androidId(plan.notificationId) * 31 + index + 1, intent, flags)
    val builder = NotificationCompat.Action.Builder(0, action.label, pending)
      .setShowsUserInterface(false)
      // Android 12 and later ask for the lock screen first, so a locked phone cannot send.
      .setAuthenticationRequired(true)
    if (reply) {
      builder.setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      builder.addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel(action.label).build())
    }
    return builder.build()
  }

  private fun retryAction(context: Context, plan: NotificationPlan): NotificationCompat.Action {
    val pending = PendingIntent.getBroadcast(
      context,
      androidId(plan.notificationId) * 31 + 99,
      actionIntent(context, plan, ACTION_RETRY, null),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Action.Builder(0, "Retry", pending)
      .setShowsUserInterface(false)
      .setAuthenticationRequired(true)
      .build()
  }

  private fun mutableFlag(): Int = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
}
