package expo.modules.hbotsvoice

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.core.content.ContextCompat

object VoiceRuntime {
  @Volatile private var appContext: Context? = null
  @Volatile private var engine: VoiceEngine? = null
  @Volatile private var recovered = false
  @Volatile var listener: ((String, Map<String, Any?>) -> Unit)? = null

  private val runtime = CallRuntime(effects = object : CallEffects {
    override fun startService(botName: String) {
      val context = requireContext()
      val intent = Intent(context, VoiceCallService::class.java).setAction(CallNotification.ACTION_START)
      ContextCompat.startForegroundService(context, intent)
    }

    override fun stopService() {
      val context = requireContext()
      context.stopService(Intent(context, VoiceCallService::class.java))
    }

    override fun holdAudio() {
      engine?.hold(true)
      emit("held", mapOf("held" to true))
    }

    override fun resumeAudio() {
      engine?.hold(false)
      emit("held", mapOf("held" to false))
    }

    override fun writeMarker() {
      CallMarker.takeLastEnd(requireContext())
      CallMarker.set(requireContext())
    }

    override fun clearMarker() = CallMarker.clear(requireContext())

    override fun writeLastEnd(reason: EndReason) =
      CallMarker.setLastEnd(requireContext(), reason.wire, SystemClock.elapsedRealtime(), System.currentTimeMillis())

    override fun ended(reason: EndReason) {
      if (reason == EndReason.PROCESS_RECOVERED) recovered = true
      emit("callEnded", mapOf("reason" to reason.wire))
    }

  }, clock = { SystemClock.elapsedRealtime() })

  val state: CallState get() = runtime.state

  fun attach(context: Context) {
    appContext = context.applicationContext
  }

  private fun requireContext(): Context = appContext ?: throw IllegalStateException("voice runtime is not attached")

  fun dispatch(event: CallEvent): List<CallEffect> = runtime.dispatch(event)

  fun awaitLive(callback: (Boolean) -> Unit) = runtime.awaitLive(callback)

  /** JS moves the mic lease. An unknown kind is ignored, so an older native build never misreads a newer app. */
  fun holdMicUntil(kind: String, inMs: Double) {
    val deadline = Deadline.fromWire(kind) ?: return
    val at = SystemClock.elapsedRealtime() + inMs.toLong().coerceAtLeast(0L)
    dispatch(CallEvent.LeaseSet(deadline, at))
  }

  fun checkLease() = runtime.checkLease()

  fun takeLastEnd(): Map<String, Any?>? = CallMarker.takeLastEnd(requireContext())

  fun emit(name: String, body: Map<String, Any?>) {
    listener?.invoke(name, body)
  }

  fun currentEngine(): VoiceEngine? = engine

  fun openEngine(context: Context): Boolean {
    val created = VoiceEngine(
      context.applicationContext,
      emit = { name, body -> emit(name, body) },
      onFocus = { event -> dispatch(event) },
      onCaptureFailure = ::captureFailed,
      leaseDue = runtime::leaseDue,
      onLeaseDue = runtime::checkLease,
    )
    engine = created
    return created.open()
  }

  private fun captureFailed(code: String) {
    emit("captureFailure", mapOf("code" to code))
    dispatch(CallEvent.Stop(if (micGranted()) EndReason.FAILED else EndReason.PERMISSION_REVOKED))
  }

  fun closeEngine() {
    engine?.close()
    engine = null
  }

  fun micGranted(): Boolean {
    val context = appContext ?: return false
    return ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED
  }

  fun takeRecovery(): Boolean {
    val was = recovered
    recovered = false
    return was
  }

  fun recoverIfNeeded() {
    val context = requireContext()
    dispatch(CallEvent.ProcessStarted(CallMarker.isSet(context)))
  }

  fun wipe() {
    val context = requireContext()
    dispatch(CallEvent.Stop(EndReason.SIGNED_OUT))
    recovered = false
    CallMarker.wipe(context)
    VoiceCallService.deleteChannel(context)
  }
}
