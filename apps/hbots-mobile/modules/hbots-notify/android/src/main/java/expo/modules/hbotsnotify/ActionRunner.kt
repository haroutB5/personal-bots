package expo.modules.hbotsnotify

/** The one place native talks to the server. A fake stands in for it in tests. */
fun interface HttpGateway {
  fun execute(method: String, path: String, jsonBody: String?): HttpResult
}

object ActionRunner {
  const val MAX_ATTEMPTS = 3
  private val BACKOFF_MS = longArrayOf(1_000, 2_000)

  fun replyPath(notificationId: String) = "/api/personal/notifications/$notificationId/reply"
  fun answerPath(notificationId: String) = "/api/personal/notifications/$notificationId/answer"

  fun replyBody(commandId: String, text: String): String =
    org.json.JSONObject().put("commandId", commandId).put("text", text).toString()

  fun answerBody(commandId: String, choice: String): String =
    org.json.JSONObject().put("commandId", commandId).put("choice", choice).toString()

  /**
   * Sends one command. A transient failure repeats with the same command id, which the
   * server stores per (command id, user), so a repeat can never act twice.
   * Any other outcome ends the loop, and a 422 does not consume the id on the server.
   */
  fun run(
    http: HttpGateway,
    path: String,
    body: String,
    sleep: (Long) -> Unit = Thread::sleep,
  ): ActionOutcome {
    var outcome: ActionOutcome = ActionOutcome.Transient
    for (attempt in 0 until MAX_ATTEMPTS) {
      outcome = ActionOutcomes.classify(http.execute("POST", path, body))
      if (outcome != ActionOutcome.Transient) return outcome
      if (attempt < MAX_ATTEMPTS - 1) sleep(BACKOFF_MS[attempt])
    }
    return outcome
  }
}

sealed interface FetchOutcome {
  data class Found(val content: NotificationContent) : FetchOutcome
  data object Unavailable : FetchOutcome
}

object ContentFetcher {
  fun contentPath(notificationId: String) = "/api/personal/notifications/$notificationId/content"

  /**
   * One authenticated read. Anything that is not a clean 200 for the same notification
   * is `Unavailable`, and the caller shows the content-free version instead.
   */
  fun fetch(http: HttpGateway, payload: PushPayload): FetchOutcome {
    val result = http.execute("GET", contentPath(payload.notificationId), null)
    if (result.status != 200) return FetchOutcome.Unavailable
    val content = NotificationContentParser.parse(result.body.orEmpty()) ?: return FetchOutcome.Unavailable
    if (content.notificationId != payload.notificationId) return FetchOutcome.Unavailable
    return FetchOutcome.Found(content)
  }
}
