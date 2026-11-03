package expo.modules.hbotsupdater

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

object UpdateNotifier {
  private const val CHANNEL = "app_updates"
  private const val UPDATED_ID = 7201
  private const val READY_ID = 7202
  private const val TAG = "HbotsUpdate"
  private const val NOTIFICATION_PERMISSION_REQUEST = 7203

  @Volatile private var askedForNotifications = false

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Silent hbots updates"
          setSound(null, null)
          enableVibration(false)
          setShowBadge(false)
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
    val text = if (versionName.isNullOrBlank()) "hbots is up to date." else "hbots updated to $versionName."
    post(context, UPDATED_ID, "hbots updated", text, openApp(context))
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
    post(context, READY_ID, "Update ready", "Tap to finish installing the hbots update.", content)
  }

  private fun post(context: Context, id: Int, title: String, text: String, content: PendingIntent) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
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
      context.getSystemService(NotificationManager::class.java)?.cancel(READY_ID)
    }
  }
}
