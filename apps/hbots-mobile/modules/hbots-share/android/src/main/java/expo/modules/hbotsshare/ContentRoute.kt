package expo.modules.hbotsshare

/** Which pieces of an input method's content the composer takes (X6). */
internal object ContentRoute {
  /** The types declared to the keyboard, so Gboard offers its images and stickers. */
  val ACCEPTED_TYPES: Array<String> = arrayOf("image/*")

  /**
   * An item with a uri is a stream to copy into the intake dir. An item with only text goes
   * back to the field untouched, so a text paste still works.
   */
  fun takesItem(hasUri: Boolean): Boolean = hasUri

  /** The mime handed to the copy when the provider does not name one. */
  fun mimeHint(descriptionMime: String?): String =
    descriptionMime?.takeIf { it.isNotBlank() } ?: "image/*"
}
