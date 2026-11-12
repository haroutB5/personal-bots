package expo.modules.hbotslauncher

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** A bot's round avatar: its first letter on its colour. */
data class WidgetFace(val initial: String, val color: Int)

enum class BotTone { WORKING, WAITING, IDLE }

/** One bot as every widget words it. */
data class BotLine(
  val botId: String,
  val name: String,
  val face: WidgetFace,
  val tone: BotTone,
  /** What it is doing, in words. */
  val sub: String,
  /** How long it has been at it, or empty. */
  val time: String,
  val link: String,
  val description: String,
)

/** A labelled bar, 0 to 100. `hot` inks the figure amber. */
data class WidgetGauge(val label: String, val value: String, val pct: Int, val hot: Boolean)

/** What the widgets share: wording, links, the freshness rule and the clock. No Android types. */
object WidgetCommon {
  const val TITLE = "hbots"
  const val SIGNED_OUT_TEXT = "Open hbots"

  /** A figure older than this is no longer "now": it is marked "as of HH:MM", and a working dot goes out. */
  const val FRESH_MS = 90_000L
  const val HOT_PCT = 80
  const val DEFAULT_COLOR = 0xFF5A5A57.toInt()
  private const val REFRESH_MARGIN_MS = 1_000L
  private val CLOCK = DateTimeFormatter.ofPattern("HH:mm")

  fun fresh(feed: WidgetFeed, now: Long): Boolean = now - feed.updatedAt <= FRESH_MS

  /** Empty while the feed is fresh; "as of 14:44" once it is not. */
  fun asOf(feed: WidgetFeed, now: Long, zone: ZoneId): String =
    if (fresh(feed, now) || feed.updatedAt <= 0) "" else "as of ${clock(feed.updatedAt, zone)}"

  fun clock(ms: Long, zone: ZoneId): String = CLOCK.format(Instant.ofEpochMilli(ms).atZone(zone))

  /** "18:00" today, "Fri 18:00" any other day. */
  fun dayClock(ms: Long, now: Long, zone: ZoneId): String {
    val at = Instant.ofEpochMilli(ms).atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    if (at.toLocalDate() == today) return CLOCK.format(at)
    return "${at.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.ENGLISH)} ${CLOCK.format(at)}"
  }

  fun startOfDay(now: Long, zone: ZoneId): Long =
    Instant.ofEpochMilli(now).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()

  /** "now", "18 min", "2 h 5 min". Empty when the start is unknown. */
  fun elapsed(sinceMs: Long, now: Long): String {
    if (sinceMs <= 0 || sinceMs > now) return ""
    val minutes = (now - sinceMs) / 60_000L
    return when {
      minutes < 1 -> "now"
      minutes < 60 -> "$minutes min"
      else -> "${minutes / 60} h ${minutes % 60} min"
    }
  }

  /** The feed's one self-inflicted change: the moment it stops being fresh. Null when already past. */
  fun nextRefreshAt(feed: WidgetFeed?, now: Long): Long? {
    if (feed == null || feed.updatedAt <= 0) return null
    val at = feed.updatedAt + FRESH_MS + REFRESH_MARGIN_MS
    return if (at > now) at else null
  }

  fun botLink(botId: String): String = "hbots://bot/${ShortcutPlanner.encode(botId)}"

  /** A new chat with the lead bot. `intent` is `keyboard`, `photo` or `voice`; the chat screen may act on it. */
  fun newChatLink(intent: String): String = "hbots://bot/cto?new=1&intent=$intent"

  /** The chat, with the choice waiting in the composer. The owner still presses send. */
  fun choiceLink(chatLink: String, choice: String): String =
    "$chatLink?draft=${ShortcutPlanner.encode(choice)}"

  fun color(hex: String): Int =
    if (hex.length == 7 && hex[0] == '#') (hex.substring(1).toLongOrNull(16)?.let { (0xFF000000L or it).toInt() } ?: DEFAULT_COLOR) else DEFAULT_COLOR

  fun face(name: String, color: String): WidgetFace =
    WidgetFace(name.trim().take(1).uppercase(Locale.ENGLISH).ifEmpty { "h" }, color(color))

  fun line(bot: WidgetBot, fresh: Boolean, now: Long): BotLine {
    val tone = when {
      bot.working && fresh -> BotTone.WORKING
      bot.waiting -> BotTone.WAITING
      else -> BotTone.IDLE
    }
    val sub = when {
      tone == BotTone.WORKING -> bot.activity.ifEmpty { "Working" }
      tone == BotTone.WAITING -> "Waiting for your answer"
      bot.working -> "Last seen working"
      bot.unread > 0 -> "${bot.unread} unread"
      else -> "Idle"
    }
    val time = if (tone == BotTone.WORKING) elapsed(bot.sinceMs, now) else ""
    val spoken = when (tone) {
      BotTone.WORKING -> "${bot.name}, working" + (if (bot.activity.isEmpty()) "" else ", ${bot.activity}")
      BotTone.WAITING -> "${bot.name}, waiting for your answer"
      BotTone.IDLE -> if (bot.unread > 0) "${bot.name}, ${bot.unread} unread" else bot.name
    }
    return BotLine(bot.botId, bot.name, face(bot.name, bot.color), tone, sub, time, botLink(bot.botId), spoken)
  }

  fun lines(feed: WidgetFeed, now: Long): List<BotLine> {
    val fresh = fresh(feed, now)
    // Stable sort: working, then waiting, then the rest in the feed's order.
    return feed.bots.map { line(it, fresh, now) }.sortedBy { it.tone.ordinal }
  }

  /** "2 working · 1 waiting", or empty. */
  fun counts(lines: List<BotLine>): String {
    val working = lines.count { it.tone == BotTone.WORKING }
    val waiting = lines.count { it.tone == BotTone.WAITING }
    return listOfNotNull(
      if (working > 0) "$working working" else null,
      if (waiting > 0) "$waiting waiting" else null,
    ).joinToString(" · ")
  }

  fun gauge(label: String, pct: Int?, value: String? = null): WidgetGauge? =
    pct?.let { WidgetGauge(label, value ?: "$it%", it.coerceIn(0, 100), it >= HOT_PCT) }
}
