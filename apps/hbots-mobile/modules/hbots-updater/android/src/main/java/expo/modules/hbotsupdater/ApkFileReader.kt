package expo.modules.hbotsupdater

import com.android.apksig.ApkVerifier as ApksigVerifier
import java.io.File
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.zip.ZipFile

class ApkFileReader {
  fun read(file: File): ApkFacts {
    if (!file.isFile) throw ApkReadException("apk missing")
    val size = file.length()
    val sha256 = sha256(file)
    val manifest = readManifest(file)
    val signers = readSigners(file)

    return ApkFacts(
      byteSize = size,
      sha256 = sha256,
      packageName = manifest.packageName,
      versionCode = manifest.versionCode ?: throw ApkReadException("versionCode missing"),
      versionName = manifest.versionName ?: throw ApkReadException("versionName missing"),
      signers = signers,
    )
  }

  private fun readManifest(file: File): BinaryManifest.Info {
    val bytes = try {
      ZipFile(file).use { zip ->
        val entry = zip.getEntry("AndroidManifest.xml")
          ?: throw ApkReadException("AndroidManifest.xml missing")
        zip.getInputStream(entry).use { it.readBytes() }
      }
    } catch (error: ApkReadException) {
      throw error
    } catch (error: Exception) {
      throw ApkReadException("apk unreadable", error)
    }
    return BinaryManifest.parse(bytes)
  }

  private fun readSigners(file: File): List<String> {
    val result = try {
      ApksigVerifier.Builder(file).setMinCheckedPlatformVersion(26).build().verify()
    } catch (error: Exception) {
      throw ApkReadException("apk signature unreadable", error)
    }
    if (!result.isVerified) throw ApkReadException("apk signature invalid")

    val signers = linkedSetOf<String>()
    if (result.isVerifiedUsingV1Scheme) {
      result.v1SchemeSigners.forEach { signers.add(certificateDigest(it.certificate)) }
    }
    if (result.isVerifiedUsingV2Scheme) {
      result.v2SchemeSigners.forEach { signers.add(certificateDigest(it.certificate)) }
    }
    if (result.isVerifiedUsingV3Scheme) {
      result.v3SchemeSigners.forEach { signers.add(certificateDigest(it.certificate)) }
    }
    if (result.isVerifiedUsingV31Scheme) {
      result.v31SchemeSigners.forEach { signers.add(certificateDigest(it.certificate)) }
    }
    if (signers.isEmpty()) throw ApkReadException("apk has no verified signer")
    return signers.toList()
  }

  private fun certificateDigest(certificate: X509Certificate): String =
    MessageDigest.getInstance("SHA-256")
      .digest(certificate.encoded)
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(128 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }
}
