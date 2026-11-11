package expo.modules.hbotsnotify

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The JS to native seam. The JS side pins the same file in policySync.test.ts. */
class PolicySeamTest {
  private fun fixture(): JSONObject {
    val stream = checkNotNull(javaClass.classLoader?.getResourceAsStream("policy-seam.json")) { "policy-seam.json missing" }
    return JSONObject(stream.bufferedReader().use { it.readText() })
  }

  private fun maps(array: JSONArray): List<Map<String, Any?>> =
    (0 until array.length()).map { index ->
      val item = array.getJSONObject(index)
      item.keys().asSequence().associateWith { key -> item.get(key) }
    }

  @Test fun readsExactlyWhatJsSends() {
    val file = fixture()
    val native = file.getJSONObject("native")
    val policy = PolicyCodec.fromJs(native.getBoolean("appLockOn"), maps(native.getJSONArray("bots")))
    val expected = file.getJSONObject("policy")

    assertTrue(policy.appLockOn)
    assertEquals(expected.length(), policy.bots.size)
    for (id in expected.keys()) {
      val bot = checkNotNull(policy.bots[id]) { "bot $id was not read" }
      assertEquals(expected.getJSONObject(id).getString("name"), bot.name)
      assertEquals(expected.getJSONObject(id).getBoolean("hidePreviews"), bot.hidePreviews)
    }
  }

  @Test fun aRowUnderTheStoredKeyIsNotABot() {
    val policy = PolicyCodec.fromJs(false, listOf(mapOf("id" to "b1", "name" to "Juno", "hidePreviews" to false)))
    assertTrue(policy.bots.isEmpty())
  }
}
