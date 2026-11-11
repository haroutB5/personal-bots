package expo.modules.hbotsvoice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class VoiceCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      CallNotification.ACTION_START -> {
        promote(intent.getStringExtra(CallNotification.EXTRA_BOT_NAME).orEmpty())
        begin()
      }
      CallNotification.ACTION_HANGUP -> VoiceRuntime.dispatch(CallEvent.Stop(EndReason.NOTIFICATION_HANGUP))
      else -> stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun begin() {
    val state = VoiceRuntime.state
    if (state !is CallState.Starting) {
      stopSelf()
      return
    }
    if (VoiceRuntime.openEngine(applicationContext)) {
      VoiceRuntime.dispatch(CallEvent.ServiceStarted)
    } else {
      VoiceRuntime.dispatch(CallEvent.Stop(EndReason.FOCUS_LOST))
    }
  }

  private fun promote(botName: String) {
    val notification = buildNotification(this, botName)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(CallNotification.NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(CallNotification.NOTIFICATION_ID, notification)
    }
  }

  override fun onDestroy() {
    VoiceRuntime.closeEngine()
    VoiceRuntime.dispatch(CallEvent.ServiceDestroyed)
    super.onDestroy()
  }

  companion object {
    fun ensureChannel(context: Context) {
      val spec = CallNotification.channel
      val channel = NotificationChannel(spec.id, spec.name, NotificationManager.IMPORTANCE_LOW).apply {
        description = spec.description
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        if (spec.silent) {
          setSound(null, null)
          enableVibration(false)
        }
      }
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun deleteChannel(context: Context) {
      context.getSystemService(NotificationManager::class.java).deleteNotificationChannel(CallNotification.CHANNEL_ID)
    }

    fun buildNotification(context: Context, botName: String): Notification {
      ensureChannel(context)
      val spec = CallNotification.spec(botName)
      val hangUp = PendingIntent.getService(
        context,
        1,
        Intent(context, VoiceCallService::class.java).setAction(CallNotification.ACTION_HANGUP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 2, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val publicVersion = NotificationCompat.Builder(context, spec.channelId)
        .setSmallIcon(R.drawable.ic_stat_call)
        .setContentTitle(spec.publicTitle)
        .setContentText(spec.publicText)
        .build()
      return NotificationCompat.Builder(context, spec.channelId)
        .setSmallIcon(R.drawable.ic_stat_call)
        .setContentTitle(spec.title)
        .setContentText(spec.text)
        .setOngoing(spec.ongoing)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPublicVersion(publicVersion)
        .setUsesChronometer(true)
        .setContentIntent(open)
        .addAction(0, spec.hangUpLabel, hangUp)
        .build()
    }
  }
}
