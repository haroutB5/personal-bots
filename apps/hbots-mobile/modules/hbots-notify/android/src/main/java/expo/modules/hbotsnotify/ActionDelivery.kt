package expo.modules.hbotsnotify

/**
 * What the action notice says at one moment. A notice is in exactly one of these states: it starts
 * at [Sending], may move to [StillSending], and always ends in one [Settled].
 */
sealed interface ActionNotice {
  val text: String

  data object Sending : ActionNotice {
    override val text = "Sending…"
  }

  data object StillSending : ActionNotice {
    override val text = ActionPresentations.STILL_SENDING
  }

  /** The end state. [chatLink] is the link the notice opens, which carries the reply as a draft when it could not be confirmed. */
  data class Settled(val outcome: ActionOutcome, val presentation: Presentation, val chatLink: String?) : ActionNotice {
    override val text: String get() = presentation.text
  }
}

/** One reply or option tap, as the receiver hands it over. */
data class ActionRequest(
  val type: ActionType,
  val notificationId: String,
  /** The chat the notification belongs to, if it has one. */
  val chatLink: String?,
  /** The reply text, or the chosen option. */
  val value: String,
  val choice: String?,
  val commandId: String,
)

object ActionDelivery {
  /** Runs one request and reports each notice state through [post]. Always returns the settled state. */
  fun deliver(
    http: HttpGateway,
    request: ActionRequest,
    post: (ActionNotice) -> Unit,
    sleep: (Long) -> Unit = Thread::sleep,
    now: () -> Long = System::currentTimeMillis,
  ): ActionNotice.Settled {
    post(ActionNotice.Sending)
    val path = if (request.type == ActionType.REPLY) ActionRunner.replyPath(request.notificationId) else ActionRunner.answerPath(request.notificationId)
    val body = if (request.type == ActionType.REPLY) ActionRunner.replyBody(request.commandId, request.value) else ActionRunner.answerBody(request.commandId, request.value)
    // Whatever goes wrong inside, the notice still ends in a settled state and never stays on "Sending…".
    val outcome = try {
      ActionRunner.run(http, path, body, sleep = sleep, now = now, onWaiting = { post(ActionNotice.StillSending) })
    } catch (error: Throwable) {
      ActionOutcome.Unconfirmed
    }
    return settle(outcome, request)
  }

  /**
   * The end state. A reply that could not be confirmed opens the chat with the text as a draft, so it is
   * never lost. Without a chat to open the command stays retryable instead, with the same command id.
   */
  internal fun settle(outcome: ActionOutcome, request: ActionRequest): ActionNotice.Settled {
    if (outcome == ActionOutcome.Unconfirmed && request.type == ActionType.REPLY) {
      val draft = ReplyLimit.draftLink(request.chatLink, request.value)
      return if (draft != null) {
        ActionNotice.Settled(outcome, Presentation(After.NOTICE_OPEN_CHAT, UNCONFIRMED_REPLY), draft)
      } else {
        ActionNotice.Settled(ActionOutcome.Transient, ActionPresentations.of(ActionOutcome.Transient, request.type, request.choice), request.chatLink)
      }
    }
    return ActionNotice.Settled(outcome, ActionPresentations.of(outcome, request.type, request.choice), request.chatLink)
  }

  const val UNCONFIRMED_REPLY = "Could not confirm. Open the chat. Your reply is in the message box."
}
