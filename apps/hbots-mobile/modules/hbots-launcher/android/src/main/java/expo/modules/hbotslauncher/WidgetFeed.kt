package expo.modules.hbotslauncher

import org.json.JSONArray
import org.json.JSONObject

/**
 * One bot on a widget. The owner chose to show what a bot is doing on the home screen, so `activity`
 * is text; it is one cleaned line of at most [WidgetFeedCodec.MAX_ACTIVITY] characters, and JS leaves
 * it out for a bot whose previews are hidden.
 */
data class WidgetBot(
  val botId: String,
  val name: String,
  val working: Boolean,
  val waiting: Boolean = false,
  val activity: String = "",
  val sinceMs: Long = 0L,
  val unread: Int = 0,
  /** `#rrggbb`, or empty. */
  val color: String = "",
)

data class WidgetUsage(val title: String, val sessionPct: Int?, val weekPct: Int?, val resets: String)

data class WidgetMachine(
  val cpuPct: Int?,
  val memUsedGB: Int?,
  val memTotalGB: Int?,
  val tempC: Int? = null,
  val diskFreeGB: Int? = null,
  val gpuPct: Int? = null,
  val users: List<String> = emptyList(),
)

data class WidgetEvent(val failed: Boolean, val title: String, val bot: String, val atMs: Long)

data class WidgetToday(
  val done: Int,
  val failed: Int,
  val running: Int,
  val events: List<WidgetEvent>,
  val nextTitle: String = "",
  val nextAtMs: Long = 0L,
)

data class WidgetQuestion(
  val botId: String,
  val botName: String,
  val chatTitle: String,
  val text: String,
  val choices: List<String>,
  /** `hbots://chat/<bot>/<thread>`; anything else is refused at the door. */
  val link: String,
  val atMs: Long = 0L,
)

/** What JS last told the widgets, and when. `updatedAt` is native's clock, never JS's. */
data class WidgetFeed(
  val bots: List<WidgetBot>,
  val updatedAt: Long,
  val usage: WidgetUsage? = null,
  val laptop: WidgetMachine? = null,
  val gamingPc: WidgetMachine? = null,
  val today: WidgetToday? = null,
  val question: WidgetQuestion? = null,
)

/**
 * Reads the feed tolerantly: a missing or damaged part is left out, never guessed at, and every
 * string is cleaned (no control characters, single spaces) and cut to its cap whatever JS sent.
 * The same reader takes what JS passes and what is stored, so nothing uncapped can sit in storage.
 */
object WidgetFeedCodec {
  const val MAX_BOTS = 8
  const val MAX_ACTIVITY = 60
  const val MAX_QUESTION = 120
  const val MAX_CHOICES = 3
  const val MAX_CHOICE = 40
  const val MAX_EVENTS = 3
  const val MAX_TITLE = 60
  const val MAX_USERS = 3
  private const val MAX_NAME = 40
  private const val MAX_SHORT = 24
  private const val MAX_ID = 128
  private const val MAX_LINK = 300
  private const val VERSION = 2
  private val COLOR = Regex("^#[0-9A-Fa-f]{6}$")
  private val CHAT_LINK = Regex("^hbots://chat/[A-Za-z0-9._~%-]+/[A-Za-z0-9._~%-]+$")

  /** The first widget's entry point: a list of `{botId, name, working}`. Any other key is ignored. */
  fun parse(raw: List<Map<String, Any?>>): List<WidgetBot> {
    val array = JSONArray()
    for (entry in raw) {
      array.put(JSONObject().put("botId", entry["botId"] as? String).put("name", entry["name"] as? String).put("working", entry["working"] == true))
    }
    return bots(array)
  }

  /** The feed as JS sends it (one JSON string). Null when it is not a feed at all. */
  fun fromJs(raw: String?, now: Long): WidgetFeed? = decode(raw)?.copy(updatedAt = now)

  fun encode(feed: WidgetFeed): String {
    val json = JSONObject().put("v", VERSION).put("updatedAt", feed.updatedAt)
    val bots = JSONArray()
    for (bot in feed.bots) {
      val item = JSONObject().put("botId", bot.botId).put("name", bot.name).put("working", bot.working)
      if (bot.waiting) item.put("waiting", true)
      if (bot.activity.isNotEmpty()) item.put("activity", bot.activity)
      if (bot.sinceMs > 0) item.put("sinceMs", bot.sinceMs)
      if (bot.unread > 0) item.put("unread", bot.unread)
      if (bot.color.isNotEmpty()) item.put("color", bot.color)
      bots.put(item)
    }
    json.put("bots", bots)
    feed.usage?.let {
      json.put("usage", JSONObject().put("title", it.title).putOpt("sessionPct", it.sessionPct).putOpt("weekPct", it.weekPct).put("resets", it.resets))
    }
    feed.laptop?.let { json.put("laptop", machine(it)) }
    feed.gamingPc?.let { json.put("gamingPc", machine(it)) }
    feed.today?.let { today ->
      val events = JSONArray()
      for (event in today.events) {
        events.put(JSONObject().put("kind", if (event.failed) "failed" else "done").put("title", event.title).put("bot", event.bot).put("atMs", event.atMs))
      }
      val item = JSONObject().put("done", today.done).put("failed", today.failed).put("running", today.running).put("events", events)
      if (today.nextAtMs > 0) item.put("next", JSONObject().put("title", today.nextTitle).put("atMs", today.nextAtMs))
      json.put("today", item)
    }
    feed.question?.let {
      json.put(
        "question",
        JSONObject().put("botId", it.botId).put("botName", it.botName).put("chatTitle", it.chatTitle).put("text", it.text)
          .put("choices", JSONArray(it.choices)).put("link", it.link).put("atMs", it.atMs),
      )
    }
    return json.toString()
  }

  /** A missing or damaged record is no feed at all, which every widget shows as signed out. */
  fun decode(raw: String?): WidgetFeed? {
    if (raw.isNullOrBlank()) return null
    return runCatching {
      val json = JSONObject(raw)
      val version = json.optInt("v")
      if (version != 1 && version != VERSION) return null
      val array = json.optJSONArray("bots") ?: return null
      WidgetFeed(
        bots = bots(array),
        updatedAt = json.optLong("updatedAt", 0L),
        usage = json.optJSONObject("usage")?.let(::usage),
        laptop = json.optJSONObject("laptop")?.let(::machine),
        gamingPc = json.optJSONObject("gamingPc")?.let(::machine),
        today = json.optJSONObject("today")?.let(::today),
        question = json.optJSONObject("question")?.let(::question),
      )
    }.getOrNull()
  }

  private fun bots(array: JSONArray): List<WidgetBot> {
    val seen = LinkedHashMap<String, WidgetBot>()
    for (index in 0 until array.length()) {
      if (seen.size >= MAX_BOTS) break
      val item = array.optJSONObject(index) ?: continue
      val id = text(item, "botId").trim()
      if (id.isEmpty() || id.length > MAX_ID || id in seen) continue
      val working = item.opt("working") == true
      seen[id] = WidgetBot(
        botId = id,
        name = clean(text(item, "name"), MAX_NAME).ifEmpty { "hbots" },
        working = working,
        waiting = !working && item.opt("waiting") == true,
        activity = clean(text(item, "activity"), MAX_ACTIVITY),
        sinceMs = long(item, "sinceMs"),
        unread = (int(item, "unread") ?: 0).coerceIn(0, 99),
        color = text(item, "color").takeIf { COLOR.matches(it) }.orEmpty(),
      )
    }
    return seen.values.toList()
  }

  private fun usage(item: JSONObject): WidgetUsage? {
    val session = pct(item, "sessionPct")
    val week = pct(item, "weekPct")
    if (session == null && week == null) return null
    return WidgetUsage(clean(text(item, "title"), MAX_SHORT), session, week, clean(text(item, "resets"), MAX_SHORT))
  }

  private fun machine(item: JSONObject): WidgetMachine {
    val users = item.optJSONArray("users")
    return WidgetMachine(
      cpuPct = pct(item, "cpuPct"),
      memUsedGB = int(item, "memUsedGB")?.coerceIn(0, 9999),
      memTotalGB = int(item, "memTotalGB")?.coerceIn(0, 9999),
      tempC = int(item, "tempC")?.coerceIn(-99, 199),
      diskFreeGB = int(item, "diskFreeGB")?.coerceIn(0, 99999),
      gpuPct = pct(item, "gpuPct"),
      users = strings(users, MAX_USERS, MAX_SHORT),
    )
  }

  private fun machine(machine: WidgetMachine): JSONObject =
    JSONObject().putOpt("cpuPct", machine.cpuPct).putOpt("memUsedGB", machine.memUsedGB).putOpt("memTotalGB", machine.memTotalGB)
      .putOpt("tempC", machine.tempC).putOpt("diskFreeGB", machine.diskFreeGB).putOpt("gpuPct", machine.gpuPct)
      .put("users", JSONArray(machine.users))

  private fun today(item: JSONObject): WidgetToday {
    val array = item.optJSONArray("events")
    val events = ArrayList<WidgetEvent>()
    for (index in 0 until (array?.length() ?: 0)) {
      if (events.size >= MAX_EVENTS) break
      val event = array?.optJSONObject(index) ?: continue
      val at = long(event, "atMs")
      if (at <= 0) continue
      events.add(WidgetEvent(text(event, "kind") == "failed", clean(text(event, "title"), MAX_TITLE), clean(text(event, "bot"), MAX_NAME), at))
    }
    val next = item.optJSONObject("next")
    val nextAt = next?.let { long(it, "atMs") } ?: 0L
    return WidgetToday(
      done = (int(item, "done") ?: 0).coerceIn(0, 999),
      failed = (int(item, "failed") ?: 0).coerceIn(0, 999),
      running = (int(item, "running") ?: 0).coerceIn(0, 999),
      events = events,
      nextTitle = if (nextAt > 0) clean(text(next, "title"), MAX_TITLE) else "",
      nextAtMs = nextAt,
    )
  }

  private fun question(item: JSONObject): WidgetQuestion? {
    val id = text(item, "botId").trim()
    val link = text(item, "link")
    if (id.isEmpty() || id.length > MAX_ID || link.length > MAX_LINK || !CHAT_LINK.matches(link)) return null
    return WidgetQuestion(
      botId = id,
      botName = clean(text(item, "botName"), MAX_NAME).ifEmpty { "hbots" },
      chatTitle = clean(text(item, "chatTitle"), MAX_NAME),
      text = clean(text(item, "text"), MAX_QUESTION),
      choices = strings(item.optJSONArray("choices"), MAX_CHOICES, MAX_CHOICE),
      link = link,
      atMs = long(item, "atMs"),
    )
  }

  private fun strings(array: JSONArray?, max: Int, cap: Int): List<String> {
    val out = ArrayList<String>()
    for (index in 0 until (array?.length() ?: 0)) {
      if (out.size >= max) break
      val value = clean(array?.opt(index) as? String, cap)
      if (value.isNotEmpty()) out.add(value)
    }
    return out
  }

  private fun text(item: JSONObject?, key: String): String = (item?.opt(key) as? String).orEmpty()

  private fun number(item: JSONObject, key: String): Double? =
    (item.opt(key) as? Number)?.toDouble()?.takeIf { !it.isNaN() && !it.isInfinite() }

  private fun int(item: JSONObject, key: String): Int? = number(item, key)?.let { Math.round(it).toInt() }

  private fun long(item: JSONObject, key: String): Long = number(item, key)?.toLong()?.coerceAtLeast(0L) ?: 0L

  private fun pct(item: JSONObject, key: String): Int? = int(item, key)?.coerceIn(0, 100)

  /** One line: control characters become spaces, runs of space collapse, then the cap. */
  fun clean(text: String?, max: Int): String =
    text.orEmpty().map { if (it.isISOControl()) ' ' else it }.joinToString("").trim().replace(Regex("\\s+"), " ").take(max).trim()
}
