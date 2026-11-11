package expo.modules.hbotsnotify

/** What a notification offers. Reply and options are the two that send something. */
enum class InlineAction { REPLY, OPTIONS, OPEN }

enum class ChannelClass { BOT, ACCOUNT }

/**
 * One row per server push kind. Notifications are built only from this table, so a new kind
 * cannot reach the screen without saying which channel it uses and what it may offer.
 * `contentFree` is the line shown when the bot hides previews, the app lock is on or the
 * content fetch failed. It names the kind, never the content.
 */
enum class PushKind(
  val wire: String,
  val channel: ChannelClass,
  val actions: List<InlineAction>,
  val contentFree: String,
  val needsChat: Boolean = true,
) {
  QUESTION("question", ChannelClass.BOT, listOf(InlineAction.OPTIONS, InlineAction.OPEN), "Needs your answer"),
  APPROVAL("approval", ChannelClass.BOT, listOf(InlineAction.OPEN), "Needs your approval"),
  SIGN_IN("sign-in", ChannelClass.BOT, listOf(InlineAction.OPEN), "Sign-in request"),
  SECRET("secret", ChannelClass.BOT, listOf(InlineAction.OPEN), "Secret request"),
  CHAT_REPLY("chat-reply", ChannelClass.BOT, listOf(InlineAction.REPLY, InlineAction.OPEN), "New message"),
  FAILURE("failure", ChannelClass.BOT, listOf(InlineAction.OPEN), "Something failed"),
  TASK("task", ChannelClass.BOT, listOf(InlineAction.OPEN), "Task finished"),
  TEST("test", ChannelClass.ACCOUNT, listOf(InlineAction.OPEN), "Test notification", needsChat = false);

  companion object {
    fun fromWire(value: String?): PushKind? = values().firstOrNull { it.wire == value }
  }
}
