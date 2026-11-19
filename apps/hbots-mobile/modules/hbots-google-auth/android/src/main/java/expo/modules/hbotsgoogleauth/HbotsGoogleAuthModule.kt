package expo.modules.hbotsgoogleauth

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val REQUEST = 0x4847

/**
 * Google's own authorization sheet for the Gmail scopes. It returns a one-time server auth code
 * that the hbots server exchanges for a refresh token with the web client's secret, so no token
 * or secret ever sits on the phone. Also reads the app's signing certificate for the setup guide.
 */
class HbotsGoogleAuthModule : Module() {
  private var waiting: Promise? = null
  private var requested: List<String> = emptyList()

  private fun finish(map: Map<String, Any?>) {
    val pending = waiting ?: return
    waiting = null
    pending.resolve(map)
  }

  private fun settle(result: AuthorizationResult) {
    finish(
      interpretAuthorization(
        result.serverAuthCode,
        result.grantedScopes,
        requested,
      ).toMap(),
    )
  }

  private fun fail(error: Exception) {
    val code = (error as? ApiException)?.statusCode ?: -1
    finish(failureMap(code, error.message))
  }

  private fun certificate(context: Context): ByteArray? {
    val packages = context.packageManager
    return if (Build.VERSION.SDK_INT >= 28) {
      val info = packages.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      info.signingInfo?.apkContentsSigners?.firstOrNull()?.toByteArray()
    } else {
      @Suppress("DEPRECATION")
      val info = packages.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
      @Suppress("DEPRECATION")
      info.signatures?.firstOrNull()?.toByteArray()
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HbotsGoogleAuth")

    /** The package name and signing certificate fingerprints Google's Android client needs. */
    Function("signingIdentity") {
      val context = appContext.reactContext?.applicationContext ?: return@Function null
      val der = certificate(context) ?: return@Function null
      signingIdentityMap(context.packageName, der)
    }

    AsyncFunction("authorize") { serverClientId: String, scopes: List<String>, promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("E_NO_ACTIVITY", "No activity to show Google sign-in from.", null)
      if (waiting != null) {
        return@AsyncFunction promise.reject("E_BUSY", "A Google sign-in is already open.", null)
      }
      waiting = promise
      requested = scopes
      val request = AuthorizationRequest.builder()
        .setRequestedScopes(scopes.map { Scope(it) })
        .requestOfflineAccess(serverClientId, true)
        .build()
      Identity.getAuthorizationClient(activity)
        .authorize(request)
        .addOnSuccessListener { result ->
          val pendingIntent = result.pendingIntent
          if (result.hasResolution() && pendingIntent != null) {
            try {
              activity.startIntentSenderForResult(pendingIntent.intentSender, REQUEST, null, 0, 0, 0, null)
            } catch (error: Exception) {
              fail(error)
            }
          } else {
            settle(result)
          }
        }
        .addOnFailureListener { fail(it) }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { activity, payload ->
      if (payload.requestCode != REQUEST) return@OnActivityResult
      if (payload.resultCode != Activity.RESULT_OK) {
        finish(cancelledMap())
        return@OnActivityResult
      }
      try {
        settle(Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(payload.data))
      } catch (error: Exception) {
        fail(error)
      }
    }
  }
}
