package expo.modules.hbotslauncher

/** One bot row on the widget. */
data class WidgetRow(val botId: String, val name: String, val working: Boolean, val link: String, val description: String)

/** What the widget shows. It is data, so the three states are unit-tested without Android. */
sealed interface WidgetState {
  /** No feed, or the owner signed out: the title and "Open hbots", and a tap opens the app. */
  data object SignedOut : WidgetState

  /** Signed in with nothing pinned or working. */
  data object Empty : WidgetState

  data class Bots(val rows: List<WidgetRow>, val more: Int) : WidgetState
}

object WidgetModel {
  const val MAX_ROWS = 5
  const val TITLE = "hbots"
  const val SIGNED_OUT_TEXT = "Open hbots"
  const val EMPTY_TEXT = "Pin a bot to see it here"

  /**
   * A "working" dot is trusted only while JS is still sending: the app heartbeat is 15 s, so a feed
   * older than this is shown as idle rather than claiming a bot is busy that may have finished.
   */
  const val WORKING_FRESH_MS = 90_000L

  fun build(feed: WidgetFeed?, now: Long): WidgetState {
    if (feed == null) return WidgetState.SignedOut
    if (feed.bots.isEmpty()) return WidgetState.Empty
    val fresh = now - feed.updatedAt in 0..WORKING_FRESH_MS
    val rows = feed.bots
      .map { it.copy(working = it.working && fresh) }
      .sortedByDescending { it.working }
      .map { row(it) }
    return WidgetState.Bots(rows.take(MAX_ROWS), maxOf(0, rows.size - MAX_ROWS))
  }

  /** Taps go to the bot's own page. The app lock covers the app, so the link lands behind it. */
  fun botLink(botId: String): String = "hbots://bot/${ShortcutPlanner.encode(botId)}"

  private fun row(bot: WidgetBot) = WidgetRow(
    botId = bot.botId,
    name = bot.name,
    working = bot.working,
    link = botLink(bot.botId),
    description = if (bot.working) "${bot.name}, working" else bot.name,
  )
}
