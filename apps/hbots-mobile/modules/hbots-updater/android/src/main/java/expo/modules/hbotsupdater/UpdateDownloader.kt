package expo.modules.hbotsupdater

import android.content.Context
import android.os.StatFs
import android.util.Log
import java.io.File
import java.net.URL
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

data class DownloadAuth(val apkUrl: String, val bearer: String, val authMethod: String) {
  companion object {
    fun parse(raw: Map<String, Any?>?): DownloadAuth? {
      if (raw == null) return null
      val url = raw["apkUrl"] as? String ?: return null
      val bearer = raw["bearer"] as? String ?: return null
      if (bearer.isBlank()) return null
      val method = raw["authMethod"] as? String ?: "bearer"
      if (method != "bearer" && method != "dpop") return null
      val parsed = runCatching { URL(url) }.getOrNull() ?: return null
      if (parsed.protocol != "https") return null
      return DownloadAuth(parsed.toString(), bearer, method)
    }
  }
}

sealed interface DownloadOutcome {
  data class Ready(val apk: String) : DownloadOutcome
  data class Rejected(val reason: String) : DownloadOutcome
  data object Failed : DownloadOutcome
}

internal fun downloadRejection(total: Long, expected: Long): String? = when {
  total > expected -> "download rejected oversize expected=$expected read=$total"
  total != expected -> "download rejected short expected=$expected read=$total"
  else -> null
}

object UpdateDownloader {
  private const val TAG = "HbotsUpdate"

  private val http by lazy {
    OkHttpClient.Builder()
      .connectTimeout(5, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .callTimeout(0, TimeUnit.MILLISECONDS)
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .build()
  }

  fun download(
    context: Context,
    target: Release,
    auth: DownloadAuth,
    installed: InstalledApp,
    pinSha256: String,
  ): DownloadOutcome {
    val dir = File(context.cacheDir, "updates")
    if (!dir.isDirectory && !dir.mkdirs()) {
      Log.w(TAG, "download failed no cache dir")
      return DownloadOutcome.Failed
    }
    val available = runCatching { StatFs(dir.absolutePath).availableBytes }.getOrDefault(0L)
    if (available < target.size * 2) {
      Log.w(TAG, "download failed space available=$available need=${target.size * 2}")
      return DownloadOutcome.Failed
    }

    val apk = File(dir, "${target.code}.apk")
    val part = File(dir, "${target.code}.apk.part")
    part.delete()
    var complete = false
    try {
      val requestBuilder = Request.Builder().url(auth.apkUrl)
      if (auth.authMethod == "dpop") {
        val key = DpopKeySource.read(context)
        if (key == null) {
          Log.w(TAG, "download failed no dpop key")
          return DownloadOutcome.Failed
        }
        val proof = DpopProof.create(key, "GET", auth.apkUrl, auth.bearer)
        if (proof == null) {
          Log.w(TAG, "download failed no dpop proof")
          return DownloadOutcome.Failed
        }
        requestBuilder
          .header("Authorization", "DPoP ${auth.bearer}")
          .header("DPoP", proof)
      } else {
        requestBuilder.header("Authorization", "Bearer ${auth.bearer}")
      }
      val request = requestBuilder.build()
      http.newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
          Log.w(TAG, "download failed http=${response.code}")
          return DownloadOutcome.Failed
        }
        val body = response.body
        if (body == null) {
          Log.w(TAG, "download failed no body")
          return DownloadOutcome.Failed
        }
        var total = 0L
        body.byteStream().use { input ->
          part.outputStream().use { output ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
              val read = input.read(buffer)
              if (read <= 0) break
              total += read
              if (total > target.size) {
                Log.w(TAG, downloadRejection(total, target.size).orEmpty())
                return DownloadOutcome.Failed
              }
              output.write(buffer, 0, read)
            }
          }
        }
        if (total != target.size) {
          Log.w(TAG, downloadRejection(total, target.size).orEmpty())
          return DownloadOutcome.Failed
        }
      }
      apk.delete()
      if (!part.renameTo(apk)) {
        Log.w(TAG, "download failed rename")
        return DownloadOutcome.Failed
      }
      complete = true
      val facts = runCatching { ApkFileReader().read(apk) }.getOrNull()
      if (facts == null) {
        Log.w(TAG, "apk rejected unreadable")
        apk.delete()
        return DownloadOutcome.Rejected("unreadable")
      }
      return when (val verification = ApkVerifier.verify(facts, target, pinSha256, installed)) {
        ApkVerification.Verified -> {
          Log.i(TAG, "apksig verified ${target.version} bytes=${facts.byteSize}")
          DownloadOutcome.Ready(apk.absolutePath)
        }
        is ApkVerification.Rejected -> {
          val reason = reasonOf(verification.reason)
          Log.w(TAG, "apk rejected $reason")
          apk.delete()
          DownloadOutcome.Rejected(reason)
        }
      }
    } catch (error: Throwable) {
      Log.w(TAG, "download failed ${error.javaClass.simpleName}")
      return DownloadOutcome.Failed
    } finally {
      if (!complete) runCatching { part.delete() }
    }
  }

  private fun reasonOf(reason: ApkVerification.Reason): String = when (reason) {
    ApkVerification.Reason.SignerNotPinned,
    ApkVerification.Reason.SignerNotInstalled,
    ApkVerification.Reason.NoSigner,
    ApkVerification.Reason.MultipleSigners -> "signature"
    else -> reason.name.lowercase()
  }
}
