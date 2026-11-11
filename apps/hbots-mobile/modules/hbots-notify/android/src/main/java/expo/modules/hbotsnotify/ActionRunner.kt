package expo.modules.hbotsnotify

/** The one place native talks to the server. A fake stands in for it in tests. */
fun interface HttpGateway {
  /** [timeoutMs] bounds the whole call: connect, send and read. */
  fun execute(method: String, path: String, jsonBody: String?, timeoutMs: Long): HttpResult
}

object ActionRunner {
  const val MAX_ATTEMPTS = 3
  /** The server answers InProgress at once, so more tries are cheap. They stop at the budget below. */
  const val MAX_IN_PROGRESS_ATTEMPTS = 5
  /**
   * Wall clock for one action, every wait and every call included. The receiver runs inside a foreground
   * broadcast, which the system kills after about 10 s, so this leaves room to post the final notice.
   */
  const val BUDGET_MS = 7_000L
  /** The longest one call may take. A stalled server then leaves time for one more try. */
  const val CALL_TIMEOUT_MS = 3_500L
  /** A call with less than this left is not worth starting. */
  private const val MIN_CALL_MS = 500L
  private val BACKOFF_MS = longArrayOf(1_000, 2_000)
  private val IN_PROGRESS_BACKOFF_MS = longArrayOf(1_000, 2_000, 3_000, 4_000)

  fun replyPath(notificationId: String) = "/api/personal/notifications/${PathSegment.encode(notificationId)}/reply"
  fun answerPath(notificationId: String) = "/api/personal/notifications/${PathSegment.encode(notificationId)}/answer"

  fun replyBody(commandId: String, text: String): String =
    org.json.JSONObject().put("commandId", commandId).put("text", text).toString()

  fun answerBody(commandId: String, choice: String): String =
    org.json.JSONObject().put("commandId", commandId).put("choice", choice).toString()

  /**
   * Sends one command inside [BUDGET_MS]. A transient failure repeats with the same command id, which the
   * server stores per (command id, user), so a repeat can never act twice.
   * InProgress means the server still holds that id: wait, tell the caller, ask again with the
   * same id, and end as Unconfirmed when it never settles. Any other outcome ends the loop,
   * and a 422 does not consume the id on the server.
   * When the budget runs out, or a call timed out so the server may have it, the end is Unconfirmed: this
   * phone cannot say whether it went through. Only fast failures end as Transient, which really did not send.
   */
  fun run(
    http: HttpGateway,
    path: String,
    body: String,
    sleep: (Long) -> Unit = Thread::sleep,
    now: () -> Long = System::currentTimeMillis,
    onWaiting: () -> Unit = {},
  ): ActionOutcome {
    val startedAt = now()
    fun left() = BUDGET_MS - (now() - startedAt)
    var transient = 0
    var busy = 0
    var mayHaveArrived = false
    while (true) {
      val allowed = minOf(CALL_TIMEOUT_MS, left())
      if (allowed < MIN_CALL_MS) return ActionOutcome.Unconfirmed
      val calledAt = now()
      val result = http.execute("POST", path, body, allowed)
      if (result.status == null && now() - calledAt >= allowed - TIMED_OUT_SLACK_MS) mayHaveArrived = true
      when (val outcome = ActionOutcomes.classify(result)) {
        ActionOutcome.Transient -> {
          transient++
          if (transient >= MAX_ATTEMPTS) return if (mayHaveArrived) ActionOutcome.Unconfirmed else ActionOutcome.Transient
          if (!pause(BACKOFF_MS[transient - 1], ::left, sleep)) return ActionOutcome.Unconfirmed
        }
        ActionOutcome.InProgress -> {
          busy++
          if (busy >= MAX_IN_PROGRESS_ATTEMPTS) return ActionOutcome.Unconfirmed
          onWaiting()
          if (!pause(IN_PROGRESS_BACKOFF_MS[busy - 1], ::left, sleep)) return ActionOutcome.Unconfirmed
        }
        else -> return outcome
      }
    }
  }

  private const val TIMED_OUT_SLACK_MS = 50L

  /** Waits, but never so long that no call fits afterwards. False when there is no room left. */
  private fun pause(wanted: Long, left: () -> Long, sleep: (Long) -> Unit): Boolean {
    val room = left() - MIN_CALL_MS
    if (room <= 0) return false
    sleep(minOf(wanted, room))
    return true
  }
}

/** One id as one path segment: anything outside the unreserved set is percent-encoded. */
object PathSegment {
  fun encode(value: String): String {
    val out = StringBuilder()
    for (byte in value.toByteArray(Charsets.UTF_8)) {
      val c = byte.toInt() and 0xFF
      val plain = c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code || c in '0'.code..'9'.code ||
        c == '-'.code || c == '.'.code || c == '_'.code || c == '~'.code
      if (plain) out.append(c.toChar()) else out.append('%').append("%02X".format(c))
    }
    return out.toString()
  }
}

sealed interface FetchOutcome {
  data class Found(val content: NotificationContent) : FetchOutcome
  data object Unavailable : FetchOutcome
}

object ContentFetcher {
  const val TIMEOUT_MS = 8_000L

  fun contentPath(notificationId: String) = "/api/personal/notifications/${PathSegment.encode(notificationId)}/content"

  /**
   * One authenticated read. Anything that is not a clean 200 for the same notification
   * is `Unavailable`, and the caller shows the content-free version instead.
   */
  fun fetch(http: HttpGateway, payload: PushPayload): FetchOutcome {
    val result = http.execute("GET", contentPath(payload.notificationId), null, TIMEOUT_MS)
    if (result.status != 200) return FetchOutcome.Unavailable
    val content = NotificationContentParser.parse(result.body.orEmpty()) ?: return FetchOutcome.Unavailable
    // Real text is shown under the payload's bot name and opens the payload's chat, so all of it must agree.
    if (content.notificationId != payload.notificationId ||
      content.kind != payload.kind ||
      content.botId != payload.botId ||
      content.threadId != payload.threadId
    ) return FetchOutcome.Unavailable
    return FetchOutcome.Found(content)
  }
}
