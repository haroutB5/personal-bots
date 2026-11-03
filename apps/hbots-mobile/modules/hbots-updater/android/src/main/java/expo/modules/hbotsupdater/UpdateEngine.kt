package expo.modules.hbotsupdater

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

object UpdateEngine {
  private const val TAG = "HbotsUpdate"

  private val work = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "hbots-updater").apply { isDaemon = true }
  }
  private val main by lazy { Handler(Looper.getMainLooper()) }

  @Volatile private var context: Context? = null
  @Volatile private var store: UpdateStore? = null
  @Volatile private var record = UpdateRecord()
  @Volatile private var emit: ((Map<String, Any?>) -> Unit)? = null
  private val foreground = AtomicBoolean(false)
  private val processObserved = AtomicBoolean(false)
  @Volatile private var pendingTapIntent: Intent? = null
  @Volatile private var started = false

  fun isForeground(): Boolean = foreground.get()

  internal fun runSerialForTest(task: () -> Unit) = work.execute(task)

  fun attach(context: Context, listener: (Map<String, Any?>) -> Unit) {
    val app = context.applicationContext
    ensure(app)
    observeProcess()
    emit = listener
    if (started) {
      emitSnapshot()
      return
    }
    started = true
    work.execute {
      cleanupParts(app)
      dispatch(
        UpdateEvent.Started(
          canInstall = UpdateInstaller.canInstall(app),
          pendingInstall = UpdateInstaller.hasActiveInstall(app),
        ),
      )
      cleanupOrphans(app)
      emitSnapshot()
    }
  }

  fun detach() {
    emit = null
  }

  fun offer(release: Release?, auth: DownloadAuth?, manual: Boolean, generation: Long) = work.execute {
    val app = context ?: return@execute
    dispatch(
      UpdateEvent.Offered(
        release = release,
        authenticated = auth != null,
        manual = manual,
        canInstall = UpdateInstaller.canInstall(app),
        generation = generation,
      ),
      auth,
    )
  }

  fun confirmInstall() = work.execute {
    Log.i(TAG, "confirm install requested")
    dispatch(UpdateEvent.UserConfirmed)
  }

  fun onForeground() {
    foreground.set(true)
    work.execute {
      val app = context ?: return@execute
      dispatch(UpdateEvent.WentForeground)
      dispatch(UpdateEvent.PermissionChanged(UpdateInstaller.canInstall(app)))
    }
  }

  fun onBackground() {
    foreground.set(false)
    work.execute {
      dispatch(UpdateEvent.WentBackground)
    }
  }

  fun signedOut(generation: Long) = work.execute {
    val app = context ?: return@execute
    dispatch(UpdateEvent.SignedOut(generation))
    UpdateInstaller.abandonSessions(app)
  }

  fun idleReached(context: Context) = work.execute {
    ensure(context.applicationContext)
    if (foreground.get()) return@execute
    dispatch(UpdateEvent.IdleReached)
  }

  fun onInstallSucceeded(context: Context) = work.execute {
    ensure(context.applicationContext)
    dispatch(UpdateEvent.InstallSucceeded)
  }

  fun onInstallNeedsTap(context: Context, confirm: Intent?) = work.execute {
    ensure(context.applicationContext)
    pendingTapIntent = confirm
    dispatch(UpdateEvent.InstallNeedsTap(confirm?.toString().orEmpty()))
    pendingTapIntent = null
  }

  fun onInstallFailed(context: Context, message: String?) = work.execute {
    ensure(context.applicationContext)
    Log.w(TAG, "install failed: ${message.orEmpty().take(120)}")
    dispatch(UpdateEvent.InstallFailed)
  }

  fun snapshot(): Map<String, Any?> {
    val installed = context?.let(InstalledAppReader::read)
    val state = record.state
    return mapOf(
      "installedVersion" to (installed?.name ?: ""),
      "installedCode" to (installed?.code ?: 0L),
      "state" to stateKind(state),
      "target" to targetOf(state)?.let(::releaseMap),
      "rejected" to (state as? UpdateState.Idle)?.rejected?.version,
      "lastCheckAt" to record.lastCheckAt,
      "sessionGeneration" to record.sessionGeneration,
      "testPin" to BuildConfig.UPDATE_TEST_PIN,
    )
  }

  private fun ensure(app: Context) {
    if (store != null) {
      context = app
      return
    }
    context = app
    store = UpdateStore(app)
    record = store?.load() ?: UpdateRecord()
  }

  private fun dispatch(event: UpdateEvent, auth: DownloadAuth? = null) {
    val app = context ?: return
    val installedPackage = InstalledAppReader.read(app) ?: return
    val installed = InstalledApp(installedPackage.code, installedPackage.signers)
    val before = record
    val (next, effects) = UpdateReducer.reduce(before, event, installed.code, System.currentTimeMillis())
    record = next
    store?.save(next)
    if (next != before) emitSnapshot()
    val allowForeground = event is UpdateEvent.UserConfirmed
    for (effect in effects) {
      runEffect(effect, before, next, installed, auth, allowForeground, next.sessionGeneration)
    }
  }

  private fun runEffect(
    effect: UpdateEffect,
    before: UpdateRecord,
    after: UpdateRecord,
    installed: InstalledApp,
    auth: DownloadAuth?,
    allowForeground: Boolean,
    generation: Long,
  ) {
    val app = context ?: return
    when (effect) {
      UpdateEffect.StartDownload -> {
        val target = (after.state as? UpdateState.Downloading)?.target ?: return
        if (auth == null) {
          dispatch(UpdateEvent.DownloadFailed)
          return
        }
        when (
          val outcome = UpdateDownloader.download(
            app,
            target,
            auth,
            installed,
            BuildConfig.RELEASE_CERT_SHA256,
          )
        ) {
          is DownloadOutcome.Ready ->
            dispatch(UpdateEvent.Downloaded(outcome.apk, inBackground = !isForeground()))
          is DownloadOutcome.Rejected -> dispatch(UpdateEvent.Rejected(outcome.reason))
          DownloadOutcome.Failed -> dispatch(UpdateEvent.DownloadFailed)
        }
      }
      UpdateEffect.CommitInstall -> {
        val state = after.state as? UpdateState.Installing ?: return
        if (isForeground() && !allowForeground) {
          dispatch(UpdateEvent.InstallDeferred)
          return
        }
        commitInstall(app, state, installed, allowForeground, generation)
      }
      is UpdateEffect.ScheduleIdleInstall -> UpdateScheduler.schedule(app, effect.attempt)
      UpdateEffect.CancelIdleInstall -> UpdateScheduler.cancel(app)
      UpdateEffect.DeleteFile -> deleteFiles(before.state)
      is UpdateEffect.DeleteLateFile -> runCatching { File(effect.apk).delete() }
      UpdateEffect.DeleteAllFiles -> deleteAllUpdates(app)
      UpdateEffect.PostUpdated ->
        UpdateNotifier.postUpdated(app, targetOf(before.state)?.version ?: installedVersionName())
      UpdateEffect.PostUpdateReady -> UpdateNotifier.postConfirmation(app, pendingTapIntent)
      UpdateEffect.ClearNotification -> UpdateNotifier.clear(app)
    }
  }

  private fun commitInstall(
    app: Context,
    state: UpdateState.Installing,
    installed: InstalledApp,
    allowForeground: Boolean,
    generation: Long,
  ) {
    Log.i(TAG, "commit install code=${state.target.code} foreground=${isForeground()}")
    val apk = File(state.apk)
    if (!apk.isFile) {
      dispatch(UpdateEvent.InstallFailed)
      return
    }
    val facts = runCatching { ApkFileReader().read(apk) }.getOrNull()
    if (facts == null) {
      apk.delete()
      dispatch(UpdateEvent.InstallFailed)
      return
    }
    val verification =
      ApkVerifier.verify(facts, state.target, BuildConfig.RELEASE_CERT_SHA256, installed)
    if (verification !is ApkVerification.Verified) {
      Log.w(TAG, "install rejected before commit")
      apk.delete()
      dispatch(UpdateEvent.InstallFailed)
      return
    }
    if (isForeground() && !allowForeground) {
      Log.i(TAG, "install deferred after verify")
      dispatch(UpdateEvent.InstallDeferred)
      return
    }
    if (record.sessionGeneration != generation) {
      Log.i(TAG, "install deferred after a session change")
      dispatch(UpdateEvent.InstallDeferred)
      return
    }
    when (UpdateSession.verify(app)) {
      SessionVerdict.Invalid -> {
        Log.i(TAG, "install cleared by an invalid session")
        dispatch(UpdateEvent.SessionInvalid)
        return
      }
      SessionVerdict.Unknown -> {
        Log.i(TAG, "install deferred while the session is unchecked")
        dispatch(UpdateEvent.InstallDeferred)
        return
      }
      SessionVerdict.Valid -> Unit
    }
    if (isForeground() && !allowForeground) {
      Log.i(TAG, "install deferred after the session check")
      dispatch(UpdateEvent.InstallDeferred)
      return
    }
    if (record.sessionGeneration != generation) {
      Log.i(TAG, "install deferred after a session change")
      dispatch(UpdateEvent.InstallDeferred)
      return
    }
    when (UpdateInstaller.install(app, apk, state.target, allowForeground)) {
      UpdateInstallResult.STARTED -> Unit
      UpdateInstallResult.DEFERRED -> dispatch(UpdateEvent.InstallDeferred)
      UpdateInstallResult.NOT_PERMITTED -> dispatch(UpdateEvent.InstallNotPermitted)
      UpdateInstallResult.INVALID, UpdateInstallResult.ERROR -> dispatch(UpdateEvent.InstallFailed)
    }
  }

  private fun deleteFiles(state: UpdateState) {
    val app = context ?: return
    apkOf(state)?.let { runCatching { File(it).delete() } }
    targetOf(state)?.let {
      runCatching { File(app.cacheDir, "updates/${it.code}.apk.part").delete() }
    }
  }

  private fun deleteAllUpdates(app: Context) {
    File(app.cacheDir, "updates").listFiles()?.forEach { file ->
      runCatching { file.delete() }
    }
  }

  private fun observeProcess() {
    if (!processObserved.compareAndSet(false, true)) return
    main.post {
      ProcessLifecycleOwner.get().lifecycle.addObserver(
        object : DefaultLifecycleObserver {
          override fun onStart(owner: LifecycleOwner) {
            foreground.set(true)
          }

          override fun onStop(owner: LifecycleOwner) {
            foreground.set(false)
          }
        },
      )
    }
  }

  private fun cleanupParts(app: Context) {
    File(app.cacheDir, "updates").listFiles()?.forEach { file ->
      if (file.name.endsWith(".part")) runCatching { file.delete() }
    }
  }

  private fun cleanupOrphans(app: Context) {
    val keep = apkOf(record.state)?.let { File(it).absolutePath }
    File(app.cacheDir, "updates").listFiles()?.forEach { file ->
      if (file.absolutePath != keep) runCatching { file.delete() }
    }
  }

  private fun installedVersionName(): String? = context?.let(InstalledAppReader::read)?.name

  private fun emitSnapshot() {
    val listener = emit ?: return
    val payload = snapshot()
    main.post { listener(payload) }
  }

  private fun stateKind(state: UpdateState): String = when (state) {
    is UpdateState.Idle -> "idle"
    is UpdateState.Downloading -> "downloading"
    is UpdateState.Ready -> "ready"
    is UpdateState.Installing -> "installing"
    is UpdateState.NeedsTap -> "needsTap"
    is UpdateState.NeedsPermission -> "needsPermission"
  }

  private fun targetOf(state: UpdateState): Release? = when (state) {
    is UpdateState.Idle -> null
    is UpdateState.Downloading -> state.target
    is UpdateState.Ready -> state.target
    is UpdateState.Installing -> state.target
    is UpdateState.NeedsTap -> state.target
    is UpdateState.NeedsPermission -> state.target
  }

  private fun apkOf(state: UpdateState): String? = when (state) {
    is UpdateState.Idle -> null
    is UpdateState.Downloading -> null
    is UpdateState.Ready -> state.apk
    is UpdateState.Installing -> state.apk
    is UpdateState.NeedsTap -> state.apk
    is UpdateState.NeedsPermission -> null
  }

  private fun releaseMap(release: Release): Map<String, Any?> = mapOf(
    "version" to release.version,
    "sha256" to release.sha256,
    "size" to release.size,
  )
}
