package expo.modules.hbotstile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TilePolicyTest {
  @Test fun anUnlockedPhoneNeverAsksForAnUnlock() {
    for (sdk in listOf(26, 33, 34, 35, 36)) assertFalse("sdk $sdk", unlockFirst(locked = false, sdk = sdk))
  }

  @Test fun beforeAndroid14ALockedPhoneUnlocksFirst() {
    assertTrue(unlockFirst(locked = true, sdk = 26))
    assertTrue(unlockFirst(locked = true, sdk = 33))
  }

  @Test fun fromAndroid14TheSystemUnlocksInsideTheStartSoTheTileDoesNotAskTwice() {
    assertFalse(unlockFirst(locked = true, sdk = 34))
    assertFalse(unlockFirst(locked = true, sdk = 35))
    assertFalse(unlockFirst(locked = true, sdk = 36))
  }

  @Test fun theBoundaryIsAndroid14() {
    assertEquals(34, FIRST_SDK_WITH_SYSTEM_UNLOCK)
  }
}
