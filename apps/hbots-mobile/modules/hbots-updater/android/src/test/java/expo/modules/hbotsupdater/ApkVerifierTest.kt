package expo.modules.hbotsupdater

import expo.modules.hbotsupdater.ApkVerification.Reason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File

class ApkVerifierTest {
  private val pinA = "27e3c40958b1341371c5f96879cd19994faf289b93c50832c58390666be83874"
  private val pinB = "b0ee9d6029d455e2d0dd385d44c8dc015b337316199597bf6bc489f07a864ab2"
  private val goodSha = "38a7736049a0ca31e32a538fc438b49ba51aa1d2404355d50cf072f7ecfba113"
  private val good = Release("1.66.112", goodSha, 8_524)
  private val wrongPackage = Release("1.66.112", "11321bcaa9b3fd770984a6f9d0b2692b99313125a16b986ed975eb3173a163f0", 8_524)
  private val wrongCode = Release("1.66.112", "d84e426a8ed9d7ef7207492d11b5eb24899503894d65a4b87803c78c9c120521", 8_524)
  private val wrongName = Release("1.66.112", "9e24aca93168393ffa13908ecd13f5518d56b3a216efd166f6dc45dac9bbf4fb", 8_524)
  private val wrongSigner = Release("1.66.112", "66dd9df50dff5c5e3dae900031466a850fc46931a54ea5b08f9f45b3197f1ed3", 8_524)
  private val twoSigners = Release("1.66.112", "0d044d5749c227953f83509d590f37334f85588a0edfc16ecd39f6f66de13d75", 3_996)
  private val installed = InstalledApp(1_066_110L, listOf(pinA))
  private val reader = ApkFileReader()

  private fun fixture(name: String): File {
    val dir = File(System.getProperty("fixtures.dir"))
    val file = File(dir, name)
    check(file.isFile) { "fixture missing: ${file.absolutePath}" }
    return file
  }

  private fun verify(file: String, release: Release = good, pin: String = pinA, app: InstalledApp = installed): ApkVerification =
    ApkVerifier.verify(reader.read(fixture(file)), release, pin, app)

  @Test
  fun `the good fixture is accepted`() {
    assertEquals(ApkVerification.Verified, verify("good-1.66.112.apk"))
  }

  @Test
  fun `the reader extracts the manifest and the signature`() {
    val facts = reader.read(fixture("good-1.66.112.apk"))

    assertEquals("com.haroutb5.hbots", facts.packageName)
    assertEquals(1_066_112L, facts.versionCode)
    assertEquals("1.66.112", facts.versionName)
    assertEquals(8_524L, facts.byteSize)
    assertEquals(goodSha, facts.sha256)
    assertEquals(listOf(pinA), facts.signers)
  }

  @Test
  fun `a wrong size is rejected`() {
    assertEquals(
      ApkVerification.Rejected(Reason.Size),
      verify("good-1.66.112.apk", release = good.copy(size = good.size + 1)),
    )
  }

  @Test
  fun `a wrong sha256 is rejected`() {
    assertEquals(
      ApkVerification.Rejected(Reason.Sha256),
      verify("good-1.66.112.apk", release = good.copy(sha256 = "0".repeat(64))),
    )
  }

  @Test
  fun `a wrong package is rejected`() {
    assertEquals(ApkVerification.Rejected(Reason.Package), verify("wrong-package.apk", release = wrongPackage))
  }

  @Test
  fun `a wrong versionCode is rejected`() {
    assertEquals(ApkVerification.Rejected(Reason.VersionCode), verify("wrong-version-code.apk", release = wrongCode))
  }

  @Test
  fun `a wrong versionName is rejected`() {
    assertEquals(ApkVerification.Rejected(Reason.VersionName), verify("wrong-version-name.apk", release = wrongName))
  }

  @Test
  fun `a downgrade is rejected`() {
    assertEquals(
      ApkVerification.Rejected(Reason.Downgrade),
      verify("good-1.66.112.apk", app = InstalledApp(1_066_112L, listOf(pinA))),
    )
  }

  @Test
  fun `a signer that is not the pin is rejected`() {
    assertEquals(ApkVerification.Rejected(Reason.SignerNotPinned), verify("wrong-signer.apk", release = wrongSigner))
  }

  @Test
  fun `more than one signer is rejected`() {
    assertEquals(ApkVerification.Rejected(Reason.MultipleSigners), verify("two-signers.apk", release = twoSigners))
  }

  @Test
  fun `a signer that is not the installed signer is rejected`() {
    assertEquals(
      ApkVerification.Rejected(Reason.SignerNotInstalled),
      verify("good-1.66.112.apk", app = InstalledApp(1_066_110L, listOf(pinB))),
    )
  }

  @Test
  fun `the pin is compared without case`() {
    assertEquals(ApkVerification.Verified, verify("good-1.66.112.apk", pin = pinA.uppercase()))
  }

  @Test
  fun `a file that is not an apk is unreadable`() {
    val work = File(System.getProperty("fixtures.work")).apply { mkdirs() }
    val file = File(work, "not-an-apk.bin")
    file.writeText("this is not a zip")

    assertThrows(ApkReadException::class.java) { reader.read(file) }
  }

  @Test
  fun `a fact set without a signer is rejected`() {
    val facts = ApkFacts(8_524, goodSha, "com.haroutb5.hbots", 1_066_112, "1.66.112", emptyList())

    assertEquals(
      ApkVerification.Rejected(Reason.NoSigner),
      ApkVerifier.verify(facts, good, pinA, installed),
    )
  }
}
