package expo.modules.hbotslauncher

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

/** Publishes the planned dynamic shortcuts. The static CTO shortcut is in the manifest and is left alone. */
object LauncherShortcuts {
  private const val TAG = "HbotsLauncher"

  /** Replaces the dynamic shortcuts with the pins. An empty list removes them. */
  fun publish(context: Context, bots: List<PinnedBot>) {
    try {
      val room = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context) - STATIC_SHORTCUTS
      val specs = ShortcutPlanner.plan(bots, room)
      if (specs.isEmpty()) {
        ShortcutManagerCompat.removeAllDynamicShortcuts(context)
        return
      }
      ShortcutManagerCompat.setDynamicShortcuts(context, specs.map { build(context, it) })
    } catch (cause: RuntimeException) {
      // A launcher that refuses shortcuts must never take the app down.
      Log.w(TAG, "shortcuts not updated: ${cause.javaClass.simpleName}")
    }
  }

  /** Sign-out: no shortcut of the old session stays. */
  fun clear(context: Context) {
    try {
      ShortcutManagerCompat.removeAllDynamicShortcuts(context)
    } catch (cause: RuntimeException) {
      Log.w(TAG, "shortcuts not cleared: ${cause.javaClass.simpleName}")
    }
  }

  private fun build(context: Context, spec: ShortcutSpec): ShortcutInfoCompat {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(spec.link)).setPackage(context.packageName)
    return ShortcutInfoCompat.Builder(context, spec.id)
      .setShortLabel(spec.shortLabel)
      .setLongLabel(spec.longLabel)
      .setIcon(IconCompat.createWithResource(context, R.drawable.hbots_shortcut_icon))
      .setIntent(intent)
      .setRank(spec.rank)
      .build()
  }

  /** The manifest declares one static shortcut (R3, "New CTO chat"). */
  private const val STATIC_SHORTCUTS = 1
}
