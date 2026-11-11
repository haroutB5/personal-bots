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
    val pending = goAsync()
    val app = context.applicationContext
    EXECUTOR.execute {
      try {
        handle(app, intent)
      } catch (error: Throwable) {
        Log.w(TAG, "action failed ${error.javaClass.simpleName}")
      } finally {
        pending.finish()
      }
    }
  }

  private fun handle(context: Context, intent: Intent) {
    val notificationId = intent.getStringExtra(NotificationSender.EXTRA_NOTIFICATION) ?: return
    val payload = payloadOf(intent, notificationId) ?: return
    val plan = PendingStore.plan(notificationId)
      ?: NotificationPlanner.plan(payload, null, PolicyStore.read(context))
    when (intent.action) {
      NotificationSender.ACTION_REPLY -> {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(NotificationSender.KEY_REPLY)?.toString()?.trim()
        if (text.isNullOrEmpty()) {
          NotificationSender.post(context, plan, quiet = true)
          return
        }
        send(context, plan, ActionType.REPLY, text, null, UUID.randomUUID().toString())
      }
      NotificationSender.ACTION_ANSWER -> {
        val choice = intent.getStringExtra(NotificationSender.EXTRA_CHOICE)
        if (choice.isNullOrBlank()) return
        send(context, plan, ActionType.ANSWER, choice, choice, UUID.randomUUID().toString())
      }
      NotificationSender.ACTION_RETRY -> {
        val again = PendingStore.command(notificationId)
        if (again == null) {
          NotificationSender.postNotice(context, plan, "Couldn't retry. Open hbots.", autoCancel = false, opensApp = true)
          return
        }
        // The same command id: if the first try got through, the server answers with the first result.
        send(context, plan, again.type, again.payload, again.payload.takeIf { again.type == ActionType.ANSWER }, again.commandId)
      }
    }
  }

  private fun send(context: Context, plan: NotificationPlan, type: ActionType, value: String, choice: String?, commandId: String) {
    PendingStore.putCommand(plan.notificationId, PendingCommand(type, commandId, value, System.currentTimeMillis()))
    NotificationSender.postNotice(context, plan, "Sending…", autoCancel = false, opensApp = false)
    val path = if (type == ActionType.REPLY) ActionRunner.replyPath(plan.notificationId) else ActionRunner.answerPath(plan.notificationId)
    val body = if (type == ActionType.REPLY) ActionRunner.replyBody(commandId, value) else ActionRunner.answerBody(commandId, value)
    val outcome = ActionRunner.run(ApiGateway(context), path, body)
    render(context, plan, ActionPresentations.of(outcome, type, choice))
    // Only a transient failure keeps the command; every other answer is final for this id.
    if (outcome != ActionOutcome.Transient) PendingStore.clearCommand(plan.notificationId)
  }

  internal fun render(context: Context, plan: NotificationPlan, presentation: Presentation) {
    when (presentation.after) {
      After.NOTICE_THEN_CANCEL -> NotificationSender.postNotice(context, plan, presentation.text, autoCancel = true, opensApp = false)
      After.NOTICE_OPEN_APP -> NotificationSender.postNotice(context, plan, presentation.text, autoCancel = false, opensApp = true)
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
  }
}
