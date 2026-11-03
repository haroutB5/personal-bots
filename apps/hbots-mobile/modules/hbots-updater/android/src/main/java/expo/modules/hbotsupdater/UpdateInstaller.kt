package expo.modules.hbotsupdater

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.io.File

internal const val UPDATE_INSTALL_ACTION = "expo.modules.hbotsupdater.UPDATE_INSTALL_STATUS"

enum class UpdateInstallResult { STARTED, NOT_PERMITTED, DEFERRED, INVALID, ERROR }

object UpdateInstaller {
  private const val TAG = "HbotsUpdate"

  fun canInstall(context: Context): Boolean =
    runCatching { context.packageManager.canRequestPackageInstalls() }.getOrDefault(false)

  fun openInstallPermission(context: Context) {
    val uri = Uri.parse("package:${context.packageName}")
    val opened = runCatching {
      context.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }.isSuccess
    if (!opened) {
      runCatching {
        context.startActivity(
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
    }
  }

  fun install(context: Context, apk: File, target: Release): UpdateInstallResult {
    if (!canInstall(context)) return UpdateInstallResult.NOT_PERMITTED
    if (!apk.isFile) return UpdateInstallResult.INVALID
    val installer = context.packageManager.packageInstaller
    var sessionId = -1
    return try {
      sessionId = createSession(installer, context.packageName, silent = true)
      installer.openSession(sessionId).use { session ->
        session.openWrite("base.apk", 0, apk.length()).use { output ->
          apk.inputStream().use { input -> input.copyTo(output, 128 * 1024) }
          session.fsync(output)
        }
        if (UpdateEngine.isForeground()) {
          runCatching { installer.abandonSession(sessionId) }
          return UpdateInstallResult.DEFERRED
        }
        val status = Intent(context, UpdateInstallReceiver::class.java).setAction(UPDATE_INSTALL_ACTION)
        val pending = PendingIntent.getBroadcast(
          context,
          sessionId,
          status,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        session.commit(pending.intentSender)
      }
      Log.i(TAG, "install started code=${target.code}")
      UpdateInstallResult.STARTED
    } catch (error: SecurityException) {
      if (sessionId >= 0) runCatching { installer.abandonSession(sessionId) }
      retryWithoutSilentPermission(context, installer, apk, target)
    } catch (error: Throwable) {
      if (sessionId >= 0) runCatching { installer.abandonSession(sessionId) }
      Log.w(TAG, "install error ${error.javaClass.simpleName}")
      UpdateInstallResult.ERROR
    }
  }

  private fun retryWithoutSilentPermission(
    context: Context,
    installer: PackageInstaller,
    apk: File,
    target: Release,
  ): UpdateInstallResult {
    var sessionId = -1
    return try {
      sessionId = createSession(installer, context.packageName, silent = false)
      installer.openSession(sessionId).use { session ->
        session.openWrite("base.apk", 0, apk.length()).use { output ->
          apk.inputStream().use { input -> input.copyTo(output, 128 * 1024) }
          session.fsync(output)
        }
        if (UpdateEngine.isForeground()) {
          runCatching { installer.abandonSession(sessionId) }
          return UpdateInstallResult.DEFERRED
        }
        val status = Intent(context, UpdateInstallReceiver::class.java).setAction(UPDATE_INSTALL_ACTION)
        val pending = PendingIntent.getBroadcast(
          context,
          sessionId,
          status,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        session.commit(pending.intentSender)
      }
      Log.i(TAG, "install started with user action code=${target.code}")
      UpdateInstallResult.STARTED
    } catch (error: Throwable) {
      if (sessionId >= 0) runCatching { installer.abandonSession(sessionId) }
      Log.w(TAG, "install error ${error.javaClass.simpleName}")
      UpdateInstallResult.ERROR
    }
  }

  private fun createSession(
    installer: PackageInstaller,
    packageName: String,
    silent: Boolean,
  ): Int {
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(packageName)
      if (silent && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
      }
    }
    return installer.createSession(params)
  }
}

class UpdateInstallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_SUCCESS -> UpdateEngine.onInstallSucceeded(app)
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        @Suppress("DEPRECATION") // The typed overload needs API 33; minSdk is 26.
        val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        UpdateEngine.onInstallNeedsTap(app, confirm)
      }
      else -> UpdateEngine.onInstallFailed(
        app,
        intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
      )
    }
  }
}
