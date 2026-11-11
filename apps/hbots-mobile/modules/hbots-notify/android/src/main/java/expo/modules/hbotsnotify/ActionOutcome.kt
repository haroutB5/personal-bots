package expo.modules.hbotsnotify

/** The server's answer to a reply or an option tap. */
sealed interface ActionOutcome {
  data object Sent : ActionOutcome
  /** 409 `Stale`: the request is no longer pending. Someone, somewhere, already answered it. */
  data object Stale : ActionOutcome
  /** 409 `InProgress`: the server is still working on this same command id. Ask again, never give up at once. */
  data object InProgress : ActionOutcome
  /** The server stayed busy through every retry, so this phone cannot say whether it went through. */
  data object Unconfirmed : ActionOutcome
  /** 422 or 400: the server refused this text or choice. The command id is not consumed. */
  data object Refused : ActionOutcome
  data object NotFound : ActionOutcome
  data object SignedOut : ActionOutcome
  data object Forbidden : ActionOutcome
  /** No answer, a 5xx, 408 or 429. Safe to repeat with the same command id. */
  data object Transient : ActionOutcome
}

/** Status null is a network failure. */
data class HttpResult(val status: Int?, val body: String?)

object ActionOutcomes {
  /**
   * The server sends `{ok:false,error:"Stale"}` or `{ok:false,error:"InProgress"}`. Only a body that
   * says Stale closes the notification. Anything else is read as still running, because that keeps the
   * notification and retries the same command id, which can never act twice.
   */
  private fun classify409(body: String?): ActionOutcome {
    val error = runCatching { org.json.JSONObject(body.orEmpty()).optString("error") }.getOrDefault("")
    return if (error == "Stale") ActionOutcome.Stale else ActionOutcome.InProgress
  }

  fun classify(result: HttpResult): ActionOutcome {
    val status = result.status ?: return ActionOutcome.Transient
    return when {
      status in 200..299 -> ActionOutcome.Sent
      status == 401 -> ActionOutcome.SignedOut
      status == 403 -> ActionOutcome.Forbidden
      status == 404 -> ActionOutcome.NotFound
      status == 409 -> classify409(result.body)
      status == 400 || status == 415 || status == 422 -> ActionOutcome.Refused
      status == 408 || status == 429 || status >= 500 -> ActionOutcome.Transient
      else -> ActionOutcome.Refused
    }
  }
}

/** What happens to the notification after an action. */
enum class After {
  /** Replace it with one short line, then it goes by itself. */
  NOTICE_THEN_CANCEL,
  /** Put the original back with an error line. The question stays answerable. */
  RESTORE_WITH_ERROR,
  /** Leave one line that opens the app. */
  NOTICE_OPEN_APP,
  /** Put the original back with a Retry that reuses the same command id. */
  RESTORE_WITH_RETRY,
  /** Leave one line that stays and opens the chat. */
  NOTICE_OPEN_CHAT,
}

data class Presentation(val after: After, val text: String)

enum class ActionType { REPLY, ANSWER }

object ActionPresentations {
  const val STILL_SENDING = "Still sending"

  fun of(outcome: ActionOutcome, type: ActionType, choice: String?): Presentation = when (outcome) {
    ActionOutcome.Sent -> Presentation(
      After.NOTICE_THEN_CANCEL,
      if (type == ActionType.ANSWER && choice != null) "Answered: $choice" else "Sent",
    )
    // The server cannot say where it was answered, and a double tap on this phone lands here too.
    ActionOutcome.Stale -> Presentation(
      After.NOTICE_THEN_CANCEL,
      if (type == ActionType.ANSWER) "Already answered" else "Already handled",
    )
    ActionOutcome.InProgress -> Presentation(After.NOTICE_OPEN_CHAT, STILL_SENDING)
    ActionOutcome.Unconfirmed -> Presentation(After.NOTICE_OPEN_CHAT, "Could not confirm. Open the chat.")
    ActionOutcome.NotFound -> Presentation(After.NOTICE_THEN_CANCEL, "That message is gone")
    ActionOutcome.Refused -> Presentation(
      After.RESTORE_WITH_ERROR,
      if (type == ActionType.ANSWER) "That can't be sent from here. Open hbots to answer." else "That can't be sent from here. Open hbots.",
    )
    ActionOutcome.SignedOut -> Presentation(After.NOTICE_OPEN_APP, "Signed out. Open hbots to sign in.")
    ActionOutcome.Forbidden -> Presentation(After.NOTICE_OPEN_APP, "This phone isn't allowed to do that. Open hbots.")
    ActionOutcome.Transient -> Presentation(After.RESTORE_WITH_RETRY, "Not sent. Tap Retry.")
  }
}
