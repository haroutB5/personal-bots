package expo.modules.hbotsnotify

import android.content.Context

/** The synced policy, kept where the push service can read it with no JS running. */
object PolicyStore {
  private const val PREFS = "hbots_notify_policy"
  private const val KEY = "policy"

  fun read(context: Context): NotifyPolicy =
    PolicyCodec.decode(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null))

  fun write(context: Context, policy: NotifyPolicy) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, PolicyCodec.encode(policy)).apply()
  }

  fun clear(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
  }
}

/** What a retry needs, in memory only: reply text is never written to disk. */
data class PendingCommand(
  val type: ActionType,
  val commandId: String,
  val payload: String,
  val at: Long,
)

object PendingStore {
  private const val TTL_MS = 10 * 60 * 1000L
  private val commands = HashMap<String, PendingCommand>()
  private val plans = HashMap<String, NotificationPlan>()

  @Synchronized fun putCommand(notificationId: String, command: PendingCommand) {
    commands[notificationId] = command
  }

  @Synchronized fun command(notificationId: String, now: Long = System.currentTimeMillis()): PendingCommand? =
    commands[notificationId]?.takeIf { now - it.at <= TTL_MS }

  @Synchronized fun clearCommand(notificationId: String) {
    commands.remove(notificationId)
  }

  @Synchronized fun putPlan(plan: NotificationPlan) {
    plans[plan.notificationId] = plan
  }

  @Synchronized fun plan(notificationId: String): NotificationPlan? = plans[notificationId]

  @Synchronized fun clearAll() {
    commands.clear()
    plans.clear()
  }
}
