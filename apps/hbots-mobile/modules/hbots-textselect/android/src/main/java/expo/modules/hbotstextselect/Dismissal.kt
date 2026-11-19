package expo.modules.hbotstextselect

internal enum class Cause { Touch, Item, Cleared }

/**
 * Tells a selection the system dismissed from one the user ended. A key Back closes the toolbar, which
 * collapses the selection, and the same Back reaches the sheet a few milliseconds later, so that Back
 * already counts as the one that cleared it. A gesture Back is consumed by the toolbar and never reaches
 * the sheet, so a dismissal the sheet does not hear about within `WINDOW_MS` is dropped.
 * Copy, a tap and our own clear also collapse the selection, and the Back after them must still close the sheet.
 */
internal class Dismissal {
  private var cause: Cause? = null
  private var active = false
  private var dismissedAt: Long? = null

  /** Marks what is about to change the selection, or null once it has. */
  fun during(next: Cause?) {
    cause = next
    if (next == Cause.Touch || next == Cause.Item) dismissedAt = null
  }

  fun selectionChanged(hasSelection: Boolean, now: Long) {
    if (hasSelection) dismissedAt = null else if (active && cause == null) dismissedAt = now
    active = hasSelection
  }

  fun consume(now: Long): Boolean {
    val at = dismissedAt ?: return false
    dismissedAt = null
    return now - at < WINDOW_MS
  }

  companion object {
    const val WINDOW_MS = 500L
  }
}
