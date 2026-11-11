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
  /** A tap that was sent from this phone and finished is not sent again for this long. */
  const val SETTLED_MS = 30_000L
  /** An action that never reported back (a killed process cannot) stops blocking taps after this. */
  const val IN_FLIGHT_MAX_MS = 2 * 60 * 1000L
  private val commands = HashMap<String, PendingCommand>()
  private val plans = HashMap<String, NotificationPlan>()
  private val inFlight = HashMap<String, Long>()
  private val settled = HashMap<String, Long>()

  /**
   * One command per notification at a time. A second tap while the first is on its way, or just after
   * it finished for good, is absorbed: it would be a different command id and the server would answer
   * 409 to a request this phone already settled.
   */
  @Synchronized fun admit(notificationId: String, now: Long = System.currentTimeMillis()): Boolean {
    inFlight[notificationId]?.let { if (now - it < IN_FLIGHT_MAX_MS) return false }
    settled[notificationId]?.let { if (now - it < SETTLED_MS) return false }
    inFlight[notificationId] = now
    return true
  }

  /** `final` is true when the server gave an answer that ends this request. A retryable failure is not final. */
  @Synchronized fun release(notificationId: String, final: Boolean, now: Long = System.currentTimeMillis()) {
    inFlight.remove(notificationId)
    if (final) settled[notificationId] = now else settled.remove(notificationId)
  }

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
    inFlight.clear()
    settled.clear()
  }
}
