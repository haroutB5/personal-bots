package expo.modules.hbotsupdater

import expo.modules.hbotsupdater.UpdateEffect.StartDownload
import expo.modules.hbotsupdater.UpdateState.Downloading
import expo.modules.hbotsupdater.UpdateState.Idle
import expo.modules.hbotsupdater.UpdateState.Installing
import expo.modules.hbotsupdater.UpdateState.NeedsPermission
import expo.modules.hbotsupdater.UpdateState.NeedsTap
import expo.modules.hbotsupdater.UpdateState.Ready
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateRecordCodecTest {
  private val sha = "c".repeat(64)
  private val release = Release("1.66.112", sha, 46_076_721)
  private val apk = "/data/user/0/com.haroutb5.hbots/cache/updates/1066112.apk"
  private val now = 1_700_000_000_000L

  private val releaseJson =
    """{"version":"1.66.112","sha256":"$sha","size":46076721}"""

  @Test
  fun `every state round trips`() {
    val records = listOf(
      UpdateRecord(),
      UpdateRecord(Idle(rejected = release), 123L, release, 1_066_110L),
      UpdateRecord(Downloading(release), 123L, release, 1_066_110L),
      UpdateRecord(Ready(release, apk), 123L, release, 1_066_110L),
      UpdateRecord(Installing(release, apk, now), 123L, release, 1_066_110L),
      UpdateRecord(NeedsTap(release, apk), 123L, release, 1_066_110L),
      UpdateRecord(NeedsPermission(release), 123L, release, 1_066_110L),
    )

    records.forEach { record ->
      assertEquals(record, UpdateRecordCodec.decode(UpdateRecordCodec.encode(record)))
    }
  }

  @Test
  fun `the stored installing record decodes`() {
    val raw =
      """{"schema":1,"state":{"kind":"installing","target":$releaseJson,"apk":"$apk","since":$now},"lastCheckAt":$now,"lastOffer":$releaseJson,"notifiedCode":1066110}"""

    assertEquals(
      UpdateRecord(Installing(release, apk, now), now, release, 1_066_110L),
      UpdateRecordCodec.decode(raw),
    )
  }

  @Test
  fun `the stored idle record decodes with a null rejected release`() {
    val raw =
      """{"schema":1,"state":{"kind":"idle","rejected":null},"lastCheckAt":null,"lastOffer":null,"notifiedCode":0}"""

    assertEquals(UpdateRecord(), UpdateRecordCodec.decode(raw))
  }

  @Test
  fun `corrupt records decode to null and load to a fresh idle`() {
    val corrupt = listOf(
      "",
      "   ",
      "not json",
      "[]",
      """{"schema":2,"state":{"kind":"idle","rejected":null},"lastCheckAt":null,"lastOffer":null,"notifiedCode":0}""",
      """{"schema":1,"state":{"kind":"sleeping"},"lastCheckAt":null,"lastOffer":null,"notifiedCode":0}""",
      """{"schema":1,"state":{"kind":"ready","target":$releaseJson},"lastCheckAt":null,"lastOffer":null,"notifiedCode":0}""",
      """{"schema":1,"state":{"kind":"idle","rejected":null},"lastCheckAt":null,"lastOffer":null}""",
      """{"schema":1,"state":{"kind":"idle","rejected":{"version":"1.66.112","sha256":"bad","size":46076721}},"lastCheckAt":null,"lastOffer":null,"notifiedCode":0}""",
      """{"schema":1,"state":{"kind":"idle","rejected":null},"lastCheckAt":-1,"lastOffer":null,"notifiedCode":0}""",
      """{"schema":1,"state":{"kind":"idle","rejected":null},"lastCheckAt":null,"lastOffer":null,"notifiedCode":1.5}""",
      """{"schema":1,"state":{"kind":"needsTap","target":$releaseJson,"apk":" "},"lastCheckAt":null,"lastOffer":null,"notifiedCode":0}""",
      """{"schema":1,"state":{"kind":"installing","target":$releaseJson,"apk":"$apk","since":-1},"lastCheckAt":null,"lastOffer":null,"notifiedCode":0}""",
    )

    corrupt.forEach { raw ->
      assertNull(raw, UpdateRecordCodec.decode(raw))
      assertEquals(UpdateRecord(), UpdateRecordCodec.load(raw))
    }
  }

  @Test
  fun `a corrupt record recovers on the next offer`() {
    val reset = UpdateRecordCodec.load("""{"schema":1,"state":{"kind":""")
    val (nextRecord, effects) =
      UpdateReducer.reduce(reset, UpdateEvent.Offered(release, authenticated = true), 1_066_110L, now)

    assertEquals(Downloading(release), nextRecord.state)
    assertEquals(listOf(StartDownload), effects)
  }

  @Test
  fun `a replay after restart reaches the same ready state`() {
    val live = UpdateRecord(Downloading(release), 100L, release, 1_066_110L)
    val restarted = UpdateRecordCodec.load(UpdateRecordCodec.encode(live))

    val (liveNext, liveEffects) =
      UpdateReducer.reduce(live, UpdateEvent.Downloaded(apk, inBackground = true), 1_066_110L, now)
    val (restartNext, restartEffects) =
      UpdateReducer.reduce(restarted, UpdateEvent.Downloaded(apk, inBackground = true), 1_066_110L, now)

    assertEquals(liveNext, restartNext)
    assertEquals(liveEffects, restartEffects)
    assertEquals(Ready(release, apk), restartNext.state)
  }

  @Test
  fun `a replay after restart reaches the same installed state`() {
    val live = UpdateRecord(Installing(release, apk, now - 1_000L), 100L, release, 1_066_110L)
    val restarted = UpdateRecordCodec.load(UpdateRecordCodec.encode(live))

    val (liveNext, liveEffects) =
      UpdateReducer.reduce(live, UpdateEvent.InstallSucceeded, 1_066_112L, now)
    val (restartNext, restartEffects) =
      UpdateReducer.reduce(restarted, UpdateEvent.InstallSucceeded, 1_066_112L, now)

    assertEquals(liveNext, restartNext)
    assertEquals(liveEffects, restartEffects)
    assertEquals(Idle(), restartNext.state)
    assertEquals(1_066_112L, restartNext.notifiedCode)
  }

  @Test
  fun `a needs tap intent is not persisted`() {
    val record = UpdateRecord(Installing(release, apk, now), 100L, release, 1_066_110L)
    val decoded = UpdateRecordCodec.decode(UpdateRecordCodec.encode(record))!!

    val (next, effects) = UpdateReducer.reduce(decoded, UpdateEvent.InstallNeedsTap("intent"), 1_066_110L, now)

    assertEquals(NeedsTap(release, apk), next.state)
    assertEquals(listOf(UpdateEffect.PostUpdateReady), effects)
  }
}
