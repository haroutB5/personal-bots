package expo.modules.hbotsupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Test
import java.io.File

class ReleasePinTest {
  @Test
  fun `the compiled pin is the release pin file`() {
    // An updater test build compiles a throwaway key on purpose.
    assumeFalse("a test build compiles its own pin", BuildConfig.UPDATE_TEST_PIN)
    val pinPath =
      requireNotNull(System.getProperty("release.pin.file")) { "release.pin.file is not set" }
    val filePin = File(pinPath).readText().trim()
    assertTrue(
      "release-cert.sha256 must be a lowercase sha256, got $filePin",
      Regex("^[0-9a-f]{64}$").matches(filePin),
    )
    assertEquals(filePin, BuildConfig.RELEASE_CERT_SHA256)
  }
}
