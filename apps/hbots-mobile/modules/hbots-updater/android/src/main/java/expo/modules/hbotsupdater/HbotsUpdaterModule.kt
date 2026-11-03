package expo.modules.hbotsupdater

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HbotsUpdaterModule : Module() {
  private var attached = false

  private fun app(): Context? = appContext.reactContext?.applicationContext

  private fun attach() {
    if (attached) return
    val context = app() ?: return
    attached = true
    UpdateEngine.attach(context) { payload -> sendEvent("state", payload) }
  }

  override fun definition() = ModuleDefinition {
    Name("HbotsUpdater")
    Events("state")

    OnCreate { attach() }
    OnDestroy { UpdateEngine.detach() }
    OnActivityEntersForeground { UpdateEngine.onForeground() }
    OnActivityEntersBackground { UpdateEngine.onBackground() }

    AsyncFunction("offer") { release: Map<String, Any?>?, auth: Map<String, Any?>?, options: Map<String, Any?>? ->
      attach()
      val parsed = parseRelease(release)
      if (parsed != null) UpdateNotifier.requestPermission(appContext.currentActivity)
      val manual = options?.get("manual") as? Boolean ?: false
      UpdateEngine.offer(parsed, DownloadAuth.parse(auth), manual)
    }

    AsyncFunction("snapshot") {
      attach()
      UpdateEngine.snapshot()
    }

    AsyncFunction("confirmInstall") {
      attach()
      UpdateEngine.confirmInstall()
    }

    AsyncFunction("openInstallPermission") {
      app()?.let(UpdateInstaller::openInstallPermission)
    }
  }

  private fun parseRelease(raw: Map<String, Any?>?): Release? {
    if (raw == null) return null
    val version = raw["version"] as? String ?: return null
    val sha256 = raw["sha256"] as? String ?: return null
    val size = (raw["size"] as? Number)?.toLong() ?: return null
    return runCatching { Release(version, sha256, size) }.getOrNull()
  }
}
