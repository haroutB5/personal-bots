package expo.modules.hbotsnotify

/** One button on a notification. `choice` is the option label an answer sends. */
data class PlanAction(val kind: InlineAction, val label: String, val choice: String? = null)

/**
 * Everything the screen shows, as data. Building it is pure, so what a locked or
 * hide-previews phone shows is a unit test, not a manual check.
 */
data class NotificationPlan(
  val notificationId: String,
  val kind: PushKind,
  val botId: String,
  val channelId: String,
  val channelName: String,
  val title: String,
  val text: String,
  /** Null opens the app at its last screen. */
  val deepLink: String?,
  val actions: List<PlanAction>,
  val groupKey: String?,
  val contentFree: Boolean,
  val errorLine: String? = null,
)

object NotificationPlanner {
  const val GENERIC_TITLE = "hbots"
  const val PUBLIC_TEXT = "hbots · 1 new notification"
  const val ACCOUNT_CHANNEL = "account"

  /** From Android 12 an action can demand the device credential. Before it, a button on the lock screen just runs. */
  const val AUTH_ACTION_SDK = 31

  fun botChannelId(botId: String) = "bot.$botId"

  fun plan(
    payload: PushPayload,
    content: NotificationContent?,
    policy: NotifyPolicy,
    errorLine: String? = null,
    authActions: Boolean = true,
  ): NotificationPlan {
    val bot = policy.bots[payload.botId]
    val hidden = policy.appLockOn ||
      bot == null ||
      bot.hidePreviews ||
      content == null ||
      (content.text == null && content.question == null)
    val botName = bot?.name ?: GENERIC_TITLE
    val onBotChannel = payload.kind.channel == ChannelClass.BOT && payload.botId.isNotEmpty()
    val title = if (policy.appLockOn || !onBotChannel) GENERIC_TITLE else botName
    val text = if (hidden) payload.kind.contentFree else (content?.question?.question ?: content?.text ?: payload.kind.contentFree)

    val actions = actionsFor(payload, content, policy, bot, hidden, authActions)

    return NotificationPlan(
      notificationId = payload.notificationId,
      kind = payload.kind,
      botId = payload.botId,
      channelId = if (onBotChannel) botChannelId(payload.botId) else ACCOUNT_CHANNEL,
      channelName = if (onBotChannel) botName else "Sign-in and security",
      title = title,
      text = text,
      deepLink = deepLinkFor(payload, content),
      actions = actions,
      groupKey = if (payload.kind.needsChat) "chat.${payload.threadId}" else null,
      contentFree = hidden,
      errorLine = errorLine,
    )
  }

  /**
   * What the buttons may do. With the app lock on there are none: the notification only opens the app at
   * that chat, behind the lock. Without a way to ask for the credential (before Android 12) a button that
   * sends could run from the lock screen, so Reply and the options become one button that opens the chat.
   */
  private fun actionsFor(
    payload: PushPayload,
    content: NotificationContent?,
    policy: NotifyPolicy,
    bot: BotInfo?,
    hidden: Boolean,
    authActions: Boolean,
  ): List<PlanAction> {
    if (policy.appLockOn) return emptyList()
    val actions = ArrayList<PlanAction>()
    val kind = if (authActions) InlineAction.REPLY else InlineAction.OPEN
    if (InlineAction.REPLY in payload.kind.actions) {
      actions += PlanAction(kind, if (bot == null) "Reply" else "Reply to ${bot.name}")
    }
    val options = content?.question?.inlineOptions
    if (!hidden && InlineAction.OPTIONS in payload.kind.actions && options != null) {
      if (authActions) options.forEach { actions += PlanAction(InlineAction.OPTIONS, it, it) }
      else actions += PlanAction(InlineAction.OPEN, "Answer")
    }
    return actions
  }

  /** Ids pass the parser's character check, so the path needs no encoding. */
  internal fun deepLinkFor(payload: PushPayload, content: NotificationContent?): String? {
    if (!payload.kind.needsChat || payload.botId.isEmpty() || payload.threadId.isEmpty()) return null
    val base = "hbots://chat/${payload.botId}/${payload.threadId}"
    val request = content?.question?.requestId.orEmpty()
    return if (request.isNotEmpty() && SAFE_REQUEST.matches(request)) "$base?request=$request" else base
  }

  private val SAFE_REQUEST = Regex("^[A-Za-z0-9_.:-]{1,256}$")
}
