package expo.modules.hbotsvoice

enum class EndReason(val wire: String) {
  HUNG_UP("hung_up"),
  NOTIFICATION_HANGUP("notification_hangup"),
  SIGNED_OUT("signed_out"),
  PERMISSION_REVOKED("permission_revoked"),
  FOCUS_LOST("focus_lost"),
  PROCESS_RECOVERED("process_recovered"),
  FAILED("failed"),
}

enum class StartRejection(val wire: String, val message: String) {
  NOT_USER_TAP("not_user_tap", "A call starts only from a tap."),
  BACKGROUND("background", "A call starts only while the app is open."),
  NO_PERMISSION("no_permission", "The microphone is not allowed."),
  BUSY("busy", "A call is already running."),
}

sealed interface CallState {
  object Idle : CallState
  data class Starting(val botName: String) : CallState
  data class Live(val botName: String, val onHold: Boolean) : CallState
  data class Stopping(val reason: EndReason) : CallState

  val wire: String
    get() = when (this) {
      Idle -> "idle"
      is Starting -> "starting"
      is Live -> if (onHold) "held" else "live"
      is Stopping -> "stopping"
    }
}

sealed interface CallEvent {
  data class StartRequested(
    val botName: String,
    val userInitiated: Boolean,
    val appInForeground: Boolean,
    val micGranted: Boolean,
  ) : CallEvent

  object ServiceStarted : CallEvent
  object ServiceDestroyed : CallEvent
  data class Stop(val reason: EndReason) : CallEvent
  data class MicPermissionChanged(val granted: Boolean) : CallEvent
  object FocusLostTransient : CallEvent
  object FocusRegained : CallEvent
  data class ProcessStarted(val markerPresent: Boolean) : CallEvent
}

sealed interface CallEffect {
  data class StartService(val botName: String) : CallEffect
  object StopService : CallEffect
  object HoldAudio : CallEffect
  object ResumeAudio : CallEffect
  object WriteMarker : CallEffect
  object ClearMarker : CallEffect
  data class Ended(val reason: EndReason) : CallEffect
  data class Rejected(val reason: StartRejection) : CallEffect
}

data class Transition(val state: CallState, val effects: List<CallEffect> = emptyList())

object CallStateMachine {
  fun reduce(state: CallState, event: CallEvent): Transition = when (event) {
    is CallEvent.StartRequested -> start(state, event)
    CallEvent.ServiceStarted -> when (state) {
      is CallState.Starting -> Transition(CallState.Live(state.botName, onHold = false))
      else -> Transition(state)
    }
    CallEvent.ServiceDestroyed -> when (state) {
      is CallState.Starting, is CallState.Live -> Transition(
        CallState.Idle,
        listOf(CallEffect.ClearMarker, CallEffect.Ended(EndReason.FAILED)),
      )
      else -> Transition(CallState.Idle)
    }
    is CallEvent.Stop -> stop(state, event.reason)
    is CallEvent.MicPermissionChanged ->
      if (event.granted) Transition(state) else stop(state, EndReason.PERMISSION_REVOKED)
    CallEvent.FocusLostTransient -> when (state) {
      is CallState.Live ->
        if (state.onHold) Transition(state) else Transition(state.copy(onHold = true), listOf(CallEffect.HoldAudio))
      else -> Transition(state)
    }
    CallEvent.FocusRegained -> when (state) {
      is CallState.Live ->
        if (state.onHold) Transition(state.copy(onHold = false), listOf(CallEffect.ResumeAudio)) else Transition(state)
      else -> Transition(state)
    }
    is CallEvent.ProcessStarted ->
      if (state != CallState.Idle || !event.markerPresent) Transition(state)
      else Transition(CallState.Idle, listOf(CallEffect.ClearMarker, CallEffect.Ended(EndReason.PROCESS_RECOVERED)))
  }

  private fun start(state: CallState, event: CallEvent.StartRequested): Transition {
    val rejection = when {
      state != CallState.Idle -> StartRejection.BUSY
      !event.userInitiated -> StartRejection.NOT_USER_TAP
      !event.appInForeground -> StartRejection.BACKGROUND
      !event.micGranted -> StartRejection.NO_PERMISSION
      else -> null
    }
    return if (rejection != null) {
      Transition(state, listOf(CallEffect.Rejected(rejection)))
    } else {
      Transition(
        CallState.Starting(event.botName),
        listOf(CallEffect.WriteMarker, CallEffect.StartService(event.botName)),
      )
    }
  }

  private fun stop(state: CallState, reason: EndReason): Transition = when (state) {
    is CallState.Starting, is CallState.Live -> Transition(
      CallState.Stopping(reason),
      listOf(CallEffect.StopService, CallEffect.ClearMarker, CallEffect.Ended(reason)),
    )
    CallState.Idle -> Transition(state, listOf(CallEffect.ClearMarker))
    is CallState.Stopping -> Transition(state)
  }
}

interface CallEffects {
  fun startService(botName: String)
  fun stopService()
  fun holdAudio()
  fun resumeAudio()
  fun writeMarker()
  fun clearMarker()
  fun ended(reason: EndReason)
}

class CallRuntime(private val effects: CallEffects) {
  private var current: CallState = CallState.Idle
  private val liveWaiters = mutableListOf<(Boolean) -> Unit>()

  val state: CallState
    @Synchronized get() = current

  fun dispatch(event: CallEvent): List<CallEffect> {
    val settled = mutableListOf<(Boolean) -> Unit>()
    val outcome: Boolean?
    val toRun: List<CallEffect>
    synchronized(this) {
      val transition = CallStateMachine.reduce(current, event)
      current = transition.state
      toRun = transition.effects
      outcome = when (current) {
        is CallState.Live -> true
        is CallState.Idle, is CallState.Stopping -> false
        is CallState.Starting -> null
      }
      if (outcome != null) {
        settled.addAll(liveWaiters)
        liveWaiters.clear()
      }
    }
    for (effect in toRun) run(effect)
    if (outcome != null) settled.forEach { it(outcome) }
    return toRun
  }

  fun awaitLive(callback: (Boolean) -> Unit) {
    val ready: Boolean?
    synchronized(this) {
      ready = when (current) {
        is CallState.Live -> true
        is CallState.Idle, is CallState.Stopping -> false
        is CallState.Starting -> null
      }
      if (ready == null) liveWaiters.add(callback)
    }
    if (ready != null) callback(ready)
  }

  private fun run(effect: CallEffect) {
    when (effect) {
      is CallEffect.StartService -> effects.startService(effect.botName)
      CallEffect.StopService -> effects.stopService()
      CallEffect.HoldAudio -> effects.holdAudio()
      CallEffect.ResumeAudio -> effects.resumeAudio()
      CallEffect.WriteMarker -> effects.writeMarker()
      CallEffect.ClearMarker -> effects.clearMarker()
      is CallEffect.Ended -> effects.ended(effect.reason)
      is CallEffect.Rejected -> Unit
    }
  }
}
