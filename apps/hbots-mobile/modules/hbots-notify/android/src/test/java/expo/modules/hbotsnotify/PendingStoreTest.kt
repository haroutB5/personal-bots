package expo.modules.hbotsnotify

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PendingStoreTest {
  @Before fun reset() = PendingStore.clearAll()

  @Test fun theFirstTapRunsAndASecondOneWhileItIsOnItsWayIsAbsorbed() {
    assertTrue(PendingStore.admit("n1", now = 1_000))
    assertFalse(PendingStore.admit("n1", now = 1_050))
    assertFalse(PendingStore.admit("n1", now = 5_000))
  }

  @Test fun aTapOnAnotherNotificationIsNotAbsorbed() {
    assertTrue(PendingStore.admit("n1", now = 1_000))
    assertTrue(PendingStore.admit("n2", now = 1_010))
  }

  @Test fun aTapJustAfterAnAnswerThatWentThroughIsStillAbsorbed() {
    assertTrue(PendingStore.admit("n1", now = 1_000))
    PendingStore.release("n1", final = true, now = 2_000)
    assertFalse(PendingStore.admit("n1", now = 2_500))
    assertTrue(PendingStore.admit("n1", now = 2_000 + PendingStore.SETTLED_MS))
  }

  @Test fun aRefusedOrRetryableTapCanBeTappedAgain() {
    assertTrue(PendingStore.admit("n1", now = 1_000))
    PendingStore.release("n1", final = false, now = 2_000)
    assertTrue(PendingStore.admit("n1", now = 2_100))
  }

  @Test fun anActionThatNeverReportedBackStopsBlockingAfterTwoMinutes() {
    assertTrue(PendingStore.admit("n1", now = 1_000))
    assertFalse(PendingStore.admit("n1", now = 1_000 + PendingStore.IN_FLIGHT_MAX_MS - 1))
    assertTrue(PendingStore.admit("n1", now = 1_000 + PendingStore.IN_FLIGHT_MAX_MS))
  }
}
