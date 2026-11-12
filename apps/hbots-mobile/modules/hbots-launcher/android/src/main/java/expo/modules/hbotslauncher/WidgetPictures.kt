package expo.modules.hbotslauncher

import java.time.ZoneId

/** The eight widgets by key, and what each would draw. No Android types. */
object WidgetPictures {
  const val BOARD = "board"
  const val NEEDS = "needs"
  const val TILES = "tiles"
  const val ASK = "ask"
  const val USAGE = "usage"
  const val BOT = "bot"
  const val MACHINES = "machines"
  const val TODAY = "today"

  fun all(feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): Map<String, Any> = linkedMapOf(
    BOARD to WidgetModel.build(feed, now, zone),
    NEEDS to NeedsYouModel.build(feed, now, zone),
    TILES to TileGridModel.build(feed, now, zone),
    ASK to QuickAskModel.build(feed),
    USAGE to UsageModel.build(feed, now, zone),
    BOT to OneBotModel.build(feed, now, zone),
    MACHINES to MachinesModel.build(feed, now, zone),
    TODAY to TodayModel.build(feed, now, zone),
  )

  /** Stands for a drawn picture without keeping its text a second time. */
  fun signature(model: Any): String = model.toString().hashCode().toString()

  /**
   * The widgets whose picture differs from the one last drawn. A heartbeat with the same feed
   * names none; a working bot's minute count names the widgets that show it, once a minute.
   */
  fun changed(drawn: Map<String, String?>, feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): Set<String> =
    all(feed, now, zone).filter { (key, model) -> drawn[key] != signature(model) }.keys
}

/** How much of a list a resized widget has room for. */
object WidgetFit {
  /** Rows of `rowDp` that fit in `heightDp` once `reservedDp` is taken. An unknown height fits them all. */
  fun rows(heightDp: Int, reservedDp: Int, rowDp: Int, wanted: Int, min: Int = 1): Int {
    if (heightDp <= 0) return wanted
    return ((heightDp - reservedDp) / rowDp).coerceIn(minOf(min, wanted), wanted)
  }
}
