package expo.modules.hbotsshare

import android.view.KeyEvent

/**
 * What the composer does with an Enter key (X6). A hardware keyboard's Enter sends and
 * Shift Enter is a line break. The soft keyboard keeps today's behaviour: its Enter is a
 * line break in the field and is never intercepted. An input method marks the events it
 * sends with FLAG_SOFT_KEYBOARD, so that flag tells the two apart.
 */
internal object EnterKeyPolicy {
  enum class Decision {
    /** Swallow the key and send the message. */
    SEND,

    /** Let the field insert the line break. */
    LINE_BREAK,

    /** Not ours: the key goes on to the field untouched. */
    PASS_THROUGH,
  }

  fun decide(keyCode: Int, flags: Int, metaState: Int): Decision {
    if (keyCode != KeyEvent.KEYCODE_ENTER && keyCode != KeyEvent.KEYCODE_NUMPAD_ENTER) {
      return Decision.PASS_THROUGH
    }
    if (flags and KeyEvent.FLAG_SOFT_KEYBOARD != 0) return Decision.PASS_THROUGH
    val shift = metaState and KeyEvent.META_SHIFT_ON != 0
    val others = metaState and (KeyEvent.META_ALT_ON or KeyEvent.META_CTRL_ON or KeyEvent.META_META_ON) != 0
    return when {
      others -> Decision.PASS_THROUGH
      shift -> Decision.LINE_BREAK
      else -> Decision.SEND
    }
  }

  /** Only a fresh key down sends. A held key and the key up are swallowed without a second send. */
  fun sendsNow(decision: Decision, action: Int, repeatCount: Int): Boolean =
    decision == Decision.SEND && action == KeyEvent.ACTION_DOWN && repeatCount == 0

  fun swallows(decision: Decision): Boolean = decision == Decision.SEND
}
