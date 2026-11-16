package expo.modules.hbotsshare

/**
 * The photos picked so far in the plus sheet, in tap order. Pure and generic so a JVM test can
 * drive it with strings. A grant only adds. `take` hands the whole selection over once, so Add
 * pressed twice, or Add followed by the picker's own completion, copies the photos once.
 */
class PhotoSelection<T> {
  private val items = LinkedHashSet<T>()
  private var taken = false

  val count: Int
    get() = items.size

  fun grant(added: List<T>) {
    if (!taken) items.addAll(added)
  }

  fun revoke(removed: List<T>) {
    if (!taken) items.removeAll(removed.toSet())
  }

  /** The selected items in tap order the first time there are any, then null. */
  fun take(): List<T>? {
    if (taken || items.isEmpty()) return null
    taken = true
    return items.toList()
  }
}
