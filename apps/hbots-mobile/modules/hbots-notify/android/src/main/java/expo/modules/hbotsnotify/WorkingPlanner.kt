package expo.modules.hbotsnotify

/** One bot that is running, as JS reports it. `note` is its current step, if JS had one. */
data class WorkingBot(val botId: String, val name: String, val note: String?)

/** What the "bots working" notification shows, as data. */
data class WorkingPlan(
  val title: String,
  /** The lines of the expanded inbox, at most [WorkingPlanner.MAX_LINES]. */
  val lines: List<String>,
  /** "+2 more" when the bots do not all fit, else null. */
  val summary: String?,
  /** What the lock screen shows: no bot name, no note. */
  val publicText: String,
  val count: Int,
)

object WorkingPlanner {
  const val STOP_LINK = "hbots://stop"
  const val PUBLIC_TITLE = "hbots"
  const val PUBLIC_TEXT = "Bots are working"
  const val MAX_LINES = 5
  const val MAX_BOTS = 8
  private const val MAX_NAME = 40
  private const val MAX_NOTE = 80
  private const val WORKING_LINE = "Working…"

  /** Reads what the JS module passes: a list of maps. A bad entry is dropped, never guessed at. */
  fun parse(raw: List<Map<String, Any?>>): List<WorkingBot> {
    val seen = LinkedHashMap<String, WorkingBot>()
    for (entry in raw) {
      if (seen.size >= MAX_BOTS) break
      val id = (entry["botId"] as? String)?.trim().orEmpty()
      if (id.isEmpty() || id in seen) continue
      val name = clean(entry["name"] as? String, MAX_NAME).ifEmpty { "hbots" }
      val note = clean(entry["note"] as? String, MAX_NOTE).ifEmpty { null }
      seen[id] = WorkingBot(id, name, note)
    }
    return seen.values.toList()
  }

  /** Null when nothing is working: there is then no notification at all. */
  fun plan(bots: List<WorkingBot>, policy: NotifyPolicy): WorkingPlan? {
    if (bots.isEmpty()) return null
    val shown = bots.map { line(it, policy) }
    val overflow = shown.size - MAX_LINES
    return WorkingPlan(
      title = if (bots.size == 1) "1 bot working" else "${bots.size} bots working",
      lines = shown.take(MAX_LINES),
      summary = if (overflow > 0) "+$overflow more" else null,
      publicText = PUBLIC_TEXT,
      count = bots.size,
    )
  }

  /** The note shows only when the lock is off and this bot does not hide previews. Unknown bots hide it. */
  private fun line(bot: WorkingBot, policy: NotifyPolicy): String {
    val info = policy.bots[bot.botId]
    val noteAllowed = !policy.appLockOn && info != null && !info.hidePreviews
    val note = bot.note
    return if (noteAllowed && note != null) "${bot.name}: $note" else if (noteAllowed) "${bot.name}: $WORKING_LINE" else bot.name
  }

  private fun clean(text: String?, max: Int): String =
    text.orEmpty().map { if (it.isISOControl()) ' ' else it }.joinToString("").trim().replace(Regex("\\s+"), " ").take(max)
}
