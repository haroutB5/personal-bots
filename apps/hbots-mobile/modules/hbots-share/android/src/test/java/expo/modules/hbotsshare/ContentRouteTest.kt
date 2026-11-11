package expo.modules.hbotsshare

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentRouteTest {
  @Test fun theKeyboardIsOfferedImages() {
    assertArrayEquals(arrayOf("image/*"), ContentRoute.ACCEPTED_TYPES)
  }

  @Test fun anItemWithAUriIsCopiedAndTextGoesBackToTheField() {
    assertTrue(ContentRoute.takesItem(hasUri = true))
    assertFalse(ContentRoute.takesItem(hasUri = false))
  }

  @Test fun aMissingMimeFallsBackToAnImage() {
    assertEquals("image/*", ContentRoute.mimeHint(null))
    assertEquals("image/*", ContentRoute.mimeHint("  "))
    assertEquals("image/png", ContentRoute.mimeHint("image/png"))
  }
}
