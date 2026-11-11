package expo.modules.hbotsnotify

/** How the working notification fills its expanded body. */
sealed interface WorkingBody {
  /** The N3 look: one inbox line per bot. Not eligible for promotion. */
  data class Inbox(val lines: List<String>, val summary: String?) : WorkingBody

  /** One text block. Android only promotes standard, big text, call and progress styles. */
  data class BigText(val text: String) : WorkingBody
}

/** What the working notification asks of the system for one post. */
data class WorkingPresentation(val promote: Boolean, val body: WorkingBody)

/** Android 16 Live Update: the ongoing "bots working" notice can be promoted to a status bar chip. */
object LiveUpdate {
  const val MIN_SDK = 36

  /**
   * Promotion needs API 36 and a user who has not turned Live Updates off for the app.
   * Every other case keeps the N3 inbox notification exactly as it was.
   */
  fun presentation(plan: WorkingPlan, sdkInt: Int, canPostPromoted: Boolean): WorkingPresentation =
    if (sdkInt >= MIN_SDK && canPostPromoted) {
      WorkingPresentation(promote = true, body = WorkingBody.BigText(bigText(plan)))
    } else {
      WorkingPresentation(promote = false, body = WorkingBody.Inbox(plan.lines, plan.summary))
    }

  fun bigText(plan: WorkingPlan): String = (plan.lines + listOfNotNull(plan.summary)).joinToString("\n")
}
