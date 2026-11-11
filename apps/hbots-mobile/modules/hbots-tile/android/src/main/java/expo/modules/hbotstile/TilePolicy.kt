package expo.modules.hbotstile

/** First Android version whose TileService opens an activity through a PendingIntent that the system unlocks for. */
internal const val FIRST_SDK_WITH_SYSTEM_UNLOCK = 34

/**
 * Whether the tile must ask the system to unlock the phone before it opens the app.
 *
 * Before Android 14, startActivityAndCollapse(Intent) starts the activity from
 * the tile service itself and never touches the keyguard, so a locked phone
 * must unlock first (unlockAndRun). From Android 14, startActivityAndCollapse(PendingIntent)
 * hands the start to SystemUI, which dismisses the keyguard itself and starts
 * the activity once the user has unlocked. A second unlock request on top of
 * that raced the first one and the start was dropped (Verifier, round 2).
 */
internal fun unlockFirst(locked: Boolean, sdk: Int): Boolean =
  locked && sdk < FIRST_SDK_WITH_SYSTEM_UNLOCK
