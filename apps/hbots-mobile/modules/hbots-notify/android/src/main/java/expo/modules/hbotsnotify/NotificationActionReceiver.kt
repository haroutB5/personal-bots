package expo.modules.hbotsnotify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Reply, option and Retry taps. Not exported: only this app's own notifications can reach it.
 * The system asks for the lock screen before any of these runs (setAuthenticationRequired).
 */
class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val notificationId = intent.getStringExtra(NotificationSender.EXTRA_NOTIFICATION) ?: return
    // Decided here, on the receiving thread, in tap order: a second tap while the first is on its way is dropped.
    if (!PendingStore.admit(notificationId)) {
      Log.i(TAG, "action absorbed, one is already running")
      return
    }
    val pending = goAsync()
    val app = context.applicationContext
    EXECUTOR.execute {
      var settled = false
      try {
        settled = handle(app, intent, notificationId)
      } catch (error: Throwable) {
        Log.w(TAG, "action failed ${error.javaClass.simpleName}")
      } finally {
        PendingStore.release(notificationId, settled)
        pending.finish()
      }
    }
  }

  /** True when the server ended this request for good, so a later tap on it is stale by our own doing. */
  private fun handle(context: Context, intent: Intent, notificationId: String): Boolean {
    val payload = payloadOf(intent, notificationId) ?: return false
    val plan = PendingStore.plan(notificationId)
      ?: NotificationPlanner.plan(payload, null, PolicyStore.read(context))
    // The lock can be turned on after this notification was posted. Its buttons are then stale: open the chat instead.
    if (PolicyStore.read(context).appLockOn) {
      val closed = plan.copy(title = NotificationPlanner.GENERIC_TITLE, actions = emptyList())
      NotificationSender.postNotice(context, closed, "Open hbots to continue.", autoCancel = false, opensApp = false)
      return false
    }
    when (intent.action) {
      NotificationSender.ACTION_REPLY -> {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(NotificationSender.KEY_REPLY)?.toString()?.trim()
        if (text.isNullOrEmpty()) {
          NotificationSender.post(context, plan, quiet = true)
          return false
        }
        if (ReplyLimit.tooLong(text)) {
          val link = ReplyLimit.draftLink(plan.deepLink, text)
          val words = if (link != null) ReplyLimit.TOO_LONG_WITH_DRAFT else ReplyLimit.TOO_LONG_NO_DRAFT
          NotificationSender.postNotice(context, plan.copy(deepLink = link ?: plan.deepLink), words, autoCancel = false, opensApp = false)
          return false
        }
        return send(context, plan, ActionType.REPLY, text, null, UUID.randomUUID().toString())
      }
      NotificationSender.ACTION_ANSWER -> {
        val choice = intent.getStringExtra(NotificationSender.EXTRA_CHOICE)
        if (choice.isNullOrBlank()) return false
        return send(context, plan, ActionType.ANSWER, choice, choice, UUID.randomUUID().toString())
      }
      NotificationSender.ACTION_RETRY -> {
        val again = PendingStore.command(notificationId)
        if (again == null) {
          NotificationSender.postNotice(context, plan, "Couldn't retry. Open hbots.", autoCancel = false, opensApp = true)
          return false
        }
        // The same command id: if the first try got through, the server answers with the first result.
        return send(context, plan, again.type, again.payload, again.payload.takeIf { again.type == ActionType.ANSWER }, again.commandId)
      }
    }
    return false
  }

  private fun send(context: Context, plan: NotificationPlan, type: ActionType, value: String, choice: String?, commandId: String): Boolean {
    PendingStore.putCommand(plan.notificationId, PendingCommand(type, commandId, value, System.currentTimeMillis()))
    val request = ActionRequest(type, plan.notificationId, plan.deepLink, value, choice, commandId)
    val settled = ActionDelivery.deliver(ApiGateway(context), request, post = { notice ->
      if (notice !is ActionNotice.Settled) NotificationSender.postNotice(context, plan, notice.text, autoCancel = false, opensApp = false)
    })
    render(context, plan.copy(deepLink = settled.chatLink), settled.presentation)
    // Only a transient failure keeps the command; every other answer is final for this id.
    if (settled.outcome != ActionOutcome.Transient) PendingStore.clearCommand(plan.notificationId)
    return settled.outcome in ENDED_FOR_GOOD
  }

  internal fun render(context: Context, plan: NotificationPlan, presentation: Presentation) {
    when (presentation.after) {
      After.NOTICE_THEN_CANCEL -> NotificationSender.postNotice(context, plan, presentation.text, autoCancel = true, opensApp = false)
      After.NOTICE_OPEN_APP -> NotificationSender.postNotice(context, plan, presentation.text, autoCancel = false, opensApp = true)
      After.NOTICE_OPEN_CHAT -> NotificationSender.postNotice(context, plan, presentation.text, autoCancel = false, opensApp = false)
      After.RESTORE_WITH_ERROR -> NotificationSender.post(context, plan.copy(errorLine = presentation.text), quiet = true)
      After.RESTORE_WITH_RETRY -> NotificationSender.post(context, plan.copy(errorLine = presentation.text), retry = true, quiet = true)
    }
  }

  private fun payloadOf(intent: Intent, notificationId: String): PushPayload? {
    val parsed = PushPayloadParser.parse(
      mapOf(
        "v" to PushPayloadParser.VERSION,
        "kind" to intent.getStringExtra(NotificationSender.EXTRA_KIND),
        "notificationId" to notificationId,
        "botId" to intent.getStringExtra(NotificationSender.EXTRA_BOT),
        "threadId" to intent.getStringExtra(NotificationSender.EXTRA_THREAD),
      ),
    )
    return (parsed as? PayloadResult.Accepted)?.payload
  }

  private companion object {
    const val TAG = "HbotsNotify"
    val EXECUTOR = Executors.newSingleThreadExecutor()
    val ENDED_FOR_GOOD = setOf(ActionOutcome.Sent, ActionOutcome.Stale, ActionOutcome.NotFound)
  }
}
