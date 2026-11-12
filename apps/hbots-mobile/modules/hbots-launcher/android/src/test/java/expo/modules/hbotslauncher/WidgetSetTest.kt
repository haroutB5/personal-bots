package expo.modules.hbotslauncher

import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Widgets 2, 3 and A to E. */
class WidgetSetTest {
  private val utc = ZoneId.of("UTC")
  // 2026-11-12 14:44:00 UTC, a Thursday
  private val now = 1_794_494_640_000L
  private val builder = WidgetBot("b", "Builder", true, activity = "Avatar poses", sinceMs = now - 18 * 60_000L)
  private val poteto = WidgetBot("p", "Poteto", false, waiting = true)
  private val cfo = WidgetBot("c", "CFO", false, unread = 3)
  private val question = WidgetQuestion("p", "Poteto", "Hbots", "Ship now, or wait?", listOf("Ship now", "Wait & see"), "hbots://chat/p/t-1", now - 120_000L)
  private fun feed(vararg bots: WidgetBot, at: Long = now) = WidgetFeed(bots.toList(), at)
  private val stale = now - WidgetCommon.FRESH_MS - 60_000L

  // Widget 2
  @Test fun needsYouPutsTheQuestionFirstWithItsChoicesAsDraftLinks() {
    val state = NeedsYouModel.build(feed(builder, poteto).copy(question = question), now, utc) as NeedsYouState.Data
    assertEquals("1 waiting for you", state.headline)
    assertEquals("1 working", state.side)
    val card = state.question!!
    assertEquals("Poteto · Hbots · 14:42", card.meta)
    assertEquals("Ship now, or wait?", card.text)
    assertEquals(
      listOf(WidgetChoice("Ship now", "hbots://chat/p/t-1?draft=Ship%20now"), WidgetChoice("Wait & see", "hbots://chat/p/t-1?draft=Wait%20%26%20see")),
      card.choices,
    )
    assertEquals("hbots://chat/p/t-1", card.openLink)
    assertEquals(listOf("Builder"), state.rows.map { it.name })
  }

  @Test fun needsYouWithNoQuestionSaysSoAndShowsMoreWorkers() {
    val workers = (1..6).map { WidgetBot("w$it", "W$it", true) }
    val state = NeedsYouModel.build(WidgetFeed(workers, now), now, utc) as NeedsYouState.Data
    assertEquals(NeedsYouModel.NOTHING, state.headline)
    assertNull(state.question)
    assertEquals(NeedsYouModel.MAX_ROWS_NO_QUESTION, state.rows.size)
  }

  @Test fun needsYouWordsAQuestionWhoseTextIsHidden() {
    val hidden = question.copy(text = "", chatTitle = "", choices = emptyList(), atMs = 0L)
    val card = (NeedsYouModel.build(feed().copy(question = hidden), now, utc) as NeedsYouState.Data).question!!
    assertEquals("Poteto", card.meta)
    assertEquals(NeedsYouModel.NO_TEXT, card.text)
    assertTrue(card.choices.isEmpty())
  }

  @Test fun needsYouAlwaysOffersANewChatByKeyboardVoiceAndPhoto() {
    val state = NeedsYouModel.build(feed(), now, utc) as NeedsYouState.Data
    assertEquals("hbots://bot/cto?new=1&intent=keyboard", state.askLink)
    assertEquals("hbots://bot/cto?new=1&intent=voice", state.voiceLink)
    assertEquals("hbots://bot/cto?new=1&intent=photo", state.photoLink)
    assertEquals(NeedsYouState.SignedOut, NeedsYouModel.build(null, now, utc))
  }

  // Widget 3
  @Test fun tileGridGivesEachBotATileWithOneWordOfStatus() {
    val state = TileGridModel.build(
      feed(cfo, builder, poteto, WidgetBot("a", "Assistant", false)).copy(
        laptop = WidgetMachine(23, 11, 32, tempC = 54),
        gamingPc = WidgetMachine(32, 12, 16, users = listOf("Builder")),
        usage = WidgetUsage("Claude", 62, 85, ""),
      ),
      now,
      utc,
    ) as TileGridState.Data
    assertEquals("1 working · 1 waiting", state.side)
    assertEquals(listOf("Builder" to "18 min", "Poteto" to "needs you", "CFO" to "3 unread", "Assistant" to "idle"), state.tiles.map { it.line.name to it.status })
    assertEquals("CPU 23% · RAM 11/32 GB · 54°", state.laptop)
    assertEquals("CPU 32% · RAM 12/16 GB · Builder", state.gaming)
    assertEquals("85%", state.usage)
    assertTrue(state.usageHot)
  }

  @Test fun tileGridCapsTheTilesAndHidesWhatHasNoSource() {
    val state = TileGridModel.build(WidgetFeed((1..8).map { WidgetBot("b$it", "B$it", false) }, now), now, utc) as TileGridState.Data
    assertEquals(TileGridModel.MAX_TILES, state.tiles.size)
    assertEquals("", state.laptop)
    assertEquals("", state.gaming)
    assertEquals("", state.usage)
    assertEquals(TileGridState.Empty, TileGridModel.build(feed(), now, utc))
    assertEquals(TileGridState.SignedOut, TileGridModel.build(null, now, utc))
  }

  // Widget A
  @Test fun quickAskOpensANewChatAndNeedsNoData() {
    assertEquals(QuickAskState.SignedOut, QuickAskModel.build(null))
    val ready = QuickAskModel.build(feed()) as QuickAskState.Ready
    assertEquals("hbots://bot/cto?new=1&intent=keyboard", ready.askLink)
    assertEquals(ready, QuickAskModel.build(feed(builder, at = stale)))
  }

  // Widget B
  @Test fun usageLeadsWithTheSessionAndAddsTheWeek() {
    val state = UsageModel.build(feed().copy(usage = WidgetUsage("Claude", 62, 38, "17:10")), now, utc) as UsageState.Data
    assertEquals("62%", state.big)
    assertEquals("session", state.bigLabel)
    assertFalse(state.hot)
    assertEquals(WidgetGauge("Week", "38%", 38, false), state.week)
    assertEquals("Resets 17:10", state.resets)
    assertEquals("", state.asOf)
    assertEquals("Usage: session 62 percent used, week 38 percent used", state.description)
  }

  @Test fun usageFallsBackToTheWeekAndMarksAnOldReading() {
    val state = UsageModel.build(feed(at = stale).copy(usage = WidgetUsage("", null, 91, "17:10")), now, utc) as UsageState.Data
    assertEquals("91%", state.big)
    assertEquals("week", state.bigLabel)
    assertTrue(state.hot)
    assertNull(state.week)
    assertEquals("", state.resets)
    assertEquals("as of 14:41", state.asOf)
    assertEquals("Usage", state.title)
    assertEquals(UsageState.Empty, UsageModel.build(feed(), now, utc))
    assertEquals(UsageState.SignedOut, UsageModel.build(null, now, utc))
  }

  // Widget C
  @Test fun oneBotIsTheFirstWorkingElseWaitingElsePinned() {
    val working = OneBotModel.build(feed(cfo, poteto, builder), now, utc) as OneBotState.Data
    assertEquals("Builder", working.line.name)
    assertEquals("Working · 18 min", working.status)
    val waiting = OneBotModel.build(feed(cfo, poteto), now, utc) as OneBotState.Data
    assertEquals("Needs you", waiting.status)
    val idle = OneBotModel.build(feed(cfo), now, utc) as OneBotState.Data
    assertEquals("Idle", idle.status)
    assertEquals("3 unread", idle.line.sub)
    assertEquals("hbots://bot/c", idle.line.link)
    assertEquals(OneBotState.Empty, OneBotModel.build(feed(), now, utc))
    assertEquals(OneBotState.SignedOut, OneBotModel.build(null, now, utc))
  }

  // Widget D
  @Test fun machinesShowsBothPanelsWithTheirGauges() {
    val state = MachinesModel.build(
      feed().copy(laptop = WidgetMachine(23, 11, 32, tempC = 54, diskFreeGB = 212), gamingPc = WidgetMachine(92, 15, 16, gpuPct = 4, users = listOf("Builder"))),
      now,
      utc,
    ) as MachinesState.Data
    assertEquals("54° · disk 212 GB free", state.laptop.sub)
    assertEquals(listOf(WidgetGauge("CPU", "23%", 23, false), WidgetGauge("RAM", "11/32", 34, false)), state.laptop.gauges)
    assertEquals("In use: Builder", state.gaming.sub)
    assertEquals(listOf(WidgetGauge("CPU", "92%", 92, true), WidgetGauge("RAM", "15/16", 93, true), WidgetGauge("GPU", "4%", 4, false)), state.gaming.gauges)
  }

  @Test fun machinesSaysWhenTheGamingPcIsOffOrFreeAndMarksOldFigures() {
    val laptop = WidgetMachine(null, null, null)
    val off = MachinesModel.build(feed(at = stale).copy(laptop = laptop), now, utc) as MachinesState.Data
    assertEquals(MachinesModel.GAMING_OFF, off.gaming.sub)
    assertTrue(off.gaming.gauges.isEmpty())
    assertTrue(off.laptop.gauges.isEmpty())
    assertEquals("as of 14:41", off.asOf)
    val free = MachinesModel.build(feed().copy(laptop = laptop, gamingPc = WidgetMachine(1, 2, 16)), now, utc) as MachinesState.Data
    assertEquals("Free", free.gaming.sub)
    assertEquals(MachinesState.Empty, MachinesModel.build(feed(), now, utc))
    assertEquals(MachinesState.SignedOut, MachinesModel.build(null, now, utc))
  }

  // Widget E
  @Test fun todayListsWhatFinishedAndTheNextRoutine() {
    val friday = now + 27 * 3_600_000L + 16 * 60_000L
    val today = WidgetToday(4, 1, 2, listOf(WidgetEvent(false, "hbots 1.67.9 is live", "Shipper", now - 9_360_000L), WidgetEvent(true, "", "Verifier", now - 3_840_000L)), "Tennis Friday", friday)
    val state = TodayModel.build(feed().copy(today = today), now, utc) as TodayState.Data
    assertEquals("4 done · 1 failed · 2 running", state.side)
    assertEquals(listOf(TodayRow(false, "hbots 1.67.9 is live", "Shipper · 12:08"), TodayRow(true, "A task failed", "Verifier · 13:40")), state.rows)
    assertEquals("Tennis Friday", state.nextTitle)
    assertEquals("Routine · Fri 18:00", state.nextMeta)
  }

  @Test fun todayForgetsYesterdaysCountsAndARoutineThatAlreadyRan() {
    val today = WidgetToday(4, 0, 0, listOf(WidgetEvent(false, "Old", "Shipper", now - 90_000_000L)), "Past", now - 1)
    assertEquals(TodayState.Empty, TodayModel.build(feed(at = now - 86_400_000L).copy(today = today), now, utc))
    val next = today.copy(nextAtMs = now + 60_000L, nextTitle = "")
    val state = TodayModel.build(feed(at = now - 86_400_000L).copy(today = next), now, utc) as TodayState.Data
    assertEquals("", state.side)
    assertTrue(state.rows.isEmpty())
    assertEquals("Routine", state.nextTitle)
    assertEquals("Routine · 14:45", state.nextMeta)
    assertEquals(TodayState.Empty, TodayModel.build(feed(), now, utc))
    assertEquals(TodayState.SignedOut, TodayModel.build(null, now, utc))
  }

  @Test fun noWidgetModelNamesARedeemControl() {
    val all = listOf(
      NeedsYouModel.build(feed(builder).copy(question = question), now, utc),
      TileGridModel.build(feed(builder), now, utc),
      QuickAskModel.build(feed()),
      UsageModel.build(feed().copy(usage = WidgetUsage("Claude", 62, 38, "17:10")), now, utc),
    ).joinToString(" ")
    assertFalse(all.contains("redeem", ignoreCase = true))
  }
}
