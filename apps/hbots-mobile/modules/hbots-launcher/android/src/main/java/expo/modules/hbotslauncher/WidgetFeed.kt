package expo.modules.hbotslauncher

import org.json.JSONArray
import org.json.JSONObject

/** One row of the widget feed. Three fields, by design: no message text, no preview, no thread. */
data class WidgetBot(val botId: String, val name: String, val working: Boolean)

/** What JS last told the widget, and when. `updatedAt` is native's clock, never JS's. */
data class WidgetFeed(val bots: List<WidgetBot>, val updatedAt: Long)

object WidgetFeedCodec {
  const val MAX_BOTS = 8
  private const val MAX_NAME = 40
  private const val MAX_ID = 128
  private const val VERSION = 1

  /** Reads what the JS module passes. Only `botId`, `name` and `working` are read; any other key is ignored. */
  fun parse(raw: List<Map<String, Any?>>): List<WidgetBot> {
    val seen = LinkedHashMap<String, WidgetBot>()
    for (entry in raw) {
      if (seen.size >= MAX_BOTS) break
      val id = (entry["botId"] as? String)?.trim().orEmpty()
      if (id.isEmpty() || id.length > MAX_ID || id in seen) continue
      val name = clean(entry["name"] as? String).ifEmpty { "hbots" }
      seen[id] = WidgetBot(id, name, entry["working"] == true)
    }
    return seen.values.toList()
  }

  fun encode(feed: WidgetFeed): String {
    val bots = JSONArray()
    for (bot in feed.bots) {
      bots.put(JSONObject().put("botId", bot.botId).put("name", bot.name).put("working", bot.working))
    }
    return JSONObject().put("v", VERSION).put("updatedAt", feed.updatedAt).put("bots", bots).toString()
  }

  /** A missing or damaged record is no feed at all, which the widget shows as signed out. */
  fun decode(raw: String?): WidgetFeed? {
    if (raw.isNullOrBlank()) return null
    return runCatching {
      val json = JSONObject(raw)
      if (json.optInt("v") != VERSION) return null
      val array = json.getJSONArray("bots")
      val bots = (0 until minOf(array.length(), MAX_BOTS)).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        val id = item.optString("botId")
        if (id.isBlank()) null else WidgetBot(id, item.optString("name").ifBlank { "hbots" }, item.optBoolean("working", false))
      }
      WidgetFeed(bots, json.optLong("updatedAt", 0L))
    }.getOrNull()
  }

  private fun clean(text: String?): String =
    text.orEmpty().map { if (it.isISOControl()) ' ' else it }.joinToString("").trim().replace(Regex("\\s+"), " ").take(MAX_NAME)
}
