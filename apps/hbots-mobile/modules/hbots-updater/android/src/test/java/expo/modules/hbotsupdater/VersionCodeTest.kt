package expo.modules.hbotsupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionCodeTest {
  @Test
  fun `each release part owns three digits`() {
    assertEquals(1066112L, versionCodeOf("1.66.112"))
    assertEquals(1000000L, versionCodeOf("1.0.0"))
    assertEquals(999999999L, versionCodeOf("999.999.999"))
  }

  @Test
  fun `a four digit part is rejected`() {
    assertNull(versionCodeOf("1.66.1000"))
    assertNull(versionCodeOf("1000.1.1"))
  }

  @Test
  fun `malformed names are rejected`() {
    assertNull(versionCodeOf("1.66"))
    assertNull(versionCodeOf("1.66.112-beta"))
    assertNull(versionCodeOf("v1.66.112"))
    assertNull(versionCodeOf("1..112"))
    assertNull(versionCodeOf(""))
  }

  @Test
  fun `a release carries its derived code`() {
    val release = Release("1.66.112", "a".repeat(64), 46_076_721)
    assertEquals(1066112L, release.code)
  }

  @Test
  fun `a release refuses an invalid sha256`() {
    assertThrows(IllegalArgumentException::class.java) {
      Release("1.66.112", "not-a-sha", 46_076_721)
    }
    assertThrows(IllegalArgumentException::class.java) {
      Release("1.66.112", "A".repeat(64), 46_076_721)
    }
  }

  @Test
  fun `a release refuses an invalid size or version`() {
    assertThrows(IllegalArgumentException::class.java) {
      Release("1.66.112", "a".repeat(64), 0)
    }
    assertThrows(IllegalArgumentException::class.java) {
      Release("1.66.1000", "a".repeat(64), 46_076_721)
    }
  }

  @Test
  fun `the version code is monotonic across a patch bump`() {
    assertTrue(versionCodeOf("1.66.113")!! > versionCodeOf("1.66.112")!!)
    assertTrue(versionCodeOf("1.67.0")!! > versionCodeOf("1.66.999")!!)
  }
}
