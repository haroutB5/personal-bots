package expo.modules.hbotsupdater

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundGateTest {
  @Test
  fun `a resume is visible while the work queue is busy`() {
    val occupied = CountDownLatch(1)
    val release = CountDownLatch(1)
    try {
      UpdateEngine.runSerialForTest {
        occupied.countDown()
        release.await(5, TimeUnit.SECONDS)
      }
      assertTrue("the test must hold the work queue", occupied.await(5, TimeUnit.SECONDS))
      UpdateEngine.onForeground()
      assertTrue(
        "a resume must be visible before the busy queue drains",
        UpdateEngine.isForeground(),
      )
    } finally {
      release.countDown()
      UpdateEngine.onBackground()
    }
  }
}
