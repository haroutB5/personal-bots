package expo.modules.hbotslauncher

/** A bot the owner pinned, as JS reports it. Id and name only. */
data class PinnedBot(val botId: String, val name: String)

/** One launcher shortcut, as data. The Android layer turns it into a `ShortcutInfoCompat`. */
data class ShortcutSpec(
  val id: String,
  val shortLabel: String,
  val longLabel: String,
  val link: String,
  val rank: Int,
)

/**
 * Which dynamic shortcuts the launcher gets. The R3 static shortcut ("New CTO chat", id
 * [STATIC_CTO_ID]) lives in the manifest and is never touched by `setDynamicShortcuts`, so the two
 * cannot collide: dynamic ids all start with [ID_PREFIX]. Launchers show about four shortcuts, static
 * first, so with the CTO one the first three dynamic ones are the visible ones; the fourth is kept
 * for launchers that show more and for the long list. JS leaves the CTO bot out of the feed, since the
 * static shortcut already opens a new chat with it.
 */
object ShortcutPlanner {
  const val MAX_DYNAMIC = 4
  const val STATIC_CTO_ID = "new_cto_chat"
  const val ID_PREFIX = "bot_"
  private const val MAX_SHORT = 12
  private const val MAX_LONG = 40
  private const val MAX_ID = 128

  /** Reads what the JS module passes. A bad row is dropped, never guessed at. */
  fun parse(raw: List<Map<String, Any?>>): List<PinnedBot> {
    val seen = LinkedHashMap<String, PinnedBot>()
    for (entry in raw) {
      val id = (entry["botId"] as? String)?.trim().orEmpty()
      if (id.isEmpty() || id.length > MAX_ID || id in seen) continue
      val name = clean(entry["name"] as? String)
      seen[id] = PinnedBot(id, name.ifEmpty { "hbots" })
    }
    return seen.values.toList()
  }

  /** At most [limit] shortcuts, in the order JS gave the pins. Fewer when the launcher allows fewer. */
  fun plan(bots: List<PinnedBot>, limit: Int = MAX_DYNAMIC): List<ShortcutSpec> =
    bots.take(limit.coerceIn(0, MAX_DYNAMIC)).mapIndexed { index, bot ->
      ShortcutSpec(
        id = ID_PREFIX + bot.botId,
        shortLabel = bot.name.take(MAX_SHORT),
        longLabel = "New chat with ${bot.name}".take(MAX_LONG),
        link = newChatLink(bot.botId),
        rank = index,
      )
    }

  /** The same link the Quick Settings tile and the static shortcut use. */
  fun newChatLink(botId: String): String = "hbots://bot/${encode(botId)}?new=1"

  /** Keeps `A-Z a-z 0-9 . _ ~ -`, escapes the rest, like `encodeURIComponent` for ids. */
  fun encode(id: String): String {
    val out = StringBuilder()
    for (byte in id.toByteArray(Charsets.UTF_8)) {
      val c = byte.toInt() and 0xFF
      val plain = c in 0x30..0x39 || c in 0x41..0x5A || c in 0x61..0x7A || c == 0x2D || c == 0x2E || c == 0x5F || c == 0x7E
      if (plain) out.append(c.toChar()) else out.append('%').append("%02X".format(c))
    }
    return out.toString()
  }

  private fun clean(text: String?): String =
    text.orEmpty().map { if (it.isISOControl()) ' ' else it }.joinToString("").trim().replace(Regex("\\s+"), " ").take(MAX_LONG)
}
