package expo.modules.hbotsvoice

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallMarkerTest {
  private val context: Context = RuntimeEnvironment.getApplication()

  @Test
  fun clearingTheMarkerKeepsHowTheCallEndedUntilItIsTaken() {
    CallMarker.set(context)
    CallMarker.setLastEnd(context, "deadline_connect", 5_000L, 1_700_000_000_000L)
    CallMarker.clear(context)
    assertFalse(CallMarker.isSet(context))
    val taken = CallMarker.takeLastEnd(context)
    assertEquals("deadline_connect", taken?.get("reason"))
    assertEquals(5_000.0, taken?.get("atElapsedMs"))
    assertNull(CallMarker.takeLastEnd(context))
  }

  @Test
  fun signingOutForgetsHowTheLastCallEnded() {
    CallMarker.setLastEnd(context, "deadline_quiet", 1L, 2L)
    CallMarker.wipe(context)
    assertNull(CallMarker.takeLastEnd(context))
    assertTrue(!CallMarker.isSet(context))
  }
}
