package expo.modules.hbotsupdater

import org.json.JSONException
import org.json.JSONObject

object UpdateRecordCodec {
  private const val SCHEMA = 1

  // The session generation stays process-local: a stale offer cannot outlive the process.
  fun encode(record: UpdateRecord): String = JSONObject()
    .put("schema", SCHEMA)
    .put("state", encodeState(record.state))
    .put("lastCheckAt", record.lastCheckAt ?: JSONObject.NULL)
    .put("lastOffer", record.lastOffer?.let(::encodeRelease) ?: JSONObject.NULL)
    .put("notifiedCode", record.notifiedCode)
    .put("permissionNotifiedCode", record.permissionNotifiedCode)
    .put("deferrals", record.deferrals)
    .toString()

  fun decode(raw: String?): UpdateRecord? {
    if (raw.isNullOrBlank()) return null
    return try {
      decodeRecord(JSONObject(raw))
    } catch (error: Exception) {
      null
    }
  }

  fun load(raw: String?): UpdateRecord = decode(raw) ?: UpdateRecord()

  private fun decodeRecord(json: JSONObject): UpdateRecord {
    if (json.requiredLong("schema") != SCHEMA.toLong()) throw JSONException("schema")
    val deferrals = json.nullableLong("deferrals") ?: 0L
    if (deferrals < 0 || deferrals > Int.MAX_VALUE) throw JSONException("deferrals")
    return UpdateRecord(
      state = decodeState(json.getJSONObject("state")),
      lastCheckAt = json.nullableLong("lastCheckAt")?.also { if (it < 0) throw JSONException("lastCheckAt") },
      lastOffer = json.nullableRelease("lastOffer"),
      notifiedCode = json.requiredLong("notifiedCode").also { if (it < 0) throw JSONException("notifiedCode") },
      permissionNotifiedCode = (json.nullableLong("permissionNotifiedCode") ?: 0L)
        .also { if (it < 0) throw JSONException("permissionNotifiedCode") },
      deferrals = deferrals.toInt(),
    )
  }

  private fun decodeState(json: JSONObject): UpdateState = when (val kind = json.requiredString("kind")) {
    "idle" -> UpdateState.Idle(json.nullableRelease("rejected"))
    "downloading" -> UpdateState.Downloading(json.requiredRelease("target"))
    "ready" -> UpdateState.Ready(json.requiredRelease("target"), json.requiredApk())
    "installing" -> UpdateState.Installing(
      json.requiredRelease("target"),
      json.requiredApk(),
      json.requiredLong("since").also { if (it < 0) throw JSONException("since") },
    )
    "needsTap" -> UpdateState.NeedsTap(json.requiredRelease("target"), json.requiredApk())
    "needsPermission" -> UpdateState.NeedsPermission(json.requiredRelease("target"))
    else -> throw JSONException("unknown state: $kind")
  }

  private fun encodeState(state: UpdateState): JSONObject = when (state) {
    is UpdateState.Idle -> JSONObject()
      .put("kind", "idle")
      .put("rejected", state.rejected?.let(::encodeRelease) ?: JSONObject.NULL)
    is UpdateState.Downloading -> JSONObject()
      .put("kind", "downloading")
      .put("target", encodeRelease(state.target))
    is UpdateState.Ready -> JSONObject()
      .put("kind", "ready")
      .put("target", encodeRelease(state.target))
      .put("apk", state.apk)
    is UpdateState.Installing -> JSONObject()
      .put("kind", "installing")
      .put("target", encodeRelease(state.target))
      .put("apk", state.apk)
      .put("since", state.since)
    is UpdateState.NeedsTap -> JSONObject()
      .put("kind", "needsTap")
      .put("target", encodeRelease(state.target))
      .put("apk", state.apk)
    is UpdateState.NeedsPermission -> JSONObject()
      .put("kind", "needsPermission")
      .put("target", encodeRelease(state.target))
  }

  private fun encodeRelease(release: Release): JSONObject = JSONObject()
    .put("version", release.version)
    .put("sha256", release.sha256)
    .put("size", release.size)

  private fun decodeRelease(json: JSONObject): Release = Release(
    version = json.requiredString("version"),
    sha256 = json.requiredString("sha256"),
    size = json.requiredLong("size"),
  )

  private fun JSONObject.requiredString(key: String): String {
    val value = get(key)
    if (value !is String) throw JSONException("$key must be a string")
    return value
  }

  private fun JSONObject.requiredLong(key: String): Long {
    val value = get(key)
    if (value !is Number || value is Double || value is Float) throw JSONException("$key must be an integer")
    val asLong = value.toLong()
    if (asLong.toDouble() != value.toDouble()) throw JSONException("$key must be an integer")
    return asLong
  }

  private fun JSONObject.nullableLong(key: String): Long? {
    if (!has(key) || isNull(key)) return null
    return requiredLong(key)
  }

  private fun JSONObject.requiredRelease(key: String): Release = decodeRelease(getJSONObject(key))

  private fun JSONObject.nullableRelease(key: String): Release? {
    if (!has(key) || isNull(key)) return null
    return requiredRelease(key)
  }

  private fun JSONObject.requiredApk(): String {
    val apk = requiredString("apk")
    if (apk.isBlank()) throw JSONException("apk")
    return apk
  }
}
