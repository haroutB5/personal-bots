package expo.modules.hbotsupdater

import android.content.Context
import android.util.Log
import java.net.URL
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody

object UpdateSession {
  private const val TAG = "HbotsUpdate"
  private const val SESSION_PATH = "/api/auth/session"
  internal const val MAX_BODY_BYTES = 16 * 1024

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

  data class Probe(
    val verdict: SessionVerdict,
    val status: Int?,
    val elapsedMs: Long,
    val failure: String? = null,
  )

  fun verify(context: Context): SessionVerdict {
    val session = SessionSource.read(context)
    if (session == null) {
      Log.i(TAG, "session check skipped no stored session")
      return SessionVerdict.Unknown
    }
    val probe = probe(session.httpBaseUrl, session.accessToken)
    Log.i(
      TAG,
      "session check status=${probe.status ?: "none"} verdict=${name(probe.verdict)}" +
        " elapsed=${probe.elapsedMs}ms" + (probe.failure?.let { " failure=$it" } ?: ""),
    )
    return probe.verdict
  }

  internal fun probe(
    httpBaseUrl: String,
    accessToken: String,
    now: () -> Long = System::currentTimeMillis,
  ): Probe {
    val url = runCatching { URL(URL(httpBaseUrl), SESSION_PATH).toString() }
      .getOrElse { return Probe(SessionVerdict.Unknown, null, 0, "bad url") }
    val request = Request.Builder()
      .url(url)
      .header("Authorization", "Bearer $accessToken")
      .header("Accept", "application/json")
      .build()
    val started = now()
    return try {
      http.newCall(request).execute().use { response ->
        val body = if (response.code == 200) readCapped(response.body) else null
        if (body is Body.Over) {
          Probe(SessionVerdict.Unknown, response.code, now() - started, body.reason)
        } else {
          val verdict = SessionCheck.classify(response.code, (body as? Body.Text)?.text)
          Probe(verdict, response.code, now() - started)
        }
      }
    } catch (error: Throwable) {
      Probe(SessionVerdict.Unknown, null, now() - started, error.javaClass.simpleName)
    }
  }

  private sealed interface Body {
    data class Text(val text: String) : Body
    data class Over(val reason: String) : Body
  }

  private fun readCapped(body: ResponseBody?): Body? {
    if (body == null) return null
    val source = body.source()
    if (source.request(MAX_BODY_BYTES + 1L)) {
      return Body.Over("body over $MAX_BODY_BYTES bytes")
    }
    return Body.Text(source.readUtf8())
  }

  private fun name(verdict: SessionVerdict): String = when (verdict) {
    SessionVerdict.Valid -> "valid"
    SessionVerdict.Invalid -> "invalid"
    SessionVerdict.Unknown -> "unknown"
  }
}
