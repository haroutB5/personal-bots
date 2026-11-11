package expo.modules.hbotsnotify

internal fun data(
  kind: String? = "chat-reply",
  notificationId: String? = "n1",
  botId: String? = "bot-1",
  threadId: String? = "t1",
  v: String? = "1",
): Map<String, String?> = mapOf("kind" to kind, "notificationId" to notificationId, "botId" to botId, "threadId" to threadId, "v" to v)

internal fun payload(kind: PushKind = PushKind.CHAT_REPLY, botId: String = "bot-1"): PushPayload =
  PushPayload(kind, "n1", botId, "t1")

internal fun policy(lock: Boolean = false, hide: Boolean = false): NotifyPolicy =
  NotifyPolicy(lock, mapOf("bot-1" to BotInfo("Juno", hide)))

internal fun content(
  kind: PushKind = PushKind.CHAT_REPLY,
  text: String? = "Dinner at 8?",
  question: QuestionContent? = null,
): NotificationContent = NotificationContent("n1", kind, "bot-1", "t1", text, question)

internal fun question(options: List<String>?): QuestionContent = QuestionContent("req-1", "How many nights?", options)

/** Records each call and answers from a script. */
internal class FakeHttp(private val answers: List<HttpResult>) : HttpGateway {
  val calls = ArrayList<Triple<String, String, String?>>()
  override fun execute(method: String, path: String, jsonBody: String?): HttpResult {
    calls += Triple(method, path, jsonBody)
    return answers[minOf(calls.size - 1, answers.size - 1)]
  }
}
