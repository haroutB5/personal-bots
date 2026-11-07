package expo.modules.hbotsupdater

import expo.modules.hbotsupdater.SessionVerdict.Invalid
import expo.modules.hbotsupdater.SessionVerdict.Unknown
import expo.modules.hbotsupdater.SessionVerdict.Valid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionCheckTest {
  @Test
  fun `a live bearer session is valid`() {
    assertEquals(Valid, SessionCheck.classify(200, """{"authenticated":true,"scopes":["read"]}"""))
  }

  @Test
  fun `a revoked bearer is invalid even though the route answers 200`() {
    assertEquals(Invalid, SessionCheck.classify(200, """{"authenticated":false}"""))
  }

  @Test
  fun `401 and 403 are invalid`() {
    assertEquals(Invalid, SessionCheck.classify(401, null))
    assertEquals(Invalid, SessionCheck.classify(403, """{"error":"forbidden"}"""))
  }

  @Test
  fun `a server error, a missing route or a broken body is unknown`() {
    assertEquals(Unknown, SessionCheck.classify(500, """{"authenticated":true}"""))
    assertEquals(Unknown, SessionCheck.classify(404, "Not Found"))
    assertEquals(Unknown, SessionCheck.classify(200, "not json"))
    assertEquals(Unknown, SessionCheck.classify(200, null))
    assertEquals(Unknown, SessionCheck.classify(200, """{"auth":true}"""))
  }

  @Test
  fun `the keystore alias matches expo-secure-store`() {
    assertEquals(
      "AES/GCM/NoPadding:key_v1:keystoreUnauthenticated",
      SecureStoreSource.keystoreAlias("key_v1", usesSuffix = true),
    )
    assertEquals("AES/GCM/NoPadding:key_v1", SecureStoreSource.keystoreAlias("key_v1", usesSuffix = false))
  }

  @Test
  fun `a stored session parses only when it is https and carries a token`() {
    assertEquals(
      NativeSession("https://relay.example.test", "tok"),
      NativeSession.parse("""{"httpBaseUrl":"https://relay.example.test","accessToken":"tok"}"""),
    )
    assertNull(NativeSession.parse("""{"httpBaseUrl":"http://relay.example.test","accessToken":"tok"}"""))
    assertNull(NativeSession.parse("""{"httpBaseUrl":"https://relay.example.test","accessToken":" "}"""))
    assertNull(NativeSession.parse("""{"httpBaseUrl":"https://relay.example.test"}"""))
    assertNull(NativeSession.parse("not json"))
  }
}
