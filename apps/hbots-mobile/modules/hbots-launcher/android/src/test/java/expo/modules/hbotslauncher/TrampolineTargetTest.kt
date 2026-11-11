package expo.modules.hbotslauncher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TrampolineTargetTest {
  @Test fun theAppsOwnLinksPassThrough() {
    assertEquals("hbots://bot/abc?new=1", TrampolineTarget.link("hbots://bot/abc?new=1"))
    assertEquals("hbots://chat/b/t", TrampolineTarget.link("hbots://chat/b/t"))
  }

  @Test fun anythingElseOpensTheAppAtItsLastScreen() {
    assertNull(TrampolineTarget.link(null))
    assertNull(TrampolineTarget.link(""))
    assertNull(TrampolineTarget.link("hbots://"))
    assertNull(TrampolineTarget.link("https://example.com/"))
    assertNull(TrampolineTarget.link("javascript:alert(1)"))
    assertNull(TrampolineTarget.link("hbots://bot/a b"))
    assertNull(TrampolineTarget.link("hbots://bot/a\nb"))
    assertNull(TrampolineTarget.link("hbots://" + "a".repeat(3000)))
  }
}
