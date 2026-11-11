package expo.modules.hbotsnotify

/**
 * A notification reply is for a short line. Longer text is not sent from here: the notification opens the
 * chat with the text already in the composer, so nothing the owner typed is lost or cut.
 */
object ReplyLimit {
  const val MAX_SEND = 4000

  /** What fits in a link. Past it the chat opens without the text, and the notice says so. */
  const val MAX_DRAFT = 16_000

  const val TOO_LONG_WITH_DRAFT = "Too long to send here. Tap to finish in the chat."
  const val TOO_LONG_NO_DRAFT = "Too long to send here. Open the chat."

  fun tooLong(text: String): Boolean = text.length > MAX_SEND

  /** The chat link with the text as a draft, or null when there is no chat link or the text is too big for one. */
  fun draftLink(chatLink: String?, text: String): String? {
    if (chatLink == null || text.length > MAX_DRAFT) return null
    val separator = if (chatLink.contains('?')) '&' else '?'
    return "$chatLink${separator}draft=${PathSegment.encode(text)}"
  }
}
