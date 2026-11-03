package expo.modules.hbotsupdater

import org.json.JSONObject

sealed interface SessionVerdict {
  data object Valid : SessionVerdict
  data object Invalid : SessionVerdict
  data object Unknown : SessionVerdict
}

object SessionCheck {
  fun classify(status: Int, body: String?): SessionVerdict = when {
    status == 401 || status == 403 -> SessionVerdict.Invalid
    status != 200 -> SessionVerdict.Unknown
    else -> authenticated(body)
  }

  private fun authenticated(body: String?): SessionVerdict {
    if (body.isNullOrBlank()) return SessionVerdict.Unknown
    val json = runCatching { JSONObject(body) }.getOrNull() ?: return SessionVerdict.Unknown
    return when (json.opt("authenticated")) {
      true -> SessionVerdict.Valid
      false -> SessionVerdict.Invalid
      else -> SessionVerdict.Unknown
    }
  }
}
