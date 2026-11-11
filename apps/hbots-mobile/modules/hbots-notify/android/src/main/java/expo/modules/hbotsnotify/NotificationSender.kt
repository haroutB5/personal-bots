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

  /**
   * A notification is found by its tag, which is the server id itself, so two ids can never share a slot.
   * (A hash of the id could.) The numeric id is the same for all of them.
   */
  const val SLOT = 1
  const val TAG_PREFIX = "n."
  fun tagFor(notificationId: String): String = "$TAG_PREFIX$notificationId"

  /**
   * A PendingIntent is told apart by its data, not its extras. A data URI that holds the id and the
   * button makes each button its own PendingIntent, with no request code to collide.
   */
  internal fun buttonKey(notificationId: String, slot: String): String =
    "hbots-action://notification/${PathSegment.encode(notificationId)}/$slot"

  internal fun canPost(context: Context): Boolean {
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
    NotificationManagerCompat.from(context).cancel(tagFor(notificationId), SLOT)
  }

  fun cancelAll(context: Context) {
    NotificationManagerCompat.from(context).cancelAll()
  }

  private fun notify(context: Context, plan: NotificationPlan, notification: Notification) {
    try {
      NotificationManagerCompat.from(context).notify(tagFor(plan.notificationId), SLOT, notification)
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
    // A launch intent has no data, so give it a unique one. A deep link is already specific to its chat.
    if (intent.data == null) intent.setData(Uri.parse(buttonKey(plan.notificationId, "open")))
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
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
    if (action.kind == InlineAction.OPEN) return openAction(context, plan, action, index)
    val reply = action.kind == InlineAction.REPLY
    val intent = actionIntent(context, plan, if (reply) ACTION_REPLY else ACTION_ANSWER, action.choice)
      .setData(Uri.parse(buttonKey(plan.notificationId, "a$index")))
    // A RemoteInput result is written into the intent, so that one must be mutable.
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (reply) mutableFlag() else PendingIntent.FLAG_IMMUTABLE
    val pending = PendingIntent.getBroadcast(context, 0, intent, flags)
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

  /**
   * A button that opens the app at the chat. It is used when Reply and Answer cannot ask for the device
   * credential (before Android 12). It sends nothing, so it needs no lock screen check.
   */
  private fun openAction(context: Context, plan: NotificationPlan, action: PlanAction, index: Int): NotificationCompat.Action {
    val intent = plan.deepLink?.let { Intent(Intent.ACTION_VIEW, Uri.parse(it)).setPackage(context.packageName) }
      ?: context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent()
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    if (intent.data == null) intent.setData(Uri.parse(buttonKey(plan.notificationId, "o$index")))
    val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return NotificationCompat.Action.Builder(0, action.label, pending).setShowsUserInterface(true).build()
  }

  private fun retryAction(context: Context, plan: NotificationPlan): NotificationCompat.Action {
    val pending = PendingIntent.getBroadcast(
      context,
      0,
      actionIntent(context, plan, ACTION_RETRY, null).setData(Uri.parse(buttonKey(plan.notificationId, "retry"))),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Action.Builder(0, "Retry", pending)
      .setShowsUserInterface(false)
      .setAuthenticationRequired(true)
      .build()
  }

  private fun mutableFlag(): Int = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
}
