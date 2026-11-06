package expo.modules.hbotsliveview

/**
 * The JSON the phone sends on the live-view socket. The Kotlin module owns the
 * socket and the frames; every message here is produced by JavaScript input,
 * exactly as the web client produces it.
 */
object LiveMessages {
  fun jsonString(value: String): String {
    val out = StringBuilder(value.length + 2)
    out.append('"')
    for (char in value) {
      when (char) {
        '"' -> out.append("\\\"")
        '\\' -> out.append("\\\\")
        '\n' -> out.append("\\n")
        '\r' -> out.append("\\r")
        '\t' -> out.append("\\t")
        '\b' -> out.append("\\b")
        '\u000C' -> out.append("\\f")
        else -> {
          if (char < ' ') {
            out.append("\\u")
            out.append(char.code.toString(16).padStart(4, '0'))
          } else {
            out.append(char)
          }
        }
      }
    }
    out.append('"')
    return out.toString()
  }

  fun number(value: Float): String =
    if (value.isFinite()) value.toString() else "0"

  fun browserPointer(action: String, x: Float, y: Float): String =
    """{"_tag":"Pointer","action":${jsonString(action)},"x":${number(x)},"y":${number(y)}}"""

  fun browserWheel(x: Float, y: Float, deltaX: Float, deltaY: Float): String =
    """{"_tag":"Wheel","x":${number(x)},"y":${number(y)},"deltaX":${number(deltaX)},"deltaY":${number(deltaY)}}"""

  fun browserKey(key: String, modifiers: List<String>): String {
    val list =
      if (modifiers.isEmpty()) ""
      else ""","modifiers":[${modifiers.joinToString(",") { jsonString(it) }}]"""
    return """{"_tag":"Key","key":${jsonString(key)}$list}"""
  }

  fun browserText(text: String): String = """{"_tag":"InsertText","text":${jsonString(text)}}"""

  fun browserNavigate(url: String): String = """{"_tag":"Navigate","url":${jsonString(url)}}"""

  fun browserViewport(width: Int, height: Int): String =
    """{"_tag":"Viewport","width":$width,"height":$height}"""

  fun browserAnswerDialog(accept: Boolean, promptText: String?): String {
    val prompt = if (promptText == null) "" else ""","promptText":${jsonString(promptText)}"""
    return """{"_tag":"AnswerDialog","accept":$accept$prompt}"""
  }

  fun browserScrollEnd(): String = """{"_tag":"ScrollEnd"}"""

  fun browserBack(): String = """{"_tag":"Back"}"""

  fun browserForward(): String = """{"_tag":"Forward"}"""

  fun browserReload(): String = """{"_tag":"Reload"}"""

  fun browserFrameAck(): String = """{"_tag":"FrameAck"}"""

  fun desktopAck(): String = """{"_tag":"Ack"}"""

  fun desktopViewport(width: Int, height: Int): String =
    """{"_tag":"Viewport","width":$width,"height":$height}"""
}
