package expo.modules.hbotslauncher

import java.time.ZoneId

data class BotTile(val line: BotLine, val status: String)

sealed interface TileGridState {
  data object SignedOut : TileGridState
  data object Empty : TileGridState
  data class Data(
    val title: String,
    val side: String,
    val asOf: String,
    val tiles: List<BotTile>,
    /** "CPU 23% · RAM 11/32 GB · 54°", or empty when the laptop reports nothing. */
    val laptop: String,
    val gaming: String,
    /** "62%", the further spent of the two windows, or empty. */
    val usage: String,
    val usageHot: Boolean,
  ) : TileGridState
}

/** Widget 3, the Tile grid: one tile per bot, the two machines in a line each, and usage in a word. */
object TileGridModel {
  const val MAX_TILES = 6

  fun build(feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): TileGridState {
    if (feed == null) return TileGridState.SignedOut
    val lines = WidgetCommon.lines(feed, now)
    if (lines.isEmpty() && feed.laptop == null) return TileGridState.Empty
    val worst = listOfNotNull(feed.usage?.sessionPct, feed.usage?.weekPct).maxOrNull()
    return TileGridState.Data(
      title = WidgetCommon.TITLE,
      side = WidgetCommon.counts(lines),
      asOf = WidgetCommon.asOf(feed, now, zone),
      tiles = lines.take(MAX_TILES).map { BotTile(it, status(it)) },
      laptop = feed.laptop?.let { machine(it, null) }.orEmpty(),
      gaming = feed.gamingPc?.let { machine(it, it.users.firstOrNull()) }.orEmpty(),
      usage = worst?.let { "$it%" }.orEmpty(),
      usageHot = (worst ?: 0) >= WidgetCommon.HOT_PCT,
    )
  }

  private fun status(line: BotLine): String = when (line.tone) {
    BotTone.WORKING -> line.time.ifEmpty { "working" }
    BotTone.WAITING -> "needs you"
    BotTone.IDLE -> if (line.sub.endsWith("unread")) line.sub else "idle"
  }

  fun machine(machine: WidgetMachine, user: String?): String = listOfNotNull(
    machine.cpuPct?.let { "CPU $it%" },
    if (machine.memUsedGB != null && machine.memTotalGB != null) "RAM ${machine.memUsedGB}/${machine.memTotalGB} GB" else null,
    machine.tempC?.let { "$it°" },
    user,
  ).joinToString(" · ")
}
