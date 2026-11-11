package expo.modules.hbotsvoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class RecordingEffects : CallEffects {
  val log = mutableListOf<String>()
  var marker = false
  var lastEnd: EndReason? = null

  override fun startService(botName: String) { log.add("start:$botName") }
  override fun stopService() { log.add("stop") }
  override fun holdAudio() { log.add("hold") }
  override fun resumeAudio() { log.add("resume") }
  override fun writeMarker() { marker = true; log.add("marker+") }
  override fun clearMarker() { marker = false; log.add("marker-") }
  override fun writeLastEnd(reason: EndReason) { lastEnd = reason; log.add("lastEnd:${reason.wire}") }
  override fun ended(reason: EndReason) { log.add("ended:${reason.wire}") }
}

class CallStateMachineTest {
  private fun tap(
    botName: String = "CTO",
    userInitiated: Boolean = true,
    foreground: Boolean = true,
    mic: Boolean = true,
  ) = CallEvent.StartRequested(botName, userInitiated, foreground, mic)

  private fun live(effects: RecordingEffects = RecordingEffects()): Pair<CallRuntime, RecordingEffects> {
    val runtime = CallRuntime(effects)
    runtime.dispatch(tap())
    runtime.dispatch(CallEvent.ServiceStarted)
    effects.log.clear()
    return runtime to effects
  }

  @Test
  fun aTapInTheForegroundWithTheMicrophoneStartsTheService() {
    val effects = RecordingEffects()
    val runtime = CallRuntime(effects)
    runtime.dispatch(tap())
    assertEquals(CallState.Starting("CTO"), runtime.state)
    assertEquals(listOf("marker+", "start:CTO"), effects.log)
    runtime.dispatch(CallEvent.ServiceStarted)
    assertEquals(CallState.Live("CTO", onHold = false), runtime.state)
  }

  @Test
  fun aStartThatIsNotATapIsRefusedAndNothingStarts() {
    val effects = RecordingEffects()
    val runtime = CallRuntime(effects)
    val result = runtime.dispatch(tap(userInitiated = false))
    assertEquals(listOf<CallEffect>(CallEffect.Rejected(StartRejection.NOT_USER_TAP)), result)
    assertEquals(CallState.Idle, runtime.state)
    assertTrue(effects.log.isEmpty())
  }

  @Test
  fun aStartFromTheBackgroundIsRefused() {
    val runtime = CallRuntime(RecordingEffects())
    val result = runtime.dispatch(tap(foreground = false))
    assertEquals(listOf<CallEffect>(CallEffect.Rejected(StartRejection.BACKGROUND)), result)
    assertEquals(CallState.Idle, runtime.state)
  }

  @Test
  fun aStartWithoutTheMicrophoneIsRefused() {
    val runtime = CallRuntime(RecordingEffects())
    val result = runtime.dispatch(tap(mic = false))
    assertEquals(listOf<CallEffect>(CallEffect.Rejected(StartRejection.NO_PERMISSION)), result)
  }

  @Test
  fun aSecondStartWhileACallRunsIsBusyAndKeepsTheFirst() {
    val (runtime, effects) = live()
    val result = runtime.dispatch(tap(botName = "Other"))
    assertEquals(listOf<CallEffect>(CallEffect.Rejected(StartRejection.BUSY)), result)
    assertEquals(CallState.Live("CTO", onHold = false), runtime.state)
    assertTrue(effects.log.isEmpty())
  }

  @Test
  fun hangUpStopsTheServiceClearsTheMarkerAndReportsOnce() {
    val (runtime, effects) = live()
    runtime.dispatch(CallEvent.Stop(EndReason.HUNG_UP))
    runtime.dispatch(CallEvent.Stop(EndReason.HUNG_UP))
    assertEquals(listOf("stop", "marker-", "ended:hung_up"), effects.log)
    assertEquals(CallState.Stopping(EndReason.HUNG_UP), runtime.state)
    runtime.dispatch(CallEvent.ServiceDestroyed)
    assertEquals(CallState.Idle, runtime.state)
    assertEquals(false, effects.marker)
  }

  @Test
  fun signOutEndsALiveCallWithItsOwnReason() {
    val (runtime, effects) = live()
    runtime.dispatch(CallEvent.Stop(EndReason.SIGNED_OUT))
    assertEquals(listOf("stop", "marker-", "ended:signed_out"), effects.log)
  }

  @Test
  fun signOutWithNoCallStillClearsTheMarkerAndReportsNothing() {
    val effects = RecordingEffects()
    effects.marker = true
    val runtime = CallRuntime(effects)
    runtime.dispatch(CallEvent.Stop(EndReason.SIGNED_OUT))
    assertEquals(listOf("marker-"), effects.log)
    assertEquals(false, effects.marker)
  }

  @Test
  fun aRevokedMicrophoneEndsTheCallAndAGrantedOneDoesNot() {
    val (runtime, effects) = live()
    runtime.dispatch(CallEvent.MicPermissionChanged(true))
    assertTrue(effects.log.isEmpty())
    runtime.dispatch(CallEvent.MicPermissionChanged(false))
    assertEquals(listOf("stop", "marker-", "ended:permission_revoked"), effects.log)
  }

  @Test
  fun aServiceThatDiesUnderALiveCallEndsItAsFailed() {
    val (runtime, effects) = live()
    runtime.dispatch(CallEvent.ServiceDestroyed)
    assertEquals(CallState.Idle, runtime.state)
    assertEquals(listOf("marker-", "ended:failed"), effects.log)
  }

  @Test
  fun aStopWhileStartingWinsOverTheLateServiceStart() {
    val effects = RecordingEffects()
    val runtime = CallRuntime(effects)
    runtime.dispatch(tap())
    runtime.dispatch(CallEvent.Stop(EndReason.HUNG_UP))
    runtime.dispatch(CallEvent.ServiceStarted)
    assertEquals(CallState.Stopping(EndReason.HUNG_UP), runtime.state)
  }

  @Test
  fun aTransientFocusLossHoldsTheCallAndRegainResumesIt() {
    val (runtime, effects) = live()
    runtime.dispatch(CallEvent.FocusLostTransient)
    runtime.dispatch(CallEvent.FocusLostTransient)
    assertEquals(CallState.Live("CTO", onHold = true), runtime.state)
    assertEquals(listOf("hold"), effects.log)
    runtime.dispatch(CallEvent.FocusRegained)
    runtime.dispatch(CallEvent.FocusRegained)
    assertEquals(CallState.Live("CTO", onHold = false), runtime.state)
    assertEquals(listOf("hold", "resume"), effects.log)
  }

  @Test
  fun focusEventsOutsideALiveCallDoNothing() {
    val effects = RecordingEffects()
    val runtime = CallRuntime(effects)
    runtime.dispatch(CallEvent.FocusLostTransient)
    runtime.dispatch(CallEvent.FocusRegained)
    assertEquals(CallState.Idle, runtime.state)
    assertTrue(effects.log.isEmpty())
  }

  @Test
  fun aProcessThatDiedMidCallReportsItOnceOnTheNextStart() {
    val effects = RecordingEffects()
    effects.marker = true
    val runtime = CallRuntime(effects)
    runtime.dispatch(CallEvent.ProcessStarted(markerPresent = true))
    assertEquals(listOf("marker-", "ended:process_recovered"), effects.log)
    effects.log.clear()
    runtime.dispatch(CallEvent.ProcessStarted(markerPresent = false))
    assertTrue(effects.log.isEmpty())
  }

  @Test
  fun awaitLiveAnswersWhenTheCallGoesLiveOrIsRefused() {
    val runtime = CallRuntime(RecordingEffects())
    val answers = mutableListOf<Boolean>()
    runtime.dispatch(tap())
    runtime.awaitLive { answers.add(it) }
    assertTrue(answers.isEmpty())
    runtime.dispatch(CallEvent.ServiceStarted)
    assertEquals(listOf(true), answers)
    runtime.awaitLive { answers.add(it) }
    assertEquals(listOf(true, true), answers)

    val second = CallRuntime(RecordingEffects())
    val failed = mutableListOf<Boolean>()
    second.dispatch(tap())
    second.awaitLive { failed.add(it) }
    second.dispatch(CallEvent.Stop(EndReason.FOCUS_LOST))
    assertEquals(listOf(false), failed)
  }

  @Test
  fun wireNamesMatchWhatTheScreensRead() {
    assertEquals("idle", CallState.Idle.wire)
    assertEquals("starting", CallState.Starting("x").wire)
    assertEquals("live", CallState.Live("x", false).wire)
    assertEquals("held", CallState.Live("x", true).wire)
    assertEquals("stopping", CallState.Stopping(EndReason.HUNG_UP).wire)
  }

  private var elapsed = 5_000L

  private fun leased(effects: RecordingEffects = RecordingEffects()): Pair<CallRuntime, RecordingEffects> {
    val runtime = CallRuntime(effects) { elapsed }
    runtime.dispatch(tap())
    return runtime to effects
  }

  @Test
  fun aCallThatNeverGoesLiveEndsOnTheConnectLeaseWithoutAnyHelpFromJs() {
    val (runtime, effects) = leased()
    effects.log.clear()
    elapsed = 5_000L + 44_999L
    runtime.checkLease()
    assertEquals(CallState.Starting("CTO"), runtime.state)
    elapsed = 5_000L + 45_000L
    runtime.checkLease()
    assertEquals(CallState.Stopping(EndReason.DEADLINE_CONNECT), runtime.state)
    assertEquals(
      listOf("stop", "marker-", "lastEnd:deadline_connect", "ended:deadline_connect"),
      effects.log,
    )
  }

  @Test
  fun aLeaseJsMovesKeepsALiveCallOpenUntilTheNewTime() {
    val (runtime, effects) = leased()
    runtime.dispatch(CallEvent.ServiceStarted)
    runtime.dispatch(CallEvent.LeaseSet(Deadline.QUIET, 5_000L + 120_000L))
    effects.log.clear()
    elapsed = 5_000L + 100_000L
    runtime.checkLease()
    assertEquals(CallState.Live("CTO", onHold = false), runtime.state)
    assertTrue(effects.log.isEmpty())
    elapsed = 5_000L + 120_000L
    runtime.checkLease()
    assertEquals(CallState.Stopping(EndReason.DEADLINE_QUIET), runtime.state)
    assertEquals("deadline_quiet", EndReason.DEADLINE_QUIET.wire)
  }

  @Test
  fun theLastEndSurvivesTheMarkerBeingCleared() {
    val (runtime, effects) = leased()
    elapsed = 5_000L + 45_000L
    runtime.checkLease()
    assertEquals(EndReason.DEADLINE_CONNECT, effects.lastEnd)
    assertEquals(false, effects.marker)
  }

  @Test
  fun aLeaseSetAfterTheCallStoppedChangesNothing() {
    val (runtime, effects) = leased()
    runtime.dispatch(CallEvent.Stop(EndReason.HUNG_UP))
    effects.log.clear()
    runtime.dispatch(CallEvent.LeaseSet(Deadline.QUIET, 5_000L + 120_000L))
    elapsed = 5_000L + 500_000L
    runtime.checkLease()
    assertEquals(CallState.Stopping(EndReason.HUNG_UP), runtime.state)
    assertTrue(effects.log.isEmpty())
  }

  @Test
  fun aDueDeadlineStopsALiveCallWithItsOwnReasonAndTheLastEndOutlivesTheService() {
    val (runtime, effects) = live()
    runtime.dispatch(CallEvent.DeadlineDue(Deadline.QUIET))
    assertEquals(CallState.Stopping(EndReason.DEADLINE_QUIET), runtime.state)
    assertEquals(
      listOf("stop", "marker-", "lastEnd:deadline_quiet", "ended:deadline_quiet"),
      effects.log,
    )
    runtime.dispatch(CallEvent.ServiceDestroyed)
    assertEquals(CallState.Idle, runtime.state)
    assertEquals(EndReason.DEADLINE_QUIET, effects.lastEnd)
  }

  @Test
  fun everyDeadlineKindHasItsOwnWireReason() {
    assertEquals(
      listOf(
        "deadline_connect",
        "deadline_quiet",
        "deadline_waiting_cap",
        "deadline_reconnect",
        "deadline_limit",
      ),
      Deadline.values().map { it.endReason().wire },
    )
  }
}
