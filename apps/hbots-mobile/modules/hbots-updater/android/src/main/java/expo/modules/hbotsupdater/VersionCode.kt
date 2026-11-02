package expo.modules.hbotsupdater

private val VERSION_PATTERN = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

fun versionCodeOf(version: String): Long? {
  val match = VERSION_PATTERN.matchEntire(version) ?: return null
  val major = match.groupValues[1].toLong()
  val minor = match.groupValues[2].toLong()
  val patch = match.groupValues[3].toLong()
  return major * 1_000_000 + minor * 1_000 + patch
}
