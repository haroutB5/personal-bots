package expo.modules.hbotsnotify

/** The one place native talks to the server. A fake stands in for it in tests. */
fun interface HttpGateway {
  fun execute(method: String, path: String, jsonBody: String?): HttpResult
}

object ActionRunner {
  const val MAX_ATTEMPTS = 3
  /** The server answers InProgress at once, so more tries are cheap. They stop at the budget below. */
  const val MAX_IN_PROGRESS_ATTEMPTS = 5
  /** Wall clock for one action. A broadcast that runs much longer than this risks being killed. */
  const val BUDGET_MS = 30_000L
  private val BACKOFF_MS = longArrayOf(1_000, 2_000)
  private val IN_PROGRESS_BACKOFF_MS = longArrayOf(1_000, 2_000, 3_000, 4_000)

  fun replyPath(notificationId: String) = "/api/personal/notifications/${PathSegment.encode(notificationId)}/reply"
  fun answerPath(notificationId: String) = "/api/personal/notifications/${PathSegment.encode(notificationId)}/answer"

  fun replyBody(commandId: String, text: String): String =
    org.json.JSONObject().put("commandId", commandId).put("text", text).toString()

  fun answerBody(commandId: String, choice: String): String =
    org.json.JSONObject().put("commandId", commandId).put("choice", choice).toString()

  /**
   * Sends one command. A transient failure repeats with the same command id, which the
   * server stores per (command id, user), so a repeat can never act twice.
   * InProgress means the server still holds that id: wait, tell the caller, ask again with the
   * same id, and end as Unconfirmed when it never settles. Any other outcome ends the loop,
   * and a 422 does not consume the id on the server.
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
    var transient = 0
    var busy = 0
    while (true) {
      val outcome = ActionOutcomes.classify(http.execute("POST", path, body))
      val outOfTime = now() - startedAt >= BUDGET_MS
      when (outcome) {
        ActionOutcome.Transient -> {
          transient++
          if (transient >= MAX_ATTEMPTS || outOfTime) return ActionOutcome.Transient
          sleep(BACKOFF_MS[transient - 1])
        }
        ActionOutcome.InProgress -> {
          busy++
          if (busy >= MAX_IN_PROGRESS_ATTEMPTS || outOfTime) return ActionOutcome.Unconfirmed
          onWaiting()
          sleep(IN_PROGRESS_BACKOFF_MS[busy - 1])
        }
        else -> return outcome
      }
    }
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
  fun contentPath(notificationId: String) = "/api/personal/notifications/${PathSegment.encode(notificationId)}/content"

  /**
   * One authenticated read. Anything that is not a clean 200 for the same notification
   * is `Unavailable`, and the caller shows the content-free version instead.
   */
  fun fetch(http: HttpGateway, payload: PushPayload): FetchOutcome {
    val result = http.execute("GET", contentPath(payload.notificationId), null)
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
