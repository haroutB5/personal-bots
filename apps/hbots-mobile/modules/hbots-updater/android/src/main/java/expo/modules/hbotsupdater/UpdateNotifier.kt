package expo.modules.hbotsupdater

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

internal const val UPDATE_RESTART_ACTION = "expo.modules.hbotsupdater.RESTART_TO_UPDATE"

object UpdateNotifier {
  private const val UPDATED_ID = 7201
  private const val READY_ID = 7202
  private const val NEEDS_PERMISSION_ID = 7204
  private const val TAG = "HbotsUpdate"
  private const val NOTIFICATION_PERMISSION_REQUEST = 7203

  @Volatile private var askedForNotifications = false

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (spec in UpdateChannels.all) {
      if (manager.getNotificationChannel(spec.id) != null) continue
      manager.createNotificationChannel(
        NotificationChannel(spec.id, spec.name, spec.importance).apply {
          description = spec.description
          setShowBadge(!spec.silent)
          enableVibration(spec.vibrate)
          if (spec.silent) setSound(null, null)
        },
      )
    }
  }

  fun requestPermission(activity: Activity?) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || activity == null) return
    if (askedForNotifications) return
    if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      return
    }
    askedForNotifications = true
    Handler(Looper.getMainLooper()).post {
      runCatching { activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST) }
    }
  }

  private fun canPost(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }
    val manager = context.getSystemService(NotificationManager::class.java) ?: return false
    return manager.areNotificationsEnabled()
  }

  private fun openApp(context: Context): PendingIntent {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.packageName)
    return PendingIntent.getActivity(
      context,
      0,
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  fun postUpdated(context: Context, versionName: String?) {
    if (!canPost(context)) return
    ensureChannel(context)
    val text =
      if (versionName.isNullOrBlank()) "Tap to open hbots." else "Now on $versionName. Tap to open hbots."
    post(context, UpdateChannels.action.id, UPDATED_ID, "hbots updated", text, openApp(context))
  }

  /** "hbots X is ready" with a Restart button: one tap installs it and brings the app back. */
  fun postRestartReady(context: Context, versionName: String) {
    if (!canPost(context)) return
    ensureChannel(context)
    val restart = PendingIntent.getBroadcast(
      context,
      READY_ID,
      Intent(context, UpdateRestartReceiver::class.java).setAction(UPDATE_RESTART_ACTION),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    post(
      context,
      UpdateChannels.action.id,
      READY_ID,
      "hbots $versionName is ready",
      "Tap Restart to update. It takes a few seconds.",
      openApp(context),
      Notification.Action.Builder(null, "Restart", restart).build(),
    )
  }

  fun reopenApp(context: Context) {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    runCatching { context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
  }

  /** Restart was tapped but the sign-in must be renewed first: opening the app finishes it. */
  fun postOpenToFinish(context: Context) {
    if (!canPost(context)) return
    ensureChannel(context)
    post(
      context,
      UpdateChannels.action.id,
      READY_ID,
      "Open hbots to finish the update",
      "Tap here. The update installs as soon as hbots opens.",
      openApp(context),
    )
  }

  fun clearUpdated(context: Context) {
    runCatching { context.getSystemService(NotificationManager::class.java)?.cancel(UPDATED_ID) }
  }

  fun postConfirmation(context: Context, confirm: Intent?) {
    if (!canPost(context)) return
    ensureChannel(context)
    val content = if (confirm != null) {
      confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      PendingIntent.getActivity(
        context,
        READY_ID,
        confirm,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    } else {
      openApp(context)
    }
    post(
      context,
      UpdateChannels.action.id,
      READY_ID,
      "Update ready",
      "Tap to finish installing the hbots update.",
      content,
    )
  }

  fun postNeedsPermission(context: Context, versionName: String) {
    if (!canPost(context)) return
    ensureChannel(context)
    post(
      context,
      UpdateChannels.action.id,
      NEEDS_PERMISSION_ID,
      "Allow hbots to install updates",
      "Update to $versionName is waiting. Tap to allow it.",
      installPermissionIntent(context),
    )
  }

  private fun installPermissionIntent(context: Context): PendingIntent {
    val intent = UpdateInstaller.installPermissionIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(
      context,
      NEEDS_PERMISSION_ID,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun post(
    context: Context,
    channelId: String,
    id: Int,
    title: String,
    text: String,
    content: PendingIntent,
    action: Notification.Action? = null,
  ) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, channelId)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
    if (action != null) builder.addAction(action)
    val notification = builder
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentTitle(title)
      .setContentText(text)
      .setAutoCancel(true)
      .setContentIntent(content)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .build()
    runCatching { manager.notify(id, notification) }
      .onFailure { Log.w(TAG, "notification failed") }
  }

  fun clear(context: Context) {
    runCatching {
      val manager = context.getSystemService(NotificationManager::class.java)
      manager?.cancel(READY_ID)
      manager?.cancel(NEEDS_PERMISSION_ID)
    }
  }
}

class UpdateRestartReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != UPDATE_RESTART_ACTION) return
    UpdateNotifier.clear(context.applicationContext)
    UpdateEngine.confirmFromNotification(context.applicationContext)
  }
}

/**
 * Runs in the new version right after Android replaces the app. The install-success broadcast
 * can die with the old process, so the reopen is done here: straight back into the app when
 * "Display over other apps" is allowed, otherwise a notification that opens it.
 */
class UpdateReplacedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val app = context.applicationContext
    if (UpdateInstaller.canReopen(app)) {
      UpdateNotifier.reopenApp(app)
    } else {
      UpdateNotifier.postUpdated(app, InstalledAppReader.read(app)?.name)
    }
  }
}
