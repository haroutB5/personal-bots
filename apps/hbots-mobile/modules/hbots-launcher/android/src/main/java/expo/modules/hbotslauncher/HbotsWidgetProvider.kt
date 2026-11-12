package expo.modules.hbotslauncher

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle

/**
 * One home screen widget. The system calls [onUpdate] when it is placed and every 30 minutes; the
 * app calls [HbotsWidgets.refresh] when the feed changes. It draws only from [WidgetStore], so it
 * never needs the app to be running and never touches the network.
 */
abstract class BaseWidgetProvider(private val key: String) : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    HbotsWidgets.refresh(context, only = key, force = true)
  }

  /** A resize changes how many rows fit. */
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    HbotsWidgets.refresh(context, only = key, force = true)
  }

  override fun onDisabled(context: Context) {
    HbotsWidgets.refresh(context)
  }
}

/** Widget 1, the Live board. It keeps the first widget's class name, so a placed one upgrades in place. */
class HbotsWidgetProvider : BaseWidgetProvider(WidgetPictures.BOARD) {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_REFRESH) HbotsWidgets.refresh(context) else super.onReceive(context, intent)
  }

  companion object {
    const val ACTION_REFRESH = "expo.modules.hbotslauncher.WIDGET_REFRESH"
  }
}

class NeedsYouWidgetProvider : BaseWidgetProvider(WidgetPictures.NEEDS)
class TileGridWidgetProvider : BaseWidgetProvider(WidgetPictures.TILES)
class QuickAskWidgetProvider : BaseWidgetProvider(WidgetPictures.ASK)
class UsageWidgetProvider : BaseWidgetProvider(WidgetPictures.USAGE)
class OneBotWidgetProvider : BaseWidgetProvider(WidgetPictures.BOT)
class MachinesWidgetProvider : BaseWidgetProvider(WidgetPictures.MACHINES)
class TodayWidgetProvider : BaseWidgetProvider(WidgetPictures.TODAY)

/** Draws the placed widgets, and only the ones whose picture changed. */
object HbotsWidgets {
  private const val PREFS = "hbots_widgets_drawn"

  private val providers: Map<String, Class<out AppWidgetProvider>> = mapOf(
    WidgetPictures.BOARD to HbotsWidgetProvider::class.java,
    WidgetPictures.NEEDS to NeedsYouWidgetProvider::class.java,
    WidgetPictures.TILES to TileGridWidgetProvider::class.java,
    WidgetPictures.ASK to QuickAskWidgetProvider::class.java,
    WidgetPictures.USAGE to UsageWidgetProvider::class.java,
    WidgetPictures.BOT to OneBotWidgetProvider::class.java,
    WidgetPictures.MACHINES to MachinesWidgetProvider::class.java,
    WidgetPictures.TODAY to TodayWidgetProvider::class.java,
  )

  /**
   * Redraws from the stored feed. Without `force` a widget is redrawn only when its picture
   * differs from the one last drawn, so the 15 s heartbeat costs nothing. `only` names one kind.
   */
  fun refresh(context: Context, only: String? = null, force: Boolean = false) {
    val manager = AppWidgetManager.getInstance(context) ?: return
    val feed = WidgetStore.read(context)
    val now = System.currentTimeMillis()
    val drawn = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val edit = drawn.edit()
    var placed = false
    for ((key, model) in WidgetPictures.all(feed, now)) {
      val provider = providers[key] ?: continue
      val ids = manager.getAppWidgetIds(ComponentName(context, provider)) ?: continue
      if (ids.isEmpty()) {
        edit.remove(key)
        continue
      }
      placed = true
      if (only != null && only != key) continue
      val signature = WidgetPictures.signature(model)
      if (!force && drawn.getString(key, null) == signature) continue
      for (id in ids) manager.updateAppWidget(id, WidgetRenderer.render(context, model, manager.getAppWidgetOptions(id)))
      edit.putString(key, signature)
    }
    edit.apply()
    schedule(context, if (placed) WidgetCommon.nextRefreshAt(feed, now) else null)
  }

  /**
   * One non-waking alarm for the moment the feed goes stale, or none. Not exact (no permission
   * needed): a late alarm is a few seconds of an old picture, not a wrong one for minutes.
   */
  private fun schedule(context: Context, at: Long?) {
    val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val intent = Intent(context, HbotsWidgetProvider::class.java).setAction(HbotsWidgetProvider.ACTION_REFRESH)
    val pending = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    if (at == null) alarms.cancel(pending) else alarms.set(AlarmManager.RTC, at, pending)
  }
}
