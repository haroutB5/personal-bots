package expo.modules.hbotsvoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallLeaseTest {
  private var now = 10_000L
  private val lease = CallLease { now }

  @Test
  fun aNewCallHoldsTheMicForTheConnectLeaseAndNoLonger() {
    lease.begin()
    now = 10_000L + 44_999L
    assertNull(lease.due())
    now = 10_000L + 45_000L
    assertEquals(Deadline.CONNECT, lease.due())
  }

  @Test
  fun aLeaseTheCallMovesWinsUntilItsOwnTime() {
    lease.begin()
    lease.set(Deadline.QUIET, 10_000L + 120_000L)
    now = 10_000L + 119_999L
    assertNull(lease.due())
    now = 10_000L + 120_000L
    assertEquals(Deadline.QUIET, lease.due())
  }

  @Test
  fun aLeaseBeyondTheCeilingIsCutAtTheCeilingAndReportsTheLimit() {
    lease.begin()
    lease.set(Deadline.QUIET, 10_000L + 40 * 60_000L)
    now = 10_000L + CallLease.CEILING_MS - 1
    assertNull(lease.due())
    now = 10_000L + CallLease.CEILING_MS
    assertEquals(Deadline.LIMIT, lease.due())
  }

  @Test
  fun aClearedLeaseIsNeverDue() {
    lease.begin()
    lease.clear()
    now = 10_000L + 60 * 60_000L
    assertNull(lease.due())
  }
}
