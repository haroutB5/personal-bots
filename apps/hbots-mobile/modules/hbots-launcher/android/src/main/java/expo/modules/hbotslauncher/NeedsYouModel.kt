package expo.modules.hbotslauncher

import java.time.ZoneId

data class WidgetChoice(val label: String, val link: String)

data class QuestionCard(
  /** "Poteto · Hbots · 14:42" */
  val meta: String,
  val text: String,
  val choices: List<WidgetChoice>,
  val openLink: String,
  val description: String,
)

sealed interface NeedsYouState {
  data object SignedOut : NeedsYouState
  data class Data(
    val headline: String,
    val side: String,
    val asOf: String,
    val question: QuestionCard?,
    val rows: List<BotLine>,
    val askLink: String,
    val voiceLink: String,
    val photoLink: String,
  ) : NeedsYouState
}

/**
 * Widget 2, Needs you first: the one question waiting for the owner on top, then who is working,
 * then three ways into a new chat. An answer button never sends by itself: it opens the chat with
 * the choice in the composer, through the same link door as every other link, so the app lock
 * applies and the owner presses send.
 */
object NeedsYouModel {
  const val MAX_ROWS = 2
  const val MAX_ROWS_NO_QUESTION = 4
  const val NOTHING = "Nothing waiting for you"
  const val NO_TEXT = "Needs your answer"

  fun build(feed: WidgetFeed?, now: Long, zone: ZoneId = ZoneId.systemDefault()): NeedsYouState {
    if (feed == null) return NeedsYouState.SignedOut
    val lines = WidgetCommon.lines(feed, now)
    val waiting = maxOf(lines.count { it.tone == BotTone.WAITING }, if (feed.question == null) 0 else 1)
    val working = lines.count { it.tone == BotTone.WORKING }
    val card = feed.question?.let { question ->
      val meta = listOf(question.botName, question.chatTitle, if (question.atMs > 0) WidgetCommon.dayClock(question.atMs, now, zone) else "")
        .filter { it.isNotEmpty() }.joinToString(" · ")
      val text = question.text.ifEmpty { NO_TEXT }
      QuestionCard(
        meta = meta,
        text = text,
        choices = question.choices.map { WidgetChoice(it, WidgetCommon.choiceLink(question.link, it)) },
        openLink = question.link,
        description = "${question.botName} asks: $text",
      )
    }
    val busy = lines.filter { it.tone == BotTone.WORKING }
    return NeedsYouState.Data(
      headline = if (waiting > 0) "$waiting waiting for you" else NOTHING,
      side = if (working > 0) "$working working" else "",
      asOf = WidgetCommon.asOf(feed, now, zone),
      question = card,
      rows = busy.take(if (card == null) MAX_ROWS_NO_QUESTION else MAX_ROWS),
      askLink = WidgetCommon.newChatLink("keyboard"),
      voiceLink = WidgetCommon.newChatLink("voice"),
      photoLink = WidgetCommon.newChatLink("photo"),
    )
  }
}
