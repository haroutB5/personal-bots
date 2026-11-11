package expo.modules.hbotsnotify

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** The one ongoing "bots working" notification on the `working` channel. */
object WorkingNotification {
  private const val TAG = "HbotsNotify"
  const val NOTIFICATION_ID = 0x4B07_0001

  /**
   * If JS stops sending (its process is frozen or gone), Android removes the notice by itself, so a
   * stale "working" row never stays. A frozen background app stops its 15 s heartbeat, so a run that lasts
   * longer than this loses its notice while the bot still works. That is a disclosed limit, accepted until
   * FCM is live. No keep-alive service is added. The real fix is server-driven start and end pushes, which
   * need no running JS: the server tells the phone when a run begins and when it ends.
   */
  const val EXPIRE_MS = 45_000L

  fun post(context: Context, plan: WorkingPlan, startedAt: Long) {
    if (!NotificationSender.canPost(context)) {
      Log.i(TAG, "working notification skipped permission off")
      return
    }
    NotifyChannels.ensureBase(context)
    val presentation = LiveUpdate.presentation(plan, Build.VERSION.SDK_INT, canPostPromoted(context))
    val notification = NotificationCompat.Builder(context, NotifyChannels.WORKING)
      .setSmallIcon(R.drawable.ic_stat_hbots)
      .setColor(0xFFC9C9C5.toInt())
      .setContentTitle(plan.title)
      .setContentText(plan.lines.firstOrNull().orEmpty())
      .setStyle(style(presentation.body))
      .setRequestPromotedOngoing(presentation.promote)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(true)
      .setWhen(startedAt)
      .setUsesChronometer(true)
      .setTimeoutAfter(EXPIRE_MS)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion(context, plan))
      .setContentIntent(openApp(context))
      .addAction(0, "Stop", openStop(context))
      .build()
    try {
      NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
    } catch (_: SecurityException) {
      Log.i(TAG, "working notification refused by the system")
    }
  }

  fun cancel(context: Context) {
    NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
  }

  private fun canPostPromoted(context: Context): Boolean =
    Build.VERSION.SDK_INT >= LiveUpdate.MIN_SDK && NotificationManagerCompat.from(context).canPostPromotedNotifications()

  private fun style(body: WorkingBody): NotificationCompat.Style = when (body) {
    is WorkingBody.Inbox -> NotificationCompat.InboxStyle().also { inbox ->
      body.lines.forEach { inbox.addLine(it) }
      body.summary?.let { inbox.setSummaryText(it) }
    }
    is WorkingBody.BigText -> NotificationCompat.BigTextStyle().bigText(body.text)
  }

  private fun publicVersion(context: Context, plan: WorkingPlan) =
    NotificationCompat.Builder(context, NotifyChannels.WORKING)
      .setSmallIcon(R.drawable.ic_stat_hbots)
      .setColor(0xFFC9C9C5.toInt())
      .setContentTitle(WorkingPlanner.PUBLIC_TITLE)
      .setContentText(plan.publicText)
      .build()

  private fun openApp(context: Context): PendingIntent {
    val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(context, NOTIFICATION_ID, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  /** The Stop button opens the list inside the app, so the app lock decides who may use it. */
  private fun openStop(context: Context): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(WorkingPlanner.STOP_LINK))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(context, NOTIFICATION_ID + 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }
}

/** Runs the gate's decisions on the main thread: posts, defers and clears. */
object WorkingController {
  private val gate = WorkingGate()
  private val handler = Handler(Looper.getMainLooper())
  private var timer: Runnable? = null

  fun update(context: Context, bots: List<WorkingBot>) {
    val app = context.applicationContext
    handler.post { run(app, gate.update(System.currentTimeMillis(), bots)) }
  }

  fun clear(context: Context) {
    val app = context.applicationContext
    handler.post { run(app, gate.clear()) }
  }

  /** Sign-out: forget everything, cancel any deferred post, remove the notice. */
  fun reset(context: Context) {
    val app = context.applicationContext
    handler.post {
      cancelTimer()
      gate.reset()
      WorkingNotification.cancel(app)
    }
  }

  private fun run(context: Context, decision: WorkingDecision) {
    when (decision) {
      WorkingDecision.Nothing -> Unit
      is WorkingDecision.Post -> {
        cancelTimer()
        val policy = PolicyStore.read(context)
        WorkingPlanner.plan(decision.bots, policy)?.let { WorkingNotification.post(context, it, decision.startedAt) }
      }
      is WorkingDecision.Defer -> {
        cancelTimer()
        val next = Runnable { run(context, gate.due(System.currentTimeMillis())) }
        timer = next
        handler.postDelayed(next, decision.delayMs)
      }
      WorkingDecision.Clear -> {
        cancelTimer()
        WorkingNotification.cancel(context)
      }
    }
  }

  private fun cancelTimer() {
    timer?.let { handler.removeCallbacks(it) }
    timer = null
  }
}
