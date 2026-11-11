package expo.modules.hbotssecure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecentsShieldTest {
  @Test fun withTheAppLockOnTheWindowIsShieldedInTheForegroundToo() {
    val shield = shieldFor(secureScreen = false, appLockOn = true)

    assertTrue(shield.flagSecure)
    assertFalse(shield.recentsScreenshotAllowed)
  }

  @Test fun withTheAppLockOffAnOrdinaryScreenIsNotShielded() {
    assertEquals(WindowShield(flagSecure = false, recentsScreenshotAllowed = true), shieldFor(false, false))
  }

  @Test fun aSecretScreenIsShieldedEvenWithTheAppLockOff() {
    val shield = shieldFor(secureScreen = true, appLockOn = false)

    assertTrue(shield.flagSecure)
    assertTrue(shield.recentsScreenshotAllowed)
  }
}
