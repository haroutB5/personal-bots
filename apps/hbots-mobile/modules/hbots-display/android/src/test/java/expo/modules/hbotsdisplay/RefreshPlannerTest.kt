package expo.modules.hbotsdisplay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshPlannerTest {
  private fun mode(id: Int, rate: Float, w: Int = 1080, h: Int = 2400) = DisplayMode(id, w, h, rate)

  @Test fun aSingleModeHasNothingToAskFor() {
    val modes = listOf(mode(1, 60f))
    assertFalse(RefreshPlanner.hasHighMode(modes, 1))
    assertNull(RefreshPlanner.highModeId(modes, 1))
  }

  @Test fun sixtyAndOneTwentyAsksForOneTwenty() {
    val modes = listOf(mode(1, 60f), mode(2, 120f))
    assertTrue(RefreshPlanner.hasHighMode(modes, 1))
    assertEquals(2, RefreshPlanner.highModeId(modes, 1))
  }

  @Test fun theFastestOfSeveralRatesWins() {
    val modes = listOf(mode(1, 60f), mode(2, 90f), mode(3, 120f))
    assertEquals(3, RefreshPlanner.highModeId(modes, 1))
  }

  @Test fun holdingTheFastModeStillKeepsItAvailable() {
    val modes = listOf(mode(1, 60f), mode(2, 120f))
    assertTrue(RefreshPlanner.hasHighMode(modes, 2))
    assertEquals(2, RefreshPlanner.highModeId(modes, 2))
  }

  @Test fun aFasterModeAtAnotherResolutionDoesNotCount() {
    val modes = listOf(mode(1, 60f), mode(2, 120f, w = 720, h = 1600))
    assertFalse(RefreshPlanner.hasHighMode(modes, 1))
    assertNull(RefreshPlanner.highModeId(modes, 1))
  }

  @Test fun ratesWithinAHertzAreOneRate() {
    val modes = listOf(mode(1, 59.94f), mode(2, 60f))
    assertFalse(RefreshPlanner.hasHighMode(modes, 1))
    assertNull(RefreshPlanner.highModeId(modes, 1))
  }

  @Test fun anUnknownCurrentModeAsksForNothing() {
    val modes = listOf(mode(1, 60f), mode(2, 120f))
    assertFalse(RefreshPlanner.hasHighMode(modes, 9))
    assertNull(RefreshPlanner.highModeId(modes, 9))
  }

  @Test fun noModesAtAll() {
    assertFalse(RefreshPlanner.hasHighMode(emptyList(), 1))
    assertNull(RefreshPlanner.highModeId(emptyList(), 1))
  }
}
