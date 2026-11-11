package expo.modules.hbotsnotify

/** The FCM data message after validation. It carries ids only, never text. */
data class PushPayload(
  val kind: PushKind,
  val notificationId: String,
  val botId: String,
  val threadId: String,
)

sealed interface PayloadResult {
  data class Accepted(val payload: PushPayload) : PayloadResult
  data class Rejected(val reason: String) : PayloadResult
}

object PushPayloadParser {
  const val VERSION = "1"
  private const val MAX_ID = 256

  /**
   * Ids go into a channel id and a deep link, and (percent-encoded) into a request path. The first
   * character is a letter, digit or underscore, so `.` and `..` can never reach a path, where a
   * client would resolve them as dot segments.
   */
  private val SAFE_ID = Regex("^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,${MAX_ID - 1}}$")

  fun parse(data: Map<String, String?>): PayloadResult {
    if (data["v"] != VERSION) return PayloadResult.Rejected("unsupported version")
    val kind = PushKind.fromWire(data["kind"]) ?: return PayloadResult.Rejected("unknown kind")
    val notificationId = data["notificationId"].orEmpty()
    if (!SAFE_ID.matches(notificationId)) return PayloadResult.Rejected("bad notification id")
    val botId = data["botId"].orEmpty()
    val threadId = data["threadId"].orEmpty()
    if (kind.needsChat) {
      if (!SAFE_ID.matches(botId) || !SAFE_ID.matches(threadId)) return PayloadResult.Rejected("bad chat id")
    } else if ((botId.isNotEmpty() && !SAFE_ID.matches(botId)) || (threadId.isNotEmpty() && !SAFE_ID.matches(threadId))) {
      return PayloadResult.Rejected("bad chat id")
    }
    return PayloadResult.Accepted(PushPayload(kind, notificationId, botId, threadId))
  }
}
