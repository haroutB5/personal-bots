package expo.modules.hbotslauncher

import android.app.PendingIntent
import android.app.AlarmManager
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews

/**
 * The home screen widget: the pinned bots and a dot for the ones working. The system calls
 * [onUpdate] every 30 minutes (`updatePeriodMillis`); the app also calls [refresh] when the feed
 * changes, and a lit dot schedules one more redraw for the moment it goes stale. It draws only from [WidgetStore], so it never needs the app to be running.
 */
class HbotsWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val feed = WidgetStore.read(context)
    val now = System.currentTimeMillis()
    val views = render(context, WidgetModel.build(feed, now))
    for (id in ids) manager.updateAppWidget(id, views)
    scheduleRefresh(context, WidgetModel.nextRefreshAt(feed, now))
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_REFRESH) refresh(context) else super.onReceive(context, intent)
  }

  override fun onDisabled(context: Context) {
    scheduleRefresh(context, null)
  }

  companion object {
    const val ACTION_REFRESH = "expo.modules.hbotslauncher.WIDGET_REFRESH"

    private val rowIds = intArrayOf(R.id.hbots_row1, R.id.hbots_row2, R.id.hbots_row3, R.id.hbots_row4, R.id.hbots_row5)
    private val nameIds = intArrayOf(R.id.hbots_name1, R.id.hbots_name2, R.id.hbots_name3, R.id.hbots_name4, R.id.hbots_name5)
    private val dotIds = intArrayOf(R.id.hbots_dot1, R.id.hbots_dot2, R.id.hbots_dot3, R.id.hbots_dot4, R.id.hbots_dot5)

    /** Redraws every placed widget from the stored feed. */
    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, HbotsWidgetProvider::class.java))
      if (ids.isEmpty()) return
      val feed = WidgetStore.read(context)
      val now = System.currentTimeMillis()
      val views = render(context, WidgetModel.build(feed, now))
      for (id in ids) manager.updateAppWidget(id, views)
      scheduleRefresh(context, WidgetModel.nextRefreshAt(feed, now))
    }

    /**
     * One non-waking alarm for the moment a lit dot goes stale, or none when no dot is lit. Not exact (no
     * permission needed): a late alarm is a few seconds of a stale dot, not a wrong one for minutes.
     */
    private fun scheduleRefresh(context: Context, at: Long?) {
      val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
      val intent = Intent(context, HbotsWidgetProvider::class.java).setAction(ACTION_REFRESH)
      val pending = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      if (at == null) alarms.cancel(pending) else alarms.set(AlarmManager.RTC, at, pending)
    }

    private fun render(context: Context, state: WidgetState): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.hbots_widget)
      views.setTextViewText(R.id.hbots_title, WidgetModel.TITLE)
      views.setOnClickPendingIntent(R.id.hbots_root, openApp(context))
      for (index in rowIds.indices) views.setViewVisibility(rowIds[index], View.GONE)
      views.setViewVisibility(R.id.hbots_message, View.GONE)
      views.setViewVisibility(R.id.hbots_more, View.GONE)
      when (state) {
        WidgetState.SignedOut -> message(views, WidgetModel.SIGNED_OUT_TEXT)
        WidgetState.Empty -> message(views, WidgetModel.EMPTY_TEXT)
        is WidgetState.Bots -> {
          state.rows.forEachIndexed { index, row ->
            views.setViewVisibility(rowIds[index], View.VISIBLE)
            views.setTextViewText(nameIds[index], row.name)
            views.setImageViewResource(dotIds[index], if (row.working) R.drawable.hbots_dot_working else R.drawable.hbots_dot_idle)
            views.setContentDescription(rowIds[index], row.description)
            views.setOnClickPendingIntent(rowIds[index], openLink(context, row.link, index + 1))
          }
          if (state.more > 0) {
            views.setViewVisibility(R.id.hbots_more, View.VISIBLE)
            views.setTextViewText(R.id.hbots_more, "+${state.more} more")
          }
        }
      }
      return views
    }

    private fun message(views: RemoteViews, text: String) {
      views.setViewVisibility(R.id.hbots_message, View.VISIBLE)
      views.setTextViewText(R.id.hbots_message, text)
    }

    private fun openApp(context: Context): PendingIntent {
      val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** The link goes to the app's own activity, so the app lock decides who sees the bot. */
    private fun openLink(context: Context, link: String, requestCode: Int): PendingIntent {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
  }
}
