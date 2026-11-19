package expo.modules.hbotsgoogleauth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private val GMAIL = listOf(
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
)

class AuthorizationOutcomeTest {
  @Test
  fun aCodeWithEveryScopeIsGranted() {
    val outcome = interpretAuthorization("4/0code", GMAIL, GMAIL)
    assertEquals(AuthorizationOutcome.Granted("4/0code", GMAIL), outcome)
    assertEquals(
      mapOf("status" to "granted", "serverAuthCode" to "4/0code", "grantedScopes" to GMAIL),
      outcome.toMap(),
    )
  }

  @Test
  fun anUntickedScopeIsNamedAndTheCodeIsNotReturned() {
    val outcome = interpretAuthorization("4/0code", GMAIL.take(1), GMAIL)
    assertEquals(AuthorizationOutcome.ScopesDenied(GMAIL.drop(1)), outcome)
    assertTrue("serverAuthCode" !in outcome.toMap())
  }

  @Test
  fun aMissingOrBlankCodeIsNoCode() {
    assertEquals(AuthorizationOutcome.NoCode, interpretAuthorization(null, GMAIL, GMAIL))
    assertEquals(AuthorizationOutcome.NoCode, interpretAuthorization("  ", GMAIL, GMAIL))
  }

  @Test
  fun aNullScopeListCountsAsNothingGranted() {
    assertEquals(AuthorizationOutcome.ScopesDenied(GMAIL), interpretAuthorization("c", null, GMAIL))
  }

  @Test
  fun cancelAndFailureHaveStableShapes() {
    assertEquals(mapOf("status" to "cancelled"), cancelledMap())
    assertEquals(
      mapOf("status" to "error", "code" to 10, "message" to "DEVELOPER_ERROR"),
      failureMap(10, "DEVELOPER_ERROR"),
    )
    assertEquals("Google sign-in failed.", failureMap(-1, null)["message"])
  }
}
