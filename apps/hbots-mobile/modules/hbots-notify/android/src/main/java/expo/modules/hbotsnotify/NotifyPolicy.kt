package expo.modules.hbotsnotify

import org.json.JSONArray
import org.json.JSONObject

data class BotInfo(val name: String, val hidePreviews: Boolean)

/**
 * What the JS side tells native about the phone: whether the app lock is on and which bots exist.
 * The push carries ids only, so the bot's name and its hide-previews choice come from here.
 * Until JS has synced once, the policy fails closed: lock on and no known bots.
 */
data class NotifyPolicy(val appLockOn: Boolean, val bots: Map<String, BotInfo>) {
  companion object {
    val FAIL_CLOSED = NotifyPolicy(appLockOn = true, bots = emptyMap())
  }
}

object PolicyCodec {
  private const val MAX_BOTS = 500
  private const val MAX_NAME = 80

  fun encode(policy: NotifyPolicy): String {
    val bots = JSONArray()
    for ((id, info) in policy.bots) {
      bots.put(JSONObject().put("id", id).put("name", info.name).put("hidePreviews", info.hidePreviews))
    }
    return JSONObject().put("appLockOn", policy.appLockOn).put("bots", bots).toString()
  }

  /** A missing or damaged record is the fail-closed policy, never an open one. */
  fun decode(raw: String?): NotifyPolicy {
    if (raw.isNullOrBlank()) return NotifyPolicy.FAIL_CLOSED
    return runCatching {
      val json = JSONObject(raw)
      if (!json.has("appLockOn")) return NotifyPolicy.FAIL_CLOSED
      NotifyPolicy(json.getBoolean("appLockOn"), readBots(json.optJSONArray("bots")))
    }.getOrDefault(NotifyPolicy.FAIL_CLOSED)
  }

  /** Reads what the JS module passes: a boolean and a list of maps. */
  fun fromJs(appLockOn: Boolean, bots: List<Map<String, Any?>>): NotifyPolicy {
    val known = LinkedHashMap<String, BotInfo>()
    for (entry in bots.take(MAX_BOTS)) {
      val id = entry["id"] as? String ?: continue
      if (id.isBlank()) continue
      val name = (entry["name"] as? String)?.trim().orEmpty().take(MAX_NAME)
      // A bot with no usable name hides previews: the safe reading of a half-synced record.
      val hide = entry["hidePreviews"] as? Boolean ?: true
      known[id] = BotInfo(name.ifEmpty { "hbots" }, hide)
    }
    return NotifyPolicy(appLockOn, known)
  }

  private fun readBots(array: JSONArray?): Map<String, BotInfo> {
    array ?: return emptyMap()
    val bots = LinkedHashMap<String, BotInfo>()
    for (index in 0 until minOf(array.length(), MAX_BOTS)) {
      val item = array.optJSONObject(index) ?: continue
      val id = item.optString("id")
      if (id.isBlank()) continue
      bots[id] = BotInfo(item.optString("name").ifBlank { "hbots" }, item.optBoolean("hidePreviews", true))
    }
    return bots
  }
}
