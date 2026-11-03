package expo.modules.hbotsupdater

import expo.modules.hbotsupdater.UpdateEffect.CancelIdleInstall
import expo.modules.hbotsupdater.UpdateEffect.ClearNotification
import expo.modules.hbotsupdater.UpdateEffect.DeleteAllFiles
import expo.modules.hbotsupdater.UpdateEffect.DeleteLateFile
import expo.modules.hbotsupdater.UpdateEffect.StartDownload
import expo.modules.hbotsupdater.UpdateState.Downloading
import expo.modules.hbotsupdater.UpdateState.Idle
import expo.modules.hbotsupdater.UpdateState.Ready
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionGenerationTest {
  private val now = 1_700_000_000_000L
  private val installed = 1_066_110L
  private val release = Release("1.66.112", "c".repeat(64), 46_076_721)
  private val apk = "/data/user/0/com.haroutb5.hbots/cache/updates/1066112.apk"

  private fun record(state: UpdateState, generation: Long) = UpdateRecord(
    state = state,
    lastCheckAt = now,
    lastOffer = release,
    notifiedCode = installed,
    sessionGeneration = generation,
  )

  @Test
  fun `an offer from the session before sign out is dropped`() {
    val signedOut = record(Idle(), generation = 2)

    val (next, effects) =
      UpdateReducer.reduce(signedOut, UpdateEvent.Offered(release, authenticated = true, generation = 1), installed, now)

    assertEquals(signedOut, next)
    assertEquals(emptyList<UpdateEffect>(), effects)
  }

  @Test
  fun `an offer from the new session downloads`() {
    val signedOut = record(Idle(), generation = 2)

    val (next, effects) =
      UpdateReducer.reduce(signedOut, UpdateEvent.Offered(release, authenticated = true, generation = 2), installed, now)

    assertEquals(record(Downloading(release), generation = 2), next)
    assertEquals(listOf(StartDownload), effects)
  }

  @Test
  fun `sign out clears the ready apk and advances the generation`() {
    val ready = record(Ready(release, apk), generation = 1)

    val (next, effects) =
      UpdateReducer.reduce(ready, UpdateEvent.SignedOut(generation = 2), installed, now)

    assertEquals(
      UpdateRecord(Idle(), lastCheckAt = null, lastOffer = null, notifiedCode = installed, sessionGeneration = 2),
      next,
    )
    assertEquals(
      listOf(CancelIdleInstall, DeleteAllFiles, ClearNotification),
      effects,
    )
  }

  @Test
  fun `an invalid session clears the ready apk and advances the generation`() {
    val ready = record(Ready(release, apk), generation = 3)

    val (next, effects) = UpdateReducer.reduce(ready, UpdateEvent.SessionInvalid, installed, now)

    assertEquals(
      UpdateRecord(Idle(), lastCheckAt = now, lastOffer = null, notifiedCode = installed, sessionGeneration = 4),
      next,
    )
    assertEquals(listOf(CancelIdleInstall, DeleteAllFiles, ClearNotification), effects)
  }

  @Test
  fun `a download that lands after sign out deletes its file`() {
    val signedOut = record(Idle(), generation = 2)

    val (next, effects) = UpdateReducer.reduce(signedOut, UpdateEvent.Downloaded(apk), installed, now)

    assertEquals(signedOut, next)
    assertEquals(listOf(DeleteLateFile(apk)), effects)
  }
}
