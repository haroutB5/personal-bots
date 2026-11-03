package expo.modules.hbotsupdater

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

internal const val UPDATE_IDLE_ACTION = "expo.modules.hbotsupdater.IDLE_INSTALL"

/**
 * WorkManager would add an exported JobService to the manifest. A single
 * inexact alarm survives process death and adds no exported component.
 */
object UpdateScheduler {
  private const val TAG = "HbotsUpdate"
  private const val REQUEST_CODE = 7204

  fun schedule(context: Context, attempt: Int = 0) {
    val alarm = context.getSystemService(AlarmManager::class.java) ?: return
    val pending = PendingIntent.getBroadcast(
      context,
      REQUEST_CODE,
      Intent(context, UpdateAlarmReceiver::class.java).setAction(UPDATE_IDLE_ACTION),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val delayMs = UpdateBackoff.delayMs(attempt, BuildConfig.UPDATE_IDLE_MINUTES * 60_000L)
    val at = System.currentTimeMillis() + delayMs
    Log.i(TAG, "idle alarm scheduled in ${delayMs}ms attempt=$attempt")
    runCatching { alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending) }
  }

  fun cancel(context: Context) {
    val alarm = context.getSystemService(AlarmManager::class.java) ?: return
    val pending = PendingIntent.getBroadcast(
      context,
      REQUEST_CODE,
      Intent(context, UpdateAlarmReceiver::class.java).setAction(UPDATE_IDLE_ACTION),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
    ) ?: return
    runCatching { alarm.cancel(pending) }
    pending.cancel()
  }
}

class UpdateAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    UpdateEngine.idleReached(context.applicationContext)
  }
}
