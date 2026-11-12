package expo.modules.hbotslauncher

import java.time.ZoneId

sealed interface QuickAskState {
  data object SignedOut : QuickAskState
  data class Ready(val label: String, val askLink: String, val photoLink: String, val voiceLink: String) : QuickAskState
}

/** Widget A, Quick ask. A widget cannot hold a text field, so the pill opens a new chat in the app. */
object QuickAskModel {
  const val LABEL = "Ask hbots…"

  fun build(feed: WidgetFeed?): QuickAskState =
    if (feed == null) QuickAskState.SignedOut
    else QuickAskState.Ready(LABEL, WidgetCommon.newChatLink("keyboard"), WidgetCommon.newChatLink("photo"), WidgetCommon.newChatLink("voice"))
}

sealed interface UsageState {
  data object SignedOut : UsageState
  data object Empty : UsageState
  data class Data(
    val title: String,
    /** The headline figure and which window it is. */
    val big: String,
    val bigLabel: String,
    val bigPct: Int,
    val hot: Boolean,
    /** The weekly bar, when the headline is the session. */
    val week: WidgetGauge?,
    /** "Resets 17:10", or empty. */
    val resets: String,
    val asOf: String,
    val description: String,
  ) : UsageState
}

/** Widget B, Usage. Read-only: it has no Redeem control and asks no provider anything. */
object UsageModel {
  const val EMPTY_TEXT = "No usage figures yet"

  fun build(feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): UsageState {
    if (feed == null) return UsageState.SignedOut
    val usage = feed.usage ?: return UsageState.Empty
    val session = usage.sessionPct
    val headline = session ?: usage.weekPct ?: return UsageState.Empty
    val week = if (session == null) null else WidgetCommon.gauge("Week", usage.weekPct)
    val label = if (session == null) "week" else "session"
    return UsageState.Data(
      title = usage.title.ifEmpty { "Usage" },
      big = "$headline%",
      bigLabel = label,
      bigPct = headline,
      hot = headline >= WidgetCommon.HOT_PCT,
      week = week,
      resets = if (session != null && usage.resets.isNotEmpty()) "Resets ${usage.resets}" else "",
      asOf = WidgetCommon.asOf(feed, now, zone),
      description = "Usage: $label $headline percent used" + (week?.let { ", week ${it.pct} percent used" } ?: ""),
    )
  }
}

sealed interface OneBotState {
  data object SignedOut : OneBotState
  data object Empty : OneBotState
  data class Data(val line: BotLine, val status: String, val asOf: String) : OneBotState
}

/** Widget C, One bot: the first working bot, else the first waiting, else the first pinned. No setup screen. */
object OneBotModel {
  const val EMPTY_TEXT = "Pin a bot to see it here"

  fun build(feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): OneBotState {
    if (feed == null) return OneBotState.SignedOut
    val line = WidgetCommon.lines(feed, now).firstOrNull() ?: return OneBotState.Empty
    val status = when (line.tone) {
      BotTone.WORKING -> if (line.time.isEmpty()) "Working" else "Working · ${line.time}"
      BotTone.WAITING -> "Needs you"
      BotTone.IDLE -> "Idle"
    }
    return OneBotState.Data(line, status, WidgetCommon.asOf(feed, now, zone))
  }
}

data class MachinePanel(val title: String, val sub: String, val gauges: List<WidgetGauge>)

sealed interface MachinesState {
  data object SignedOut : MachinesState
  data object Empty : MachinesState
  data class Data(val laptop: MachinePanel, val gaming: MachinePanel, val asOf: String) : MachinesState
}

/** Widget D, Machines: the laptop and the gaming PC, as the app last read them. */
object MachinesModel {
  const val EMPTY_TEXT = "Open hbots for machine figures"
  const val GAMING_OFF = "Off or not reporting"

  fun build(feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): MachinesState {
    if (feed == null) return MachinesState.SignedOut
    val laptop = feed.laptop ?: return MachinesState.Empty
    val pc = feed.gamingPc
    return MachinesState.Data(
      laptop = MachinePanel(
        "Laptop",
        listOfNotNull(laptop.tempC?.let { "$it°" }, laptop.diskFreeGB?.let { "disk $it GB free" }).joinToString(" · "),
        gauges(laptop),
      ),
      gaming = MachinePanel(
        "Gaming PC",
        when {
          pc == null -> GAMING_OFF
          pc.users.isEmpty() -> "Free"
          else -> "In use: ${pc.users.joinToString(", ")}"
        },
        pc?.let { gauges(it) + listOfNotNull(WidgetCommon.gauge("GPU", it.gpuPct)) }.orEmpty(),
      ),
      asOf = WidgetCommon.asOf(feed, now, zone),
    )
  }

  private fun gauges(machine: WidgetMachine): List<WidgetGauge> = listOfNotNull(
    WidgetCommon.gauge("CPU", machine.cpuPct),
    ram(machine),
  )

  private fun ram(machine: WidgetMachine): WidgetGauge? {
    val used = machine.memUsedGB ?: return null
    val total = machine.memTotalGB?.takeIf { it > 0 } ?: return null
    return WidgetCommon.gauge("RAM", (used * 100 / total).coerceIn(0, 100), "$used/$total")
  }
}

data class TodayRow(val failed: Boolean, val title: String, val meta: String)

sealed interface TodayState {
  data object SignedOut : TodayState
  data object Empty : TodayState
  data class Data(
    val side: String,
    val rows: List<TodayRow>,
    val nextTitle: String,
    val nextMeta: String,
    val asOf: String,
  ) : TodayState
}

/** Widget E, Today: what finished today and the routine that runs next. */
object TodayModel {
  const val TITLE = "Today"
  const val EMPTY_TEXT = "Nothing finished today"
  const val NOTHING_YET = "Nothing finished yet"

  fun build(feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): TodayState {
    if (feed == null) return TodayState.SignedOut
    val today = feed.today ?: return TodayState.Empty
    // A feed from yesterday knows nothing about today: its counts are dropped, its next routine kept.
    val sameDay = feed.updatedAt >= WidgetCommon.startOfDay(now, zone)
    val rows = if (!sameDay) emptyList() else today.events.map { event ->
      TodayRow(
        failed = event.failed,
        title = event.title.ifEmpty { if (event.failed) "A task failed" else "A task finished" },
        meta = listOf(event.bot, WidgetCommon.clock(event.atMs, zone)).filter { it.isNotEmpty() }.joinToString(" · "),
      )
    }
    val hasNext = today.nextAtMs > now
    if (rows.isEmpty() && !hasNext && today.running == 0) return TodayState.Empty
    val side = if (!sameDay) "" else listOfNotNull(
      if (today.done > 0) "${today.done} done" else null,
      if (today.failed > 0) "${today.failed} failed" else null,
      if (today.running > 0) "${today.running} running" else null,
    ).joinToString(" · ")
    return TodayState.Data(
      side = side,
      rows = rows,
      nextTitle = if (hasNext) today.nextTitle.ifEmpty { "Routine" } else "",
      nextMeta = if (hasNext) "Routine · ${WidgetCommon.dayClock(today.nextAtMs, now, zone)}" else "",
      asOf = WidgetCommon.asOf(feed, now, zone),
    )
  }
}
