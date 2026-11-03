package expo.modules.hbotsupdater

import android.content.Context
import android.util.Log
import java.net.URL
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

object UpdateSession {
  private const val TAG = "HbotsUpdate"
  private const val SESSION_PATH = "/api/auth/session"

  private val http by lazy {
    OkHttpClient.Builder()
      .connectTimeout(5, TimeUnit.SECONDS)
      .readTimeout(10, TimeUnit.SECONDS)
      .callTimeout(10, TimeUnit.SECONDS)
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .build()
  }

  fun verify(context: Context): SessionVerdict {
    val session = SessionSource.read(context)
    if (session == null) {
      Log.i(TAG, "session check skipped no stored session")
      return SessionVerdict.Unknown
    }
    val url = runCatching { URL(URL(session.httpBaseUrl), SESSION_PATH).toString() }
      .getOrElse { return SessionVerdict.Unknown }
    val request = Request.Builder()
      .url(url)
      .header("Authorization", "Bearer ${session.accessToken}")
      .header("Accept", "application/json")
      .build()
    return try {
      http.newCall(request).execute().use { response ->
        val body = if (response.code == 200) response.body?.string() else null
        val verdict = SessionCheck.classify(response.code, body)
        Log.i(TAG, "session check http=${response.code} verdict=${name(verdict)}")
        verdict
      }
    } catch (error: Throwable) {
      Log.w(TAG, "session check failed ${error.javaClass.simpleName}")
      SessionVerdict.Unknown
    }
  }

  private fun name(verdict: SessionVerdict): String = when (verdict) {
    SessionVerdict.Valid -> "valid"
    SessionVerdict.Invalid -> "invalid"
    SessionVerdict.Unknown -> "unknown"
  }
}
