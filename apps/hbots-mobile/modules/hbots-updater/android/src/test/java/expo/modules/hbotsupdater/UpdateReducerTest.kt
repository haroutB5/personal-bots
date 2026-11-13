package expo.modules.hbotsupdater

import expo.modules.hbotsupdater.UpdateEffect.CancelIdleInstall
import expo.modules.hbotsupdater.UpdateEffect.ClearNotification
import expo.modules.hbotsupdater.UpdateEffect.CommitInstall
import expo.modules.hbotsupdater.UpdateEffect.DeleteAllFiles
import expo.modules.hbotsupdater.UpdateEffect.DeleteLateFile
import expo.modules.hbotsupdater.UpdateEffect.DeleteFile
import expo.modules.hbotsupdater.UpdateEffect.PostNeedsPermission
import expo.modules.hbotsupdater.UpdateEffect.PostUpdated
import expo.modules.hbotsupdater.UpdateEffect.PostUpdateReady
import expo.modules.hbotsupdater.UpdateEffect.ScheduleIdleInstall
import expo.modules.hbotsupdater.UpdateEffect.StartDownload
import expo.modules.hbotsupdater.UpdateState.Downloading
import expo.modules.hbotsupdater.UpdateState.Idle
import expo.modules.hbotsupdater.UpdateState.Installing
import expo.modules.hbotsupdater.UpdateState.NeedsPermission
import expo.modules.hbotsupdater.UpdateState.NeedsTap
import expo.modules.hbotsupdater.UpdateState.Ready
import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateReducerTest {
  private val now = 1_700_000_000_000L
  private val installed = 1_066_110L
  private val old = Release("1.66.111", "b".repeat(64), 46_076_720)
  private val next = Release("1.66.112", "c".repeat(64), 46_076_721)
  private val apk = "/data/user/0/com.haroutb5.hbots/cache/updates/1066112.apk"

  private fun record(
    state: UpdateState,
    lastCheckAt: Long? = null,
    lastOffer: Release? = null,
    notifiedCode: Long = 1_066_110L,
    deferrals: Int = 0,
    permissionNotifiedCode: Long = 0L,
  ) = UpdateRecord(
    state = state,
    lastCheckAt = lastCheckAt,
    lastOffer = lastOffer,
    notifiedCode = notifiedCode,
    deferrals = deferrals,
    permissionNotifiedCode = permissionNotifiedCode,
  )

  private fun reduced(
    before: UpdateRecord,
    event: UpdateEvent,
    after: UpdateRecord,
    effects: List<UpdateEffect>,
    installedCode: Long = installed,
    time: Long = now,
  ) {
    val (actualRecord, actualEffects) = UpdateReducer.reduce(before, event, installedCode, time)
    assertEquals(after, actualRecord)
    assertEquals(effects, actualEffects)
  }

  @Test
  fun `started after an install clears the ready apk and posts once`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.Started(true),
      record(Idle(), lastOffer = null, notifiedCode = 1_066_112L),
      listOf(CancelIdleInstall, DeleteFile, PostUpdated),
      installedCode = 1_066_112L,
    )
  }

  @Test
  fun `started after an install does not post the same code twice`() {
    reduced(
      record(Ready(next, apk), lastOffer = next, notifiedCode = 1_066_112L),
      UpdateEvent.Started(true),
      record(Idle(), lastOffer = null, notifiedCode = 1_066_112L),
      listOf(CancelIdleInstall, DeleteFile),
      installedCode = 1_066_112L,
    )
  }

  @Test
  fun `started with an idle last offer after an install clears the offer`() {
    reduced(
      record(Idle(), lastOffer = next),
      UpdateEvent.Started(true),
      record(Idle(), lastOffer = null, notifiedCode = 1_066_112L),
      listOf(CancelIdleInstall, PostUpdated),
      installedCode = 1_066_112L,
    )
  }

  @Test
  fun `started after an install clears a stale install`() {
    reduced(
      record(Installing(next, apk, since = now - 60_000L), lastOffer = next),
      UpdateEvent.Started(true),
      record(Idle(), lastOffer = null, notifiedCode = 1_066_112L),
      listOf(CancelIdleInstall, DeleteFile, PostUpdated),
      installedCode = 1_066_112L,
    )
  }

  @Test
  fun `started while downloading discards the partial file`() {
    reduced(
      record(Downloading(next), lastOffer = next),
      UpdateEvent.Started(true),
      record(Idle(), lastOffer = next),
      listOf(CancelIdleInstall, DeleteFile),
    )
  }

  @Test
  fun `started after a stale install returns to ready`() {
    reduced(
      record(Installing(next, apk, since = now - 31 * 60 * 1000L), lastOffer = next),
      UpdateEvent.Started(true),
      record(Ready(next, apk), lastOffer = next),
      listOf(CancelIdleInstall),
    )
  }

  @Test
  fun `started during a fresh install leaves the install alone`() {
    reduced(
      record(Installing(next, apk, since = now - 60_000L), lastOffer = next),
      UpdateEvent.Started(true, pendingInstall = true),
      record(Installing(next, apk, since = now - 60_000L), lastOffer = next),
      listOf(CancelIdleInstall),
    )
  }

  @Test
  fun `started during a fresh install with no session returns to ready`() {
    reduced(
      record(Installing(next, apk, since = now - 60_000L), lastOffer = next),
      UpdateEvent.Started(true),
      record(Ready(next, apk), lastOffer = next),
      listOf(CancelIdleInstall),
    )
  }

  @Test
  fun `a newer offer starts the download`() {
    reduced(
      record(Idle(rejected = old)),
      UpdateEvent.Offered(next, authenticated = true),
      record(Downloading(next), lastCheckAt = now, lastOffer = next),
      listOf(StartDownload),
    )
  }

  @Test
  fun `a rejected sha256 is not downloaded again`() {
    reduced(
      record(Idle(rejected = next)),
      UpdateEvent.Offered(next, authenticated = true),
      record(Idle(rejected = next), lastCheckAt = now, lastOffer = next),
      emptyList(),
    )
  }

  @Test
  fun `a signed out offer is remembered without a download`() {
    reduced(
      record(Idle()),
      UpdateEvent.Offered(next, authenticated = false),
      record(Idle(), lastCheckAt = now, lastOffer = next),
      emptyList(),
    )
  }

  @Test
  fun `an offer without install permission waits for it`() {
    reduced(
      record(Idle()),
      UpdateEvent.Offered(next, authenticated = true, canInstall = false),
      record(NeedsPermission(next), lastCheckAt = now, lastOffer = next, permissionNotifiedCode = next.code),
      listOf(PostNeedsPermission("1.66.112")),
    )
  }

  @Test
  fun `a newer offer replaces a ready apk`() {
    reduced(
      record(Ready(old, "/old.apk"), lastOffer = old),
      UpdateEvent.Offered(next, authenticated = true),
      record(Downloading(next), lastCheckAt = now, lastOffer = next),
      listOf(DeleteFile, StartDownload),
    )
  }

  @Test
  fun `a newer offer replaces a needs tap apk when signed out`() {
    reduced(
      record(NeedsTap(old, "/old.apk"), lastOffer = old),
      UpdateEvent.Offered(next, authenticated = false),
      record(Idle(), lastCheckAt = now, lastOffer = next),
      listOf(DeleteFile),
    )
  }

  @Test
  fun `a newer offer replaces a needs permission target`() {
    reduced(
      record(NeedsPermission(old), lastOffer = old, permissionNotifiedCode = old.code),
      UpdateEvent.Offered(next, authenticated = true, canInstall = false),
      record(NeedsPermission(next), lastCheckAt = now, lastOffer = next, permissionNotifiedCode = next.code),
      listOf(PostNeedsPermission("1.66.112")),
    )
  }

  @Test
  fun `a signed out offer drops a ready apk`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.Offered(next, authenticated = false),
      record(Idle(), lastCheckAt = now, lastOffer = next),
      listOf(DeleteFile),
    )
  }

  @Test
  fun `a signed out offer drops a needs tap apk`() {
    reduced(
      record(NeedsTap(next, apk), lastOffer = next),
      UpdateEvent.Offered(next, authenticated = false),
      record(Idle(), lastCheckAt = now, lastOffer = next),
      listOf(DeleteFile),
    )
  }

  @Test
  fun `signing out keeps a rejected sha`() {
    reduced(
      record(Idle(rejected = next), lastOffer = next),
      UpdateEvent.SignedOut(),
      record(Idle(rejected = next), lastCheckAt = null, lastOffer = null),
      listOf(CancelIdleInstall, DeleteAllFiles, ClearNotification),
    )
  }

  @Test
  fun `signing out resets the record and deletes every file`() {
    reduced(
      record(Ready(next, apk), lastCheckAt = 123, lastOffer = next),
      UpdateEvent.SignedOut(),
      record(Idle(), lastCheckAt = null, lastOffer = null),
      listOf(CancelIdleInstall, DeleteAllFiles, ClearNotification),
    )
  }

  @Test
  fun `a repeated offer leaves a ready apk alone`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.Offered(next, authenticated = true),
      record(Ready(next, apk), lastCheckAt = now, lastOffer = next),
      emptyList(),
    )
  }

  @Test
  fun `a newer offer replaces a download in flight`() {
    reduced(
      record(Downloading(old), lastOffer = old),
      UpdateEvent.Offered(next, authenticated = true),
      record(Downloading(next), lastCheckAt = now, lastOffer = next),
      listOf(DeleteFile, StartDownload),
    )
  }

  @Test
  fun `an absent offer deletes a ready apk`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.Offered(null, authenticated = true),
      record(Idle(), lastCheckAt = now, lastOffer = null),
      listOf(DeleteFile),
    )
  }

  @Test
  fun `an absent offer keeps the rejected sha256`() {
    reduced(
      record(Idle(rejected = next), lastOffer = next),
      UpdateEvent.Offered(null, authenticated = true),
      record(Idle(rejected = next), lastCheckAt = now, lastOffer = null),
      emptyList(),
    )
  }

  @Test
  fun `an offer at the installed code deletes a download`() {
    reduced(
      record(Downloading(next), lastOffer = next),
      UpdateEvent.Offered(next, authenticated = true),
      record(Idle(), lastCheckAt = now, lastOffer = null),
      listOf(DeleteFile),
      installedCode = 1_066_112L,
    )
  }

  @Test
  fun `an absent offer does not interrupt a live install`() {
    reduced(
      record(Installing(next, apk, since = now - 1_000L), lastOffer = next),
      UpdateEvent.Offered(null, authenticated = true),
      record(Installing(next, apk, since = now - 1_000L), lastCheckAt = now, lastOffer = next),
      emptyList(),
    )
  }

  @Test
  fun `a manual offer clears the rejected sha256`() {
    reduced(
      record(Idle(rejected = next)),
      UpdateEvent.Offered(next, authenticated = true, manual = true),
      record(Downloading(next), lastCheckAt = now, lastOffer = next),
      listOf(StartDownload),
    )
  }

  @Test
  fun `a manual offer does not disturb a ready apk`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.Offered(next, authenticated = true, manual = true),
      record(Ready(next, apk), lastCheckAt = now, lastOffer = next),
      emptyList(),
    )
  }

  @Test
  fun `a completed download in the background announces itself and waits for the owner`() {
    reduced(
      record(Downloading(next), lastOffer = next),
      UpdateEvent.Downloaded(apk, inBackground = true),
      record(Ready(next, apk), lastOffer = next),
      listOf(UpdateEffect.PostRestartReady(next.version)),
    )
  }

  @Test
  fun `a completed download in the foreground announces itself too`() {
    reduced(
      record(Downloading(next), lastOffer = next),
      UpdateEvent.Downloaded(apk, inBackground = false),
      record(Ready(next, apk), lastOffer = next),
      listOf(UpdateEffect.PostRestartReady(next.version)),
    )
  }

  @Test
  fun `a rejected download remembers the target`() {
    reduced(
      record(Downloading(next), lastOffer = next),
      UpdateEvent.Rejected("sha256"),
      record(Idle(rejected = next), lastOffer = next),
      listOf(DeleteFile),
    )
  }

  @Test
  fun `a failed download returns to idle silently`() {
    reduced(
      record(Downloading(next), lastOffer = next),
      UpdateEvent.DownloadFailed,
      record(Idle(), lastOffer = next),
      emptyList(),
    )
  }

  @Test
  fun `an idle worker commits a ready apk`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.IdleReached,
      record(Installing(next, apk, since = now), lastOffer = next),
      listOf(CommitInstall),
    )
  }

  @Test
  fun `a confirmed ready apk installs`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.UserConfirmed,
      record(Installing(next, apk, since = now), lastOffer = next),
      listOf(CommitInstall),
    )
  }

  @Test
  fun `a confirmed needs tap apk installs`() {
    reduced(
      record(NeedsTap(next, apk), lastOffer = next),
      UpdateEvent.UserConfirmed,
      record(Installing(next, apk, since = now), lastOffer = next),
      listOf(CommitInstall),
    )
  }

  @Test
  fun `a successful install posts once and clears the file`() {
    reduced(
      record(Installing(next, apk, since = now - 1_000L), lastOffer = next),
      UpdateEvent.InstallSucceeded,
      record(Idle(), lastOffer = null, notifiedCode = 1_066_112L),
      listOf(DeleteFile, PostUpdated, ClearNotification),
    )
  }

  @Test
  fun `a successful install does not repeat the post`() {
    reduced(
      record(Installing(next, apk, since = now - 1_000L), lastOffer = next, notifiedCode = 1_066_112L),
      UpdateEvent.InstallSucceeded,
      record(Idle(), lastOffer = null, notifiedCode = 1_066_112L),
      listOf(DeleteFile, ClearNotification),
    )
  }

  @Test
  fun `an install that needs a tap becomes needs tap`() {
    reduced(
      record(Installing(next, apk, since = now - 1_000L), lastOffer = next),
      UpdateEvent.InstallNeedsTap("intent"),
      record(NeedsTap(next, apk), lastOffer = next),
      listOf(PostUpdateReady),
    )
  }

  @Test
  fun `a failed install remembers the target`() {
    reduced(
      record(Installing(next, apk, since = now - 1_000L), lastOffer = next),
      UpdateEvent.InstallFailed,
      record(Idle(rejected = next), lastOffer = next),
      listOf(DeleteFile, ClearNotification),
    )
  }

  @Test
  fun `granting permission restarts the remembered offer`() {
    reduced(
      record(NeedsPermission(next), lastCheckAt = 123, lastOffer = next, permissionNotifiedCode = next.code),
      UpdateEvent.PermissionChanged(true),
      record(Downloading(next), lastCheckAt = 123, lastOffer = next, permissionNotifiedCode = next.code),
      listOf(StartDownload, ClearNotification),
    )
  }

  @Test
  fun `withdrawing permission keeps waiting`() {
    reduced(
      record(NeedsPermission(next), lastOffer = next, permissionNotifiedCode = next.code),
      UpdateEvent.PermissionChanged(false),
      record(NeedsPermission(next), lastOffer = next, permissionNotifiedCode = next.code),
      emptyList(),
    )
  }

  @Test
  fun `granting permission with no remembered offer stays idle`() {
    reduced(
      record(NeedsPermission(next), permissionNotifiedCode = next.code),
      UpdateEvent.PermissionChanged(true),
      record(Idle(), permissionNotifiedCode = next.code),
      listOf(ClearNotification),
    )
  }

  @Test
  fun `starting with permission granted restarts the remembered offer`() {
    reduced(
      record(NeedsPermission(next), lastOffer = next, permissionNotifiedCode = next.code),
      UpdateEvent.Started(true),
      record(Downloading(next), lastOffer = next, permissionNotifiedCode = next.code),
      listOf(CancelIdleInstall, StartDownload, ClearNotification),
    )
  }

  @Test
  fun `a late download event does not overwrite ready`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.Downloaded("/other.apk"),
      record(Ready(next, apk), lastOffer = next),
      listOf(DeleteLateFile("/other.apk")),
    )
  }

  @Test
  fun `a late install success in idle does not post`() {
    reduced(
      record(Idle(), lastOffer = null),
      UpdateEvent.InstallSucceeded,
      record(Idle(), lastOffer = null),
      emptyList(),
    )
  }

  @Test
  fun `going to the background leaves a ready install waiting for the owner`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.WentBackground,
      record(Ready(next, apk), lastOffer = next),
      emptyList(),
    )
  }

  @Test
  fun `going to the background with a download in flight schedules nothing`() {
    reduced(
      record(Downloading(next), lastOffer = next),
      UpdateEvent.WentBackground,
      record(Downloading(next), lastOffer = next),
      emptyList(),
    )
  }

  @Test
  fun `coming back to the foreground cancels the idle install`() {
    reduced(
      record(Ready(next, apk), lastOffer = next),
      UpdateEvent.WentForeground,
      record(Ready(next, apk), lastOffer = next),
      listOf(CancelIdleInstall),
    )
  }

  @Test
  fun `an install deferred by a foreground return goes back to ready and retries`() {
    reduced(
      record(Installing(next, apk, now), lastOffer = next),
      UpdateEvent.InstallDeferred,
      record(Ready(next, apk), lastOffer = next, deferrals = 1),
      listOf(ScheduleIdleInstall(1)),
    )
  }

  @Test
  fun `each deferral pushes the retry further out`() {
    val waiting = record(Ready(next, apk), lastOffer = next, deferrals = 1)

    reduced(
      UpdateReducer.reduce(waiting, UpdateEvent.IdleReached, installed, now).first,
      UpdateEvent.InstallDeferred,
      record(Ready(next, apk), lastOffer = next, deferrals = 2),
      listOf(ScheduleIdleInstall(2)),
    )
  }

  @Test
  fun `a fresh download resets the backoff`() {
    reduced(
      record(Idle(), lastOffer = next, deferrals = 4),
      UpdateEvent.Offered(next, authenticated = true),
      record(Downloading(next), lastCheckAt = now, lastOffer = next, deferrals = 0),
      listOf(StartDownload),
    )
  }

  @Test
  fun `a lost install permission waits without remembering a rejection`() {
    reduced(
      record(Installing(next, apk, now), lastOffer = next),
      UpdateEvent.InstallNotPermitted,
      record(NeedsPermission(next), lastOffer = next, permissionNotifiedCode = next.code),
      listOf(DeleteFile, PostNeedsPermission("1.66.112")),
    )
  }

  @Test
  fun `the permission notification fires once per target version`() {
    val waiting = record(Idle())
    val (first, firstEffects) =
      UpdateReducer.reduce(waiting, UpdateEvent.Offered(next, authenticated = true, canInstall = false), installed, now)
    assertEquals(listOf(PostNeedsPermission("1.66.112")), firstEffects)

    val (second, secondEffects) =
      UpdateReducer.reduce(first, UpdateEvent.Offered(next, authenticated = true, canInstall = false), installed, now)
    assertEquals(first.state, second.state)
    assertEquals(emptyList<UpdateEffect>(), secondEffects)

    val (restarted, restartEffects) = UpdateReducer.reduce(second, UpdateEvent.Started(false), installed, now)
    assertEquals(NeedsPermission(next), restarted.state)
    assertEquals(listOf(CancelIdleInstall), restartEffects)

    val newer = Release("1.66.113", "d".repeat(64), 46_076_722)
    val (_, newerEffects) =
      UpdateReducer.reduce(restarted, UpdateEvent.Offered(newer, authenticated = true, canInstall = false), installed, now)
    assertEquals(listOf(PostNeedsPermission("1.66.113")), newerEffects)
  }

  @Test
  fun `the permission notification does not repeat after permission is granted and withdrawn`() {
    val waiting = record(NeedsPermission(next), lastOffer = next, permissionNotifiedCode = next.code)
    val (granted, _) = UpdateReducer.reduce(waiting, UpdateEvent.PermissionChanged(true), installed, now)
    assertEquals(Downloading(next), granted.state)
    val (back, backEffects) = UpdateReducer.reduce(
      granted.copy(state = Installing(next, apk, now)),
      UpdateEvent.InstallNotPermitted,
      installed,
      now,
    )
    assertEquals(NeedsPermission(next), back.state)
    assertEquals(listOf(DeleteFile), backEffects)
  }

  @Test
  fun `states other than needs permission never post the permission notification`() {
    val events = listOf(
      UpdateEvent.Offered(next, authenticated = true, canInstall = true),
      UpdateEvent.Offered(next, authenticated = false, canInstall = false),
      UpdateEvent.Offered(null, authenticated = true, canInstall = false),
      UpdateEvent.Downloaded(apk),
      UpdateEvent.DownloadFailed,
      UpdateEvent.IdleReached,
      UpdateEvent.UserConfirmed,
      UpdateEvent.InstallSucceeded,
      UpdateEvent.InstallFailed,
      UpdateEvent.WentBackground,
      UpdateEvent.WentForeground,
      UpdateEvent.SignedOut(),
      UpdateEvent.SessionInvalid,
    )
    val states = listOf(
      Idle(),
      Downloading(next),
      Ready(next, apk),
      Installing(next, apk, now),
      NeedsTap(next, apk),
    )
    for (state in states) {
      for (event in events) {
        val (_, effects) = UpdateReducer.reduce(record(state, lastOffer = next), event, installed, now)
        assertEquals(
          "$state $event",
          emptyList<UpdateEffect>(),
          effects.filterIsInstance<PostNeedsPermission>(),
        )
      }
    }
  }

  @Test
  fun `signing out keeps the permission notification memory`() {
    val (cleared, _) = UpdateReducer.reduce(
      record(NeedsPermission(next), lastOffer = next, permissionNotifiedCode = next.code),
      UpdateEvent.SignedOut(),
      installed,
      now,
    )
    assertEquals(next.code, cleared.permissionNotifiedCode)
  }
}
