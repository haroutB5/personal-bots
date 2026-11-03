package expo.modules.hbotsupdater

private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

data class Release(val version: String, val sha256: String, val size: Long) {
  init {
    require(versionCodeOf(version) != null) { "invalid version: $version" }
    require(SHA256_HEX.matches(sha256)) { "invalid sha256" }
    require(size > 0) { "invalid size: $size" }
  }

  val code: Long = requireNotNull(versionCodeOf(version))
}

sealed interface UpdateState {
  data class Idle(val rejected: Release? = null) : UpdateState
  data class Downloading(val target: Release) : UpdateState
  data class Ready(val target: Release, val apk: String) : UpdateState
  data class Installing(val target: Release, val apk: String, val since: Long) : UpdateState
  data class NeedsTap(val target: Release, val apk: String) : UpdateState
  data class NeedsPermission(val target: Release) : UpdateState
}

data class UpdateRecord(
  val state: UpdateState = UpdateState.Idle(),
  val lastCheckAt: Long? = null,
  val lastOffer: Release? = null,
  val notifiedCode: Long = 0L,
  val sessionGeneration: Long = 0L,
  val deferrals: Int = 0,
)

sealed interface UpdateEvent {
  data class Started(val canInstall: Boolean, val pendingInstall: Boolean = false) : UpdateEvent
  data class Offered(
    val release: Release?,
    val authenticated: Boolean,
    val manual: Boolean = false,
    val canInstall: Boolean = true,
    val generation: Long = 0L,
  ) : UpdateEvent
  data class Downloaded(val apk: String, val inBackground: Boolean = false) : UpdateEvent
  data class Rejected(val reason: String) : UpdateEvent
  data object DownloadFailed : UpdateEvent
  data object IdleReached : UpdateEvent
  data object UserConfirmed : UpdateEvent
  data object InstallSucceeded : UpdateEvent
  data class InstallNeedsTap(val intent: String) : UpdateEvent
  data object InstallFailed : UpdateEvent
  data object InstallDeferred : UpdateEvent
  data object InstallNotPermitted : UpdateEvent
  data object WentBackground : UpdateEvent
  data object WentForeground : UpdateEvent
  data class SignedOut(val generation: Long = 0L) : UpdateEvent
  data object SessionInvalid : UpdateEvent
  data class PermissionChanged(val canInstall: Boolean) : UpdateEvent
}

sealed interface UpdateEffect {
  data object StartDownload : UpdateEffect
  data object CommitInstall : UpdateEffect
  data class ScheduleIdleInstall(val attempt: Int = 0) : UpdateEffect
  data object CancelIdleInstall : UpdateEffect
  data object DeleteFile : UpdateEffect
  data class DeleteLateFile(val apk: String) : UpdateEffect
  data object DeleteAllFiles : UpdateEffect
  data object PostUpdated : UpdateEffect
  data object PostUpdateReady : UpdateEffect
  data object ClearNotification : UpdateEffect
}
