package expo.modules.hbotsnotify

import org.json.JSONArray
import org.json.JSONObject

data class QuestionContent(
  val requestId: String,
  val question: String,
  /** The server's decision. Null means the app must open to answer. */
  val inlineOptions: List<String>?,
)

/** What `GET /api/personal/notifications/:id/content` returns. Both are null for a bot that hides previews. */
data class NotificationContent(
  val notificationId: String,
  val kind: PushKind,
  val botId: String,
  val threadId: String,
  val text: String?,
  val question: QuestionContent?,
)

object NotificationContentParser {
  private const val MAX_TEXT = 4000
  private const val MAX_OPTIONS = 3

  fun parse(body: String): NotificationContent? = runCatching {
    val json = JSONObject(body)
    val kind = PushKind.fromWire(json.optString("kind")) ?: return null
    val id = json.optString("notificationId")
    if (id.isBlank()) return null
    NotificationContent(
      notificationId = id,
      kind = kind,
      botId = json.optString("botId"),
      threadId = json.optString("threadId"),
      text = optText(json, "text"),
      question = parseQuestion(json.optJSONObject("question")),
    )
  }.getOrNull()

  private fun optText(json: JSONObject, key: String): String? {
    if (json.isNull(key)) return null
    val value = json.optString(key, "")
    return if (value.isBlank()) null else value.take(MAX_TEXT)
  }

  private fun parseQuestion(json: JSONObject?): QuestionContent? {
    json ?: return null
    val requestId = json.optString("requestId")
    val question = optText(json, "question") ?: return null
    return QuestionContent(requestId, question, labels(json.optJSONArray("inlineOptions")))
  }

  private fun labels(array: JSONArray?): List<String>? {
    array ?: return null
    val labels = (0 until array.length()).mapNotNull { array.optString(it, "").takeIf { label -> label.isNotBlank() } }
    // The server allows one to three; anything else is treated as "open the app".
    return if (labels.isEmpty() || labels.size > MAX_OPTIONS) null else labels
  }
}
