package expo.modules.hbotslauncher

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews

/** Turns a widget's model into RemoteViews. Every tap is a link into the app, so the app lock applies. */
object WidgetRenderer {
  private const val AMBER = 0xFFF5B14A.toInt()
  private const val GREEN = 0xFF4ADE80.toInt()
  private const val MUTED = 0xFF8C8C88.toInt()
  private const val PAD = 24
  private const val HEADER = 24
  private const val ROW = 48

  fun render(context: Context, model: Any, options: Bundle?): RemoteViews {
    val height = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT) ?: 0
    return when (model) {
      is WidgetState.Board -> board(context, model, height)
      WidgetState.Empty -> message(context, WidgetCommon.TITLE, WidgetModel.EMPTY_TEXT)
      is NeedsYouState.Data -> needs(context, model, height)
      is TileGridState.Data -> tiles(context, model, height)
      TileGridState.Empty -> message(context, WidgetCommon.TITLE, WidgetModel.EMPTY_TEXT)
      is QuickAskState.Ready -> ask(context, model)
      is UsageState.Data -> usage(context, model)
      UsageState.Empty -> message(context, "Usage", UsageModel.EMPTY_TEXT)
      is OneBotState.Data -> bot(context, model)
      OneBotState.Empty -> message(context, WidgetCommon.TITLE, OneBotModel.EMPTY_TEXT)
      is MachinesState.Data -> machines(context, model)
      MachinesState.Empty -> message(context, "Machines", MachinesModel.EMPTY_TEXT)
      is TodayState.Data -> today(context, model, height)
      TodayState.Empty -> message(context, TodayModel.TITLE, TodayModel.EMPTY_TEXT)
      else -> message(context, WidgetCommon.TITLE, WidgetCommon.SIGNED_OUT_TEXT)
    }
  }

  private fun message(context: Context, title: String, text: String): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget_message)
    views.setTextViewText(R.id.hbots_title, title)
    views.setTextViewText(R.id.hbots_message, text)
    views.setContentDescription(R.id.hbots_root, "$title. $text")
    views.setOnClickPendingIntent(R.id.hbots_root, openApp(context))
    return views
  }

  private fun board(context: Context, model: WidgetState.Board, height: Int): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget)
    header(context, views, model.title, "", model.asOf)
    val gauges = listOfNotNull(model.usage?.session, model.usage?.week)
    val reserved = PAD + HEADER + (if (model.idle.isEmpty()) 0 else 36) + gauges.size * 22
    for (line in model.rows.take(WidgetFit.rows(height, reserved, ROW, model.rows.size))) {
      views.addView(R.id.hbots_rows, row(context, line))
    }
    if (model.idle.isNotEmpty()) {
      views.setViewVisibility(R.id.hbots_strip_row, View.VISIBLE)
      for (line in model.idle) {
        val chip = RemoteViews(context.packageName, R.layout.hbots_w_face)
        face(chip, line.face)
        chip.setContentDescription(R.id.hbots_item, line.description)
        chip.setOnClickPendingIntent(R.id.hbots_item, openLink(context, line.link))
        views.addView(R.id.hbots_strip, chip)
      }
      views.setTextViewText(R.id.hbots_more, if (model.moreIdle > 0) "+${model.moreIdle}" else "")
    }
    for (gauge in gauges) views.addView(R.id.hbots_gauges, gauge(context, gauge))
    return views
  }

  private fun needs(context: Context, model: NeedsYouState.Data, height: Int): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget_needs)
    header(context, views, model.headline, model.side, model.asOf)
    if (model.question != null) views.setTextColor(R.id.hbots_title, AMBER)
    val card = model.question
    if (card != null) {
      views.setViewVisibility(R.id.hbots_card, View.VISIBLE)
      views.setTextViewText(R.id.hbots_meta, card.meta)
      views.setTextViewText(R.id.hbots_question, card.text)
      views.setContentDescription(R.id.hbots_card, card.description)
      views.setOnClickPendingIntent(R.id.hbots_card, openLink(context, card.openLink))
      for (choice in card.choices) {
        views.addView(R.id.hbots_choices, button(context, R.layout.hbots_w_choice, choice.label, "Answer ${choice.label}", choice.link))
      }
      views.addView(R.id.hbots_choices, button(context, R.layout.hbots_w_choice_quiet, "Open", "Open the chat", card.openLink))
    }
    val reserved = PAD + HEADER + 52 + (if (card == null) 0 else 124)
    for (line in model.rows.take(WidgetFit.rows(height, reserved, ROW, model.rows.size, min = 0))) {
      views.addView(R.id.hbots_rows, row(context, line))
    }
    views.setOnClickPendingIntent(R.id.hbots_ask, openLink(context, model.askLink))
    views.setOnClickPendingIntent(R.id.hbots_voice, openLink(context, model.voiceLink))
    views.setOnClickPendingIntent(R.id.hbots_photo, openLink(context, model.photoLink))
    return views
  }

  private fun tiles(context: Context, model: TileGridState.Data, height: Int): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget_tiles)
    header(context, views, model.title, model.side, model.asOf)
    val lines = listOf(model.laptop, model.gaming, model.usage).count { it.isNotEmpty() }
    val wanted = (model.tiles.size + 2) / 3
    val bands = WidgetFit.rows(height, PAD + HEADER + lines * 18, 80, wanted)
    model.tiles.take(bands * 3).forEachIndexed { index, tile ->
      val item = RemoteViews(context.packageName, R.layout.hbots_w_tile)
      face(item, tile.line.face)
      item.setTextViewText(R.id.hbots_name, tile.line.name)
      item.setTextViewText(R.id.hbots_sub, tile.status)
      item.setTextColor(R.id.hbots_sub, tone(tile.line.tone))
      item.setContentDescription(R.id.hbots_item, tile.line.description)
      item.setOnClickPendingIntent(R.id.hbots_item, openLink(context, tile.line.link))
      views.addView(if (index < 3) R.id.hbots_tiles1 else R.id.hbots_tiles2, item)
    }
    line(views, R.id.hbots_laptop, "Laptop", model.laptop)
    line(views, R.id.hbots_gaming, "Gaming PC", model.gaming)
    line(views, R.id.hbots_usage, "Usage", model.usage)
    if (model.usageHot) views.setTextColor(R.id.hbots_usage, AMBER)
    return views
  }

  private fun ask(context: Context, model: QuickAskState.Ready): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget_ask)
    views.setTextViewText(R.id.hbots_ask, model.label)
    views.setContentDescription(R.id.hbots_ask, "New chat")
    views.setOnClickPendingIntent(R.id.hbots_ask, openLink(context, model.askLink))
    views.setOnClickPendingIntent(R.id.hbots_root, openLink(context, model.askLink))
    views.setOnClickPendingIntent(R.id.hbots_photo, openLink(context, model.photoLink))
    views.setOnClickPendingIntent(R.id.hbots_voice, openLink(context, model.voiceLink))
    return views
  }

  private fun usage(context: Context, model: UsageState.Data): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget_usage)
    header(context, views, model.title, "", model.asOf)
    views.setTextViewText(R.id.hbots_big, model.big)
    if (model.hot) views.setTextColor(R.id.hbots_big, AMBER)
    views.setTextViewText(R.id.hbots_big_label, model.bigLabel)
    views.addView(R.id.hbots_gauges, gauge(context, WidgetGauge("", "", model.bigPct, model.hot)))
    model.week?.let { views.addView(R.id.hbots_gauges, gauge(context, it)) }
    line(views, R.id.hbots_resets, "", model.resets)
    views.setContentDescription(R.id.hbots_root, model.description)
    return views
  }

  private fun bot(context: Context, model: OneBotState.Data): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget_bot)
    face(views, model.line.face)
    views.setTextViewText(R.id.hbots_name, model.line.name)
    views.setTextViewText(R.id.hbots_sub, model.line.sub)
    views.setTextViewText(R.id.hbots_status, model.status)
    views.setTextColor(R.id.hbots_status, tone(model.line.tone))
    views.setImageViewResource(R.id.hbots_dot, dot(model.line.tone))
    line(views, R.id.hbots_side, "", model.asOf)
    views.setContentDescription(R.id.hbots_root, model.line.description)
    views.setOnClickPendingIntent(R.id.hbots_root, openLink(context, model.line.link))
    return views
  }

  private fun machines(context: Context, model: MachinesState.Data): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget_machines)
    for (panel in listOf(model.laptop, model.gaming)) {
      val item = RemoteViews(context.packageName, R.layout.hbots_w_panel)
      item.setTextViewText(R.id.hbots_name, panel.title)
      item.setTextViewText(R.id.hbots_sub, panel.sub)
      for (gauge in panel.gauges) item.addView(R.id.hbots_gauges, gauge(context, gauge))
      val spoken = listOf(panel.title, panel.sub).plus(panel.gauges.map { "${it.label} ${it.value}" })
      item.setContentDescription(R.id.hbots_item, spoken.filter { it.isNotEmpty() }.joinToString(", "))
      views.addView(R.id.hbots_panels, item)
    }
    line(views, R.id.hbots_side, "", model.asOf)
    views.setOnClickPendingIntent(R.id.hbots_root, openApp(context))
    return views
  }

  private fun today(context: Context, model: TodayState.Data, height: Int): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_widget_today)
    header(context, views, TodayModel.TITLE, model.side, model.asOf)
    val reserved = PAD + HEADER + (if (model.nextTitle.isEmpty()) 0 else 20)
    val rows = model.rows.take(WidgetFit.rows(height, reserved, 24, model.rows.size))
    for (row in rows) views.addView(R.id.hbots_rows, event(context, row.title, row.meta, if (row.failed) R.drawable.hbots_dot_failed else R.drawable.hbots_dot_working))
    if (rows.isEmpty()) views.addView(R.id.hbots_rows, event(context, TodayModel.NOTHING_YET, "", R.drawable.hbots_dot_idle))
    line(views, R.id.hbots_next, "Next", listOf(model.nextTitle, model.nextMeta).filter { it.isNotEmpty() }.joinToString(" · "))
    return views
  }

  private fun header(context: Context, views: RemoteViews, title: String, side: String, asOf: String) {
    views.setTextViewText(R.id.hbots_title, title)
    views.setTextViewText(R.id.hbots_side, listOf(side, asOf).filter { it.isNotEmpty() }.joinToString(" · "))
    views.setOnClickPendingIntent(R.id.hbots_root, openApp(context))
  }

  /** A line that is hidden when it has nothing to say. */
  private fun line(views: RemoteViews, id: Int, label: String, text: String) {
    if (text.isEmpty()) return
    views.setViewVisibility(id, View.VISIBLE)
    views.setTextViewText(id, if (label.isEmpty()) text else "$label  $text")
  }

  private fun row(context: Context, line: BotLine): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_w_row)
    face(views, line.face)
    views.setTextViewText(R.id.hbots_name, line.name)
    views.setTextViewText(R.id.hbots_sub, line.sub)
    views.setTextViewText(R.id.hbots_time, line.time)
    views.setImageViewResource(R.id.hbots_dot, dot(line.tone))
    views.setContentDescription(R.id.hbots_item, line.description)
    views.setOnClickPendingIntent(R.id.hbots_item, openLink(context, line.link))
    return views
  }

  private fun event(context: Context, title: String, meta: String, dot: Int): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hbots_w_event)
    views.setTextViewText(R.id.hbots_name, title)
    views.setTextViewText(R.id.hbots_sub, meta)
    views.setImageViewResource(R.id.hbots_dot, dot)
    return views
  }

  private fun gauge(context: Context, gauge: WidgetGauge): RemoteViews {
    val views = RemoteViews(context.packageName, if (gauge.hot) R.layout.hbots_w_gauge_hot else R.layout.hbots_w_gauge)
    if (gauge.label.isEmpty()) {
      views.setViewVisibility(R.id.hbots_label, View.GONE)
      views.setViewVisibility(R.id.hbots_value, View.GONE)
    }
    views.setTextViewText(R.id.hbots_label, gauge.label)
    views.setTextViewText(R.id.hbots_value, gauge.value)
    views.setProgressBar(R.id.hbots_bar, 100, gauge.pct, false)
    return views
  }

  private fun button(context: Context, layout: Int, label: String, spoken: String, link: String): RemoteViews {
    val views = RemoteViews(context.packageName, layout)
    views.setTextViewText(R.id.hbots_item, label)
    views.setContentDescription(R.id.hbots_item, spoken)
    views.setOnClickPendingIntent(R.id.hbots_item, openLink(context, link))
    return views
  }

  private fun face(views: RemoteViews, face: WidgetFace) {
    views.setInt(R.id.hbots_face_bg, "setColorFilter", face.color)
    views.setTextViewText(R.id.hbots_face_text, face.initial)
  }

  private fun dot(tone: BotTone): Int = when (tone) {
    BotTone.WORKING -> R.drawable.hbots_dot_working
    BotTone.WAITING -> R.drawable.hbots_dot_waiting
    BotTone.IDLE -> R.drawable.hbots_dot_idle
  }

  private fun tone(tone: BotTone): Int = when (tone) {
    BotTone.WORKING -> GREEN
    BotTone.WAITING -> AMBER
    BotTone.IDLE -> MUTED
  }

  private fun openApp(context: Context): PendingIntent {
    val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  /** The link goes to the app's own activity, so the app lock decides who sees the chat. */
  private fun openLink(context: Context, link: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(context, link.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }
}
