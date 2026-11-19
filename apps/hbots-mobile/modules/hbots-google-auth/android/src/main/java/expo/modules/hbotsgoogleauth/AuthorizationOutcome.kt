package expo.modules.hbotsgoogleauth

/**
 * What Google's authorization sheet handed back, reduced to the three answers the app acts on.
 * The one-time server auth code is the only secret in here and it never leaves this process
 * except as the return value of the call that asked for it.
 */
sealed interface AuthorizationOutcome {
  data class Granted(val serverAuthCode: String, val grantedScopes: List<String>) : AuthorizationOutcome

  /** The owner unticked a scope on the sheet, so the code would not let a bot read or draft mail. */
  data class ScopesDenied(val missing: List<String>) : AuthorizationOutcome

  /** Play services answered without a code, which a request with offline access should never do. */
  data object NoCode : AuthorizationOutcome
}

fun interpretAuthorization(
  serverAuthCode: String?,
  grantedScopes: List<String>?,
  requested: List<String>,
): AuthorizationOutcome {
  val granted = grantedScopes.orEmpty()
  val missing = requested.filter { it !in granted }
  if (missing.isNotEmpty()) return AuthorizationOutcome.ScopesDenied(missing)
  if (serverAuthCode.isNullOrBlank()) return AuthorizationOutcome.NoCode
  return AuthorizationOutcome.Granted(serverAuthCode, granted)
}

fun AuthorizationOutcome.toMap(): Map<String, Any?> =
  when (this) {
    is AuthorizationOutcome.Granted ->
      mapOf("status" to "granted", "serverAuthCode" to serverAuthCode, "grantedScopes" to grantedScopes)
    is AuthorizationOutcome.ScopesDenied -> mapOf("status" to "scopes_denied", "missing" to missing)
    AuthorizationOutcome.NoCode -> mapOf("status" to "no_code")
  }

fun cancelledMap(): Map<String, Any?> = mapOf("status" to "cancelled")

fun failureMap(statusCode: Int, message: String?): Map<String, Any?> =
  mapOf("status" to "error", "code" to statusCode, "message" to (message ?: "Google sign-in failed."))
