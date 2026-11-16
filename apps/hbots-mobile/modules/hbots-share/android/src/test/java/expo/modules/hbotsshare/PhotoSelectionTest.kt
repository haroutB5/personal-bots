package expo.modules.hbotsshare

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhotoSelectionTest {
  @Test fun aGrantAloneLeavesNothingTaken() {
    val selection = PhotoSelection<String>()
    selection.grant(listOf("a"))
    assertEquals(1, selection.count)
  }

  @Test fun nothingSelectedTakesNothing() {
    assertNull(PhotoSelection<String>().take())
  }

  @Test fun orderFollowsTheTaps() {
    val selection = PhotoSelection<String>()
    selection.grant(listOf("c"))
    selection.grant(listOf("a", "b"))
    assertEquals(listOf("c", "a", "b"), selection.take())
  }

  @Test fun aRevokeRemovesOnePhoto() {
    val selection = PhotoSelection<String>()
    selection.grant(listOf("a", "b", "c"))
    selection.revoke(listOf("b"))
    assertEquals(2, selection.count)
    assertEquals(listOf("a", "c"), selection.take())
  }

  @Test fun aPhotoSelectedAgainKeepsItsPlace() {
    val selection = PhotoSelection<String>()
    selection.grant(listOf("a", "b"))
    selection.revoke(listOf("a"))
    selection.grant(listOf("a"))
    assertEquals(listOf("b", "a"), selection.take())
  }

  @Test fun takeReturnsEverythingOnceThenNull() {
    val selection = PhotoSelection<String>()
    selection.grant(listOf("a", "b"))
    assertEquals(listOf("a", "b"), selection.take())
    assertNull(selection.take())
  }

  @Test fun duplicatesCountOnce() {
    val selection = PhotoSelection<String>()
    selection.grant(listOf("a", "a"))
    selection.grant(listOf("a"))
    assertEquals(1, selection.count)
    assertEquals(listOf("a"), selection.take())
  }

  @Test fun aGrantAfterTheTakeIsNotDeliveredAgain() {
    val selection = PhotoSelection<String>()
    selection.grant(listOf("a"))
    selection.take()
    selection.grant(listOf("b"))
    assertNull(selection.take())
  }
}
