package expo.modules.hbotsnotify

import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.content.Context
import android.os.Build

data class ChannelSpec(
  val id: String,
  val name: String,
  val description: String,
  val importance: Int,
)

object NotifyChannels {
  const val GROUP_BOTS = "bots"
  const val WORKING = "working"

  val working = ChannelSpec(WORKING, "Bots working", "Shows while a bot is running a task", NotificationManager.IMPORTANCE_LOW)
  val account = ChannelSpec(NotificationPlanner.ACCOUNT_CHANNEL, "Sign-in and security", "Sign-in requests and security notices", NotificationManager.IMPORTANCE_HIGH)

  fun bot(botId: String, name: String) = ChannelSpec(
    NotificationPlanner.botChannelId(botId),
    name,
    "Messages and questions from $name",
    NotificationManager.IMPORTANCE_HIGH,
  )

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

  private fun create(context: Context, spec: ChannelSpec, group: String?) {
    val channel = NotificationChannel(spec.id, spec.name, spec.importance).apply {
      description = spec.description
      lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
      if (group != null) this.group = group
      if (spec.importance <= NotificationManager.IMPORTANCE_LOW) {
        setSound(null, null)
        enableVibration(false)
      }
    }
    // The same id again updates the name only, so a renamed bot follows without losing its settings.
    manager(context).createNotificationChannel(channel)
  }

  fun ensureBase(context: Context) {
    manager(context).createNotificationChannelGroup(NotificationChannelGroup(GROUP_BOTS, "Bots"))
    create(context, working, null)
    create(context, account, null)
  }

  fun ensureFor(context: Context, plan: NotificationPlan) {
    ensureBase(context)
    if (plan.channelId.startsWith("bot.")) create(context, bot(plan.botId, plan.channelName), GROUP_BOTS)
  }

  /** Renames the channels that exist and deletes those of bots that are gone. */
  fun syncBots(context: Context, bots: Map<String, BotInfo>) {
    val manager = manager(context)
    for (channel in manager.notificationChannels) {
      if (!channel.id.startsWith("bot.")) continue
      val info = bots[channel.id.removePrefix("bot.")]
      if (info == null) manager.deleteNotificationChannel(channel.id)
      else if (channel.name.toString() != info.name) create(context, bot(channel.id.removePrefix("bot."), info.name), GROUP_BOTS)
    }
  }

  fun deleteAll(context: Context) {
    val manager = manager(context)
    for (channel in manager.notificationChannels) {
      // The updater owns its own channels; this module never removes them.
      if (channel.id.startsWith("bot.") || channel.id == WORKING || channel.id == NotificationPlanner.ACCOUNT_CHANNEL) {
        manager.deleteNotificationChannel(channel.id)
      }
    }
    manager.deleteNotificationChannelGroup(GROUP_BOTS)
  }

  fun states(context: Context): List<Map<String, Any?>> =
    manager(context).notificationChannels.map {
      mapOf("id" to it.id, "name" to it.name.toString(), "importance" to it.importance, "group" to it.group)
    }
}
