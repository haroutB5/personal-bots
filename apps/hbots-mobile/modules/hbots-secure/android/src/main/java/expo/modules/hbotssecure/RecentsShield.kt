package expo.modules.hbotssecure

/** What the window must do for the current state: FLAG_SECURE and the Recents thumbnail. */
data class WindowShield(val flagSecure: Boolean, val recentsScreenshotAllowed: Boolean)

/**
 * With the app lock on, the window is shielded for the whole life of the
 * activity. The system takes the Recents thumbnail when the user leaves for the
 * Overview screen, which is before the activity reports that it went to the
 * background, so a shield that waits for the background comes too late.
 */
fun shieldFor(secureScreen: Boolean, appLockOn: Boolean): WindowShield =
  WindowShield(flagSecure = secureScreen || appLockOn, recentsScreenshotAllowed = !appLockOn)
