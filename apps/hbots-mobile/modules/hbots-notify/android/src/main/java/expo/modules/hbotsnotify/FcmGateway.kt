package expo.modules.hbotsnotify

/**
 * The only seam to Firebase. A build without google-services.json compiles `FcmGatewayImpl`
 * from src/nofirebase, which has no Firebase import, so no Firebase class can load.
 */
interface FcmGateway {
  val configured: Boolean
  fun token(onResult: (Result<String?>) -> Unit)
  fun deleteToken(onResult: (Result<Unit>) -> Unit)
}

/** A refreshed token reaches JS while it runs. When it does not, JS compares tokens on its next start. */
object TokenEvents {
  @Volatile var listener: ((String) -> Unit)? = null
}
