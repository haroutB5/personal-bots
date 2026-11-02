package expo.modules.hbotsupdater

data class InstalledApp(val code: Long, val signers: List<String>)

data class ApkFacts(
  val byteSize: Long,
  val sha256: String,
  val packageName: String,
  val versionCode: Long,
  val versionName: String,
  val signers: List<String>,
)

sealed interface ApkVerification {
  data object Verified : ApkVerification
  data class Rejected(val reason: Reason) : ApkVerification

  enum class Reason {
    Size,
    Sha256,
    Package,
    VersionCode,
    VersionName,
    Downgrade,
    NoSigner,
    MultipleSigners,
    SignerNotPinned,
    SignerNotInstalled,
  }
}

object ApkVerifier {
  const val PACKAGE_NAME = "com.haroutb5.hbots"

  fun verify(
    facts: ApkFacts,
    release: Release,
    pinSha256: String,
    installed: InstalledApp,
  ): ApkVerification {
    if (facts.byteSize != release.size) return reject(ApkVerification.Reason.Size)
    if (!facts.sha256.equals(release.sha256, ignoreCase = true)) {
      return reject(ApkVerification.Reason.Sha256)
    }
    if (facts.packageName != PACKAGE_NAME) return reject(ApkVerification.Reason.Package)
    if (facts.versionCode != release.code) return reject(ApkVerification.Reason.VersionCode)
    if (facts.versionName != release.version) return reject(ApkVerification.Reason.VersionName)
    if (facts.versionCode <= installed.code) return reject(ApkVerification.Reason.Downgrade)
    if (facts.signers.isEmpty()) return reject(ApkVerification.Reason.NoSigner)
    if (facts.signers.size > 1) return reject(ApkVerification.Reason.MultipleSigners)

    val signer = facts.signers.single()
    val pin = pinSha256.lowercase()
    if (signer != pin) return reject(ApkVerification.Reason.SignerNotPinned)
    val installedSigners = installed.signers.map { it.lowercase() }.toSet()
    if (installedSigners != setOf(pin)) return reject(ApkVerification.Reason.SignerNotInstalled)

    return ApkVerification.Verified
  }

  private fun reject(reason: ApkVerification.Reason) = ApkVerification.Rejected(reason)
}
