package expo.modules.hbotsupdater

internal class ApkReadException(message: String, cause: Throwable? = null) : Exception(message, cause)

internal object BinaryManifest {
  data class Info(val packageName: String, val versionCode: Long?, val versionName: String?)

  private const val RES_XML_TYPE = 0x0003
  private const val RES_STRING_POOL_TYPE = 0x0001
  private const val RES_XML_RESOURCE_MAP_TYPE = 0x0180
  private const val RES_XML_START_ELEMENT_TYPE = 0x0102

  private const val ATTR_VERSION_CODE = 0x0101021bL
  private const val ATTR_VERSION_NAME = 0x0101021cL

  private const val STRING_POOL_COUNT = 8
  private const val STRING_POOL_FLAGS = 16
  private const val STRING_POOL_START = 20

  private const val ELEMENT_NAME = 20
  private const val ELEMENT_ATTRIBUTE_START = 24
  private const val ELEMENT_ATTRIBUTE_SIZE = 26
  private const val ELEMENT_ATTRIBUTE_COUNT = 28

  private const val ATTRIBUTE_NAMESPACE = 0
  private const val ATTRIBUTE_NAME = 4
  private const val ATTRIBUTE_RAW_VALUE = 8
  private const val ATTRIBUTE_DATA_TYPE = 15
  private const val ATTRIBUTE_DATA = 16

  private const val TYPE_STRING = 0x03
  private const val TYPE_INT_DEC = 0x10
  private const val TYPE_INT_HEX = 0x11
  private const val NO_ENTRY = 0xFFFFFFFFL

  fun parse(bytes: ByteArray): Info {
    if (u16(bytes, 0) != RES_XML_TYPE) throw ApkReadException("not a binary AndroidManifest.xml")
    val headerSize = u16(bytes, 2)
    val size = u32(bytes, 4)
    if (headerSize < 8 || size > bytes.size) throw ApkReadException("truncated AndroidManifest.xml")

    var position = headerSize
    var strings: List<String>? = null
    var resourceIds: List<Long> = emptyList()

    while (position + 8 <= size) {
      val type = u16(bytes, position)
      val chunkHeaderSize = u16(bytes, position + 2)
      val chunkSize = u32(bytes, position + 4)
      if (chunkSize < 8 || position + chunkSize > size) {
        throw ApkReadException("invalid chunk in AndroidManifest.xml")
      }
      when (type) {
        RES_STRING_POOL_TYPE -> strings = parseStringPool(bytes, position, chunkHeaderSize)
        RES_XML_RESOURCE_MAP_TYPE -> resourceIds = parseResourceMap(bytes, position, chunkHeaderSize, chunkSize)
        RES_XML_START_ELEMENT_TYPE -> {
          val pool = strings ?: throw ApkReadException("manifest strings missing")
          val info = parseManifestElement(bytes, position, chunkHeaderSize, chunkSize, pool, resourceIds)
          if (info != null) return info
        }
      }
      position += chunkSize.toInt()
    }
    throw ApkReadException("manifest element missing")
  }

  private fun parseStringPool(bytes: ByteArray, start: Int, headerSize: Int): List<String> {
    val count = u32(bytes, start + STRING_POOL_COUNT).toInt()
    val flags = u32(bytes, start + STRING_POOL_FLAGS)
    val stringsStart = u32(bytes, start + STRING_POOL_START).toInt()
    if (count < 0 || count > 200_000) throw ApkReadException("invalid string pool")
    val offsetsStart = start + headerSize
    requireRange(bytes, offsetsStart, count * 4)
    val utf8 = flags and 0x100L != 0L
    return List(count) { index ->
      val offset = u32(bytes, offsetsStart + index * 4).toInt()
      parseString(bytes, start + stringsStart + offset, utf8)
    }
  }

  private fun parseString(bytes: ByteArray, start: Int, utf8: Boolean): String {
    var position = start
    if (utf8) {
      val first = byteAt(bytes, position++)
      if (first and 0x80 != 0) {
        byteAt(bytes, position++)
      }
      var length = byteAt(bytes, position++)
      if (length and 0x80 != 0) {
        length = ((length and 0x7f) shl 8) or byteAt(bytes, position++)
      }
      requireRange(bytes, position, length)
      return String(bytes, position, length, Charsets.UTF_8)
    }

    var length = u16(bytes, position)
    position += 2
    if (length and 0x8000 != 0) {
      length = ((length and 0x7fff) shl 16) or u16(bytes, position)
      position += 2
    }
    requireRange(bytes, position, length * 2)
    return String(bytes, position, length * 2, Charsets.UTF_16LE)
  }

  private fun parseResourceMap(
    bytes: ByteArray,
    start: Int,
    headerSize: Int,
    chunkSize: Long,
  ): List<Long> {
    val count = ((chunkSize - headerSize) / 4).toInt()
    requireRange(bytes, start + headerSize, count * 4)
    return List(count) { index -> u32(bytes, start + headerSize + index * 4) }
  }

  private fun parseManifestElement(
    bytes: ByteArray,
    start: Int,
    headerSize: Int,
    chunkSize: Long,
    strings: List<String>,
    resourceIds: List<Long>,
  ): Info? {
    val nameIndex = u32(bytes, start + ELEMENT_NAME).toInt()
    val name = strings.getOrNull(nameIndex) ?: throw ApkReadException("element name missing")
    if (name != "manifest") return null

    val attributeStart = u16(bytes, start + ELEMENT_ATTRIBUTE_START)
    val attributeSize = u16(bytes, start + ELEMENT_ATTRIBUTE_SIZE)
    val attributeCount = u16(bytes, start + ELEMENT_ATTRIBUTE_COUNT)
    if (attributeSize < 20) throw ApkReadException("invalid attribute size")

    var attribute = start + headerSize + attributeStart
    var packageName: String? = null
    var versionCode: Long? = null
    var versionName: String? = null

    repeat(attributeCount) {
      if (attribute + attributeSize > start + chunkSize) {
        throw ApkReadException("attribute outside manifest element")
      }
      val namespace = u32(bytes, attribute + ATTRIBUTE_NAMESPACE)
      val attributeNameIndex = u32(bytes, attribute + ATTRIBUTE_NAME).toInt()
      val rawValue = u32(bytes, attribute + ATTRIBUTE_RAW_VALUE)
      val dataType = byteAt(bytes, attribute + ATTRIBUTE_DATA_TYPE)
      val data = u32(bytes, attribute + ATTRIBUTE_DATA)
      val resourceId = resourceIds.getOrNull(attributeNameIndex)
      val attributeName = strings.getOrNull(attributeNameIndex).orEmpty()

      when {
        attributeName == "package" && namespace == NO_ENTRY ->
          packageName = stringValue(strings, dataType, data, rawValue)
        resourceId == ATTR_VERSION_CODE || attributeName == "versionCode" ->
          versionCode = longValue(strings, dataType, data, rawValue)
        resourceId == ATTR_VERSION_NAME || attributeName == "versionName" ->
          versionName = stringValue(strings, dataType, data, rawValue)
      }
      attribute += attributeSize
    }

    return Info(
      packageName = packageName ?: throw ApkReadException("package missing"),
      versionCode = versionCode,
      versionName = versionName,
    )
  }

  private fun stringValue(strings: List<String>, dataType: Int, data: Long, rawValue: Long): String? =
    when {
      dataType == TYPE_STRING -> strings.getOrNull(data.toInt())
      rawValue != NO_ENTRY -> strings.getOrNull(rawValue.toInt())
      else -> null
    }

  private fun longValue(strings: List<String>, dataType: Int, data: Long, rawValue: Long): Long? =
    when (dataType) {
      TYPE_INT_DEC, TYPE_INT_HEX -> data
      TYPE_STRING -> stringValue(strings, dataType, data, rawValue)?.toLongOrNull()
      else -> null
    }

  private fun requireRange(bytes: ByteArray, start: Int, length: Int) {
    if (start < 0 || length < 0 || start.toLong() + length > bytes.size) {
      throw ApkReadException("truncated AndroidManifest.xml")
    }
  }

  private fun byteAt(bytes: ByteArray, offset: Int): Int {
    requireRange(bytes, offset, 1)
    return bytes[offset].toInt() and 0xff
  }

  private fun u16(bytes: ByteArray, offset: Int): Int =
    byteAt(bytes, offset) or (byteAt(bytes, offset + 1) shl 8)

  private fun u32(bytes: ByteArray, offset: Int): Long =
    u16(bytes, offset).toLong() or (u16(bytes, offset + 2).toLong() shl 16)
}
