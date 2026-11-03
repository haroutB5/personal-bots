package expo.modules.hbotsupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DownloadLogTest {
  @Test
  fun `a short body names the size it expected and read`() {
    assertEquals(
      "download rejected short expected=1000 read=900",
      downloadRejection(total = 900, expected = 1000),
    )
  }

  @Test
  fun `an oversize body names the size it expected and read`() {
    assertEquals(
      "download rejected oversize expected=1000 read=1100",
      downloadRejection(total = 1100, expected = 1000),
    )
  }

  @Test
  fun `an exact body has nothing to report`() {
    assertNull(downloadRejection(total = 1000, expected = 1000))
  }
}
