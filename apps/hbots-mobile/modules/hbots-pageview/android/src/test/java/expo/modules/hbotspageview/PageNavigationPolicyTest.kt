package expo.modules.hbotspageview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageNavigationPolicyTest {
  private val page = "https://bots.example/api/assets/abc/Page.html#t3-theme=x"

  @Test
  fun loadsOnlyTheGivenDocument() {
    assertEquals(PageNavigation.LOAD, PageNavigationPolicy.decide(page, page, true))
    assertEquals(
      PageNavigation.LOAD,
      PageNavigationPolicy.decide(page, "https://bots.example/api/assets/abc/Page.html#top", true),
    )
  }

  @Test
  fun webLinksLeaveTheApp() {
    assertEquals(
      PageNavigation.OPEN_OUTSIDE,
      PageNavigationPolicy.decide(page, "https://example.com/a", true),
    )
    assertEquals(
      PageNavigation.OPEN_OUTSIDE,
      PageNavigationPolicy.decide(page, "https://bots.example/api/personal/bots", true),
    )
  }

  @Test
  fun otherSchemesAndSubframeNavigationsAreDropped() {
    for (target in listOf("intent://x#Intent;end", "file:///data/x", "content://x", "javascript:1", "hbots://pair")) {
      assertEquals(PageNavigation.BLOCK, PageNavigationPolicy.decide(page, target, true))
    }
    assertEquals(
      PageNavigation.BLOCK,
      PageNavigationPolicy.decide(page, "https://example.com/a", false),
    )
    assertEquals(PageNavigation.BLOCK, PageNavigationPolicy.decide("", page, true))
  }

  @Test
  fun onlyWebPagesLoad() {
    assertTrue(PageNavigationPolicy.isLoadable(page))
    assertFalse(PageNavigationPolicy.isLoadable("file:///sdcard/x.html"))
    assertFalse(PageNavigationPolicy.isLoadable("javascript:alert(1)"))
  }

  @Test
  fun thePageCannotReachTheAppServer() {
    assertTrue(PageNavigationPolicy.allowsSubresource(page, page))
    assertTrue(PageNavigationPolicy.allowsSubresource(page, "https://cdn.example/chart.js"))
    assertTrue(PageNavigationPolicy.allowsSubresource(page, "data:image/png;base64,AAAA"))
    assertFalse(PageNavigationPolicy.allowsSubresource(page, "https://bots.example/api/personal/bots"))
    assertFalse(PageNavigationPolicy.allowsSubresource(page, "https://user@BOTS.example/ws"))
    assertFalse(PageNavigationPolicy.allowsSubresource(page, "file:///data/data/app/x"))
    assertFalse(PageNavigationPolicy.allowsSubresource(page, "content://media/1"))
  }
}
