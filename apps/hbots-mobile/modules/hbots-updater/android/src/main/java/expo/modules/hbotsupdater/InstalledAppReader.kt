package expo.modules.hbotsupdater

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

data class InstalledPackage(val name: String, val code: Long, val signers: List<String>)

object InstalledAppReader {
  fun read(context: Context): InstalledPackage? = runCatching {
    val manager = context.packageManager
    val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      manager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    } else {
      @Suppress("DEPRECATION")
      manager.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
    }
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.signingInfo?.apkContentsSigners.orEmpty()
    } else {
      @Suppress("DEPRECATION")
      info.signatures.orEmpty()
    }
    InstalledPackage(
      name = info.versionName.orEmpty(),
      code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.longVersionCode
      } else {
        @Suppress("DEPRECATION")
        info.versionCode.toLong()
      },
      signers = signatures.map { sha256(it.toByteArray()) },
    )
  }.getOrNull()

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256")
      .digest(bytes)
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
