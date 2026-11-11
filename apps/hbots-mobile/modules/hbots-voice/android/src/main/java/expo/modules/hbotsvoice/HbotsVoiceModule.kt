package expo.modules.hbotsvoice

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HbotsVoiceModule : Module() {
  private var foreground = false

  private fun app(): Context =
    appContext.reactContext?.applicationContext ?: throw IllegalStateException("no context")

  override fun definition() = ModuleDefinition {
    Name("HbotsVoice")
    Events("micFrame", "route", "callEnded", "held", "captureFailure")

    OnCreate {
      VoiceRuntime.attach(app())
      foreground = appContext.currentActivity != null
      VoiceRuntime.listener = { name, body -> sendEvent(name, body) }
      VoiceRuntime.recoverIfNeeded()
    }
    OnDestroy { VoiceRuntime.listener = null }

    OnActivityEntersForeground {
      foreground = true
      if (VoiceRuntime.state !is CallState.Idle) {
        VoiceRuntime.dispatch(CallEvent.MicPermissionChanged(VoiceRuntime.micGranted()))
      }
    }
    OnActivityEntersBackground { foreground = false }

    Function("micPermission") { if (VoiceRuntime.micGranted()) "granted" else "denied" }

    Function("openAppSettings") {
      app().startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", app().packageName, null))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    Function("takeRecovery") { VoiceRuntime.takeRecovery() }

    Function("callState") { VoiceRuntime.state.wire }

    AsyncFunction("startCall") { botName: String, source: String, promise: Promise ->
      val effects = VoiceRuntime.dispatch(
        CallEvent.StartRequested(
          botName = botName,
          userInitiated = source == "tap",
          appInForeground = foreground,
          micGranted = VoiceRuntime.micGranted(),
        ),
      )
      val refused = effects.filterIsInstance<CallEffect.Rejected>().firstOrNull()?.reason
      if (refused != null) {
        promise.reject("ERR_VOICE_${refused.wire.uppercase()}", refused.message, null)
        return@AsyncFunction
      }
      VoiceRuntime.awaitLive { live ->
        if (live) promise.resolve(null) else promise.reject("ERR_VOICE_ENDED", "The call could not start.", null)
      }
    }

    AsyncFunction("startCapture") { promise: Promise ->
      val engine = VoiceRuntime.currentEngine()
      if (engine == null) {
        promise.reject("ERR_VOICE_NO_CALL", "No call is running.", null)
        return@AsyncFunction
      }
      engine.startCapture { result ->
        result.fold(
          { promise.resolve(null) },
          { promise.reject("ERR_VOICE_MIC", it.message ?: "The microphone failed.", it) },
        )
      }
    }

    Function("setMuted") { muted: Boolean -> VoiceRuntime.currentEngine()?.setMuted(muted) }

    Function("play") { base64: String, rate: Int -> VoiceRuntime.currentEngine()?.play(base64, rate) }

    Function("stopPlayback") { VoiceRuntime.currentEngine()?.stopPlayback() }

    Function("cue") { kind: String -> VoiceRuntime.currentEngine()?.cue(kind) }

    Function("readLevel") { source: String -> (VoiceRuntime.currentEngine()?.level(source) ?: 0f).toDouble() }

    Function("route") { VoiceRuntime.currentEngine()?.route()?.wire }

    Function("endCall") { VoiceRuntime.dispatch(CallEvent.Stop(EndReason.HUNG_UP)) }

    Function("wipe") { VoiceRuntime.wipe() }
  }
}
