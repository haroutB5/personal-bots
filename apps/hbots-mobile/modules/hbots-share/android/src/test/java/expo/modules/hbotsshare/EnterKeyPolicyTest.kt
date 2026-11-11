package expo.modules.hbotsshare

import android.view.KeyEvent
import expo.modules.hbotsshare.EnterKeyPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EnterKeyPolicyTest {
  private val enter = KeyEvent.KEYCODE_ENTER
  private val soft = KeyEvent.FLAG_SOFT_KEYBOARD

  @Test fun hardwareEnterSends() {
    assertEquals(Decision.SEND, EnterKeyPolicy.decide(enter, 0, 0))
  }

  @Test fun hardwareNumpadEnterSends() {
    assertEquals(Decision.SEND, EnterKeyPolicy.decide(KeyEvent.KEYCODE_NUMPAD_ENTER, 0, 0))
  }

  @Test fun shiftEnterIsALineBreak() {
    assertEquals(Decision.LINE_BREAK, EnterKeyPolicy.decide(enter, 0, KeyEvent.META_SHIFT_ON))
  }

  @Test fun theSoftKeyboardEnterIsNeverIntercepted() {
    assertEquals(Decision.PASS_THROUGH, EnterKeyPolicy.decide(enter, soft, 0))
  }

  @Test fun theSoftKeyboardShiftEnterIsNeverIntercepted() {
    assertEquals(Decision.PASS_THROUGH, EnterKeyPolicy.decide(enter, soft, KeyEvent.META_SHIFT_ON))
  }

  @Test fun otherKeysPassThrough() {
    assertEquals(Decision.PASS_THROUGH, EnterKeyPolicy.decide(KeyEvent.KEYCODE_A, 0, 0))
    assertEquals(Decision.PASS_THROUGH, EnterKeyPolicy.decide(KeyEvent.KEYCODE_DEL, 0, 0))
    assertEquals(Decision.PASS_THROUGH, EnterKeyPolicy.decide(KeyEvent.KEYCODE_TAB, 0, 0))
  }

  @Test fun controlAltAndMetaEnterAreLeftToTheSystem() {
    assertEquals(Decision.PASS_THROUGH, EnterKeyPolicy.decide(enter, 0, KeyEvent.META_CTRL_ON))
    assertEquals(Decision.PASS_THROUGH, EnterKeyPolicy.decide(enter, 0, KeyEvent.META_ALT_ON))
    assertEquals(Decision.PASS_THROUGH, EnterKeyPolicy.decide(enter, 0, KeyEvent.META_META_ON))
  }

  @Test fun onlyTheFirstKeyDownSends() {
    assertTrue(EnterKeyPolicy.sendsNow(Decision.SEND, KeyEvent.ACTION_DOWN, 0))
    assertFalse(EnterKeyPolicy.sendsNow(Decision.SEND, KeyEvent.ACTION_DOWN, 3))
    assertFalse(EnterKeyPolicy.sendsNow(Decision.SEND, KeyEvent.ACTION_UP, 0))
  }

  @Test fun neverSendsForALineBreakOrPassThrough() {
    assertFalse(EnterKeyPolicy.sendsNow(Decision.LINE_BREAK, KeyEvent.ACTION_DOWN, 0))
    assertFalse(EnterKeyPolicy.sendsNow(Decision.PASS_THROUGH, KeyEvent.ACTION_DOWN, 0))
  }

  @Test fun onlyASendIsSwallowed() {
    assertTrue(EnterKeyPolicy.swallows(Decision.SEND))
    assertFalse(EnterKeyPolicy.swallows(Decision.LINE_BREAK))
    assertFalse(EnterKeyPolicy.swallows(Decision.PASS_THROUGH))
  }
}
