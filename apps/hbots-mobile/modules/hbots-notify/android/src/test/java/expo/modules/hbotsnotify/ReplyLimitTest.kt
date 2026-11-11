package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplyLimitTest {
  @Test fun fourThousandCharactersStillSend() {
    assertFalse(ReplyLimit.tooLong("a".repeat(4000)))
    assertTrue(ReplyLimit.tooLong("a".repeat(4001)))
  }

  @Test fun theDraftRidesOnTheChatLinkEncoded() {
    assertEquals("hbots://chat/b/t?draft=a%20b%26c%3Dd%0A%C3%A9", ReplyLimit.draftLink("hbots://chat/b/t", "a b&c=d\n\u00e9"))
  }

  @Test fun aLinkThatAlreadyHasAQueryGetsAnAmpersand() {
    assertEquals("hbots://chat/b/t?request=r1&draft=x", ReplyLimit.draftLink("hbots://chat/b/t?request=r1", "x"))
  }

  @Test fun noChatLinkOrTooMuchTextMeansNoDraft() {
    assertNull(ReplyLimit.draftLink(null, "x"))
    assertNull(ReplyLimit.draftLink("hbots://chat/b/t", "a".repeat(ReplyLimit.MAX_DRAFT + 1)))
    assertEquals(true, ReplyLimit.draftLink("hbots://chat/b/t", "a".repeat(ReplyLimit.MAX_DRAFT)) != null)
  }
}
