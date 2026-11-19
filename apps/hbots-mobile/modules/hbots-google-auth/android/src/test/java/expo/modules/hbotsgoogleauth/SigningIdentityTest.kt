package expo.modules.hbotsgoogleauth

import org.junit.Assert.assertEquals
import org.junit.Test

class SigningIdentityTest {
  @Test
  fun fingerprintsAreUpperCaseColonHexOfTheDigest() {
    val der = "abc".toByteArray()
    assertEquals(
      "A9:99:3E:36:47:06:81:6A:BA:3E:25:71:78:50:C2:6C:9C:D0:D8:9D",
      fingerprint(der, "SHA-1"),
    )
    assertEquals(
      "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD",
      fingerprint(der, "SHA-256"),
    )
  }

  @Test
  fun theIdentityCarriesThePackageAndBothFingerprints() {
    val map = signingIdentityMap("com.haroutb5.hbots", "abc".toByteArray())
    assertEquals("com.haroutb5.hbots", map["packageName"])
    assertEquals("A9:99:3E:36:47:06:81:6A:BA:3E:25:71:78:50:C2:6C:9C:D0:D8:9D", map["sha1"])
  }
}
