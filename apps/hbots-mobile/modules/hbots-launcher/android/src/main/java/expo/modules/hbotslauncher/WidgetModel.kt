package expo.modules.hbotslauncher

import java.time.ZoneId

data class UsageBars(val session: WidgetGauge?, val week: WidgetGauge?)

/** Everything the Live board draws, as data. */
sealed interface WidgetState {
  data object SignedOut : WidgetState
  data object Empty : WidgetState
  data class Board(
    val title: String,
    val asOf: String,
    /** Working and waiting bots; the pinned idle ones when nobody is busy. */
    val rows: List<BotLine>,
    /** Idle bots that are not rows, as faces. */
    val idle: List<BotLine>,
    val moreIdle: Int,
    val usage: UsageBars?,
  ) : WidgetState
}

/**
 * Widget 1, the Live board: what each bot is doing, the idle ones as a strip of faces, and the
 * usage bars. It shows a bot as working only while the feed is fresh, because JS feeds it only
 * while the app is alive: after [WidgetCommon.FRESH_MS] the row says "Last seen working" and the
 * header says "as of HH:MM".
 */
object WidgetModel {
  const val MAX_ROWS = 4
  const val MAX_IDLE = 5
  const val EMPTY_TEXT = "Pin a bot to see it here"

  fun build(feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): WidgetState {
    if (feed == null) return WidgetState.SignedOut
    val lines = WidgetCommon.lines(feed, now)
    if (lines.isEmpty()) return WidgetState.Empty
    val busy = lines.filter { it.tone != BotTone.IDLE }
    val rows = (if (busy.isEmpty()) lines else busy).take(MAX_ROWS)
    val rest = lines.filter { it !in rows }
    val working = lines.count { it.tone == BotTone.WORKING }
    return WidgetState.Board(
      title = if (working > 0) "${WidgetCommon.TITLE} · $working working" else WidgetCommon.TITLE,
      asOf = WidgetCommon.asOf(feed, now, zone),
      rows = rows,
      idle = rest.take(MAX_IDLE),
      moreIdle = maxOf(0, rest.size - MAX_IDLE),
      usage = feed.usage?.let { UsageBars(WidgetCommon.gauge("Session", it.sessionPct), WidgetCommon.gauge("Week", it.weekPct)) },
    )
  }
}
