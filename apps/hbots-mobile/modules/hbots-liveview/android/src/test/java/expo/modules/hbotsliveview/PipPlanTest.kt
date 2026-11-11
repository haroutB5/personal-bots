package expo.modules.hbotsliveview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PipPlanTest {
  @Test fun playingOnApi31EnablesAutoEnter() {
    val request = PipPlan.plan(31, true, true, 1280, 720)!!
    assertTrue(request.autoEnter)
    assertEquals(1280 to 720, request.ratioWidth to request.ratioHeight)
  }

  @Test fun notPlayingTurnsAutoEnterOff() {
    val request = PipPlan.plan(36, true, false, 1280, 720)!!
    assertFalse(request.autoEnter)
  }

  @Test fun belowApi31NothingIsRequested() {
    assertNull(PipPlan.plan(30, true, true, 1280, 720))
    assertNull(PipPlan.plan(26, true, false, 1280, 720))
  }

  @Test fun aPhoneWithoutThePipFeatureNothingIsRequested() {
    assertNull(PipPlan.plan(36, false, true, 1280, 720))
  }

  @Test fun unknownFrameUsesSixteenByNine() {
    assertEquals(16 to 9, PipPlan.ratio(0, 0))
    assertEquals(16 to 9, PipPlan.ratio(-4, 300))
  }

  @Test fun veryWideFrameIsClampedToTheAndroidLimit() {
    assertEquals(239 to 100, PipPlan.ratio(3000, 100))
  }

  @Test fun veryTallFrameIsClampedToTheAndroidLimit() {
    assertEquals(100 to 239, PipPlan.ratio(100, 3000))
  }

  @Test fun aPortraitPhoneFrameKeepsItsShape() {
    assertEquals(390 to 560, PipPlan.ratio(390, 560))
  }
}
