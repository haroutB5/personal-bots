package expo.modules.hbotsnotify

import android.content.Context
import android.util.Log

/** Everything between "a data message arrived" and "a notification is on screen". */
object PushIngest {
  private const val TAG = "HbotsNotify"

  /**
   * Runs off the main thread. A message that does not parse is dropped with a log line that
   * names the reason and nothing from the message. Every accepted message ends in a
   * notification: the full one when the content fetch worked and the policy allows it, the
   * content-free one otherwise.
   */
  fun handle(context: Context, data: Map<String, String?>, http: HttpGateway = ApiGateway(context)) {
    val payload = when (val parsed = PushPayloadParser.parse(data)) {
      is PayloadResult.Accepted -> parsed.payload
      is PayloadResult.Rejected -> {
        Log.i(TAG, "push dropped: ${parsed.reason}")
        return
      }
    }
    val policy = PolicyStore.read(context)
    val content = if (wantsContent(policy, payload)) {
      (ContentFetcher.fetch(http, payload) as? FetchOutcome.Found)?.content
    } else null
    val plan = NotificationPlanner.plan(payload, content, policy)
    PendingStore.putPlan(plan)
    NotificationSender.post(context, plan)
  }

  /** A fetch that could not be shown is a fetch that did not need to happen. */
  internal fun wantsContent(policy: NotifyPolicy, payload: PushPayload): Boolean {
    if (policy.appLockOn) return false
    val bot = policy.bots[payload.botId] ?: return false
    return !bot.hidePreviews
  }
}
