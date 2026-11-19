package expo.modules.hbotstextselect

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DismissalTest {
  private fun selected(): Dismissal = Dismissal().also { it.selectionChanged(true, 0) }

  @Test
  fun backDismissingTheToolbarCountsOnce() {
    val dismissal = selected()
    dismissal.selectionChanged(false, 1000)
    assertTrue(dismissal.consume(1020))
    assertFalse(dismissal.consume(1030))
  }

  @Test
  fun aBackHeardAfterTheWindowClosesTheSheet() {
    val dismissal = selected()
    dismissal.selectionChanged(false, 1000)
    assertFalse(dismissal.consume(1000 + Dismissal.WINDOW_MS))
  }

  @Test
  fun copyDoesNotCountEvenRightAway() {
    val dismissal = selected()
    dismissal.during(Cause.Item)
    dismissal.selectionChanged(false, 1000)
    dismissal.during(null)
    assertFalse(dismissal.consume(1001))
  }

  @Test
  fun aTapDoesNotCount() {
    val dismissal = selected()
    dismissal.during(Cause.Touch)
    dismissal.selectionChanged(false, 1000)
    dismissal.during(null)
    assertFalse(dismissal.consume(1001))
  }

  @Test
  fun ourOwnClearDoesNotCount() {
    val dismissal = selected()
    dismissal.during(Cause.Cleared)
    dismissal.selectionChanged(false, 1000)
    dismissal.during(null)
    assertFalse(dismissal.consume(1001))
  }

  @Test
  fun aNewSelectionForgetsTheDismissal() {
    val dismissal = selected()
    dismissal.selectionChanged(false, 1000)
    dismissal.selectionChanged(true, 1010)
    assertFalse(dismissal.consume(1020))
  }

  @Test
  fun aTouchAfterTheDismissalForgetsIt() {
    val dismissal = selected()
    dismissal.selectionChanged(false, 1000)
    dismissal.during(Cause.Touch)
    dismissal.during(null)
    assertFalse(dismissal.consume(1010))
  }

  @Test
  fun aCollapseWithNoSelectionBeforeDoesNotCount() {
    val dismissal = Dismissal()
    dismissal.selectionChanged(false, 1000)
    assertFalse(dismissal.consume(1001))
  }
}
