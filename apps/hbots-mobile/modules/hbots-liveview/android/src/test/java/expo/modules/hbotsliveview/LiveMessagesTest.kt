package expo.modules.hbotsliveview

import org.junit.Assert.assertEquals
import org.junit.Test

class LiveMessagesTest {
  @Test
  fun `browser tap carries the frame point`() {
    assertEquals(
      """{"_tag":"Pointer","action":"tap","x":12.5,"y":40.0}""",
      LiveMessages.browserPointer("tap", 12.5f, 40f),
    )
  }

  @Test
  fun `browser wheel carries both deltas`() {
    assertEquals(
      """{"_tag":"Wheel","x":1.0,"y":2.0,"deltaX":0.0,"deltaY":-24.0}""",
      LiveMessages.browserWheel(1f, 2f, 0f, -24f),
    )
  }

  @Test
  fun `key modifiers are the contract's names`() {
    assertEquals(
      """{"_tag":"Key","key":"Tab","modifiers":["Shift"]}""",
      LiveMessages.browserKey("Tab", listOf("Shift")),
    )
    assertEquals("""{"_tag":"Key","key":"Escape"}""", LiveMessages.browserKey("Escape", emptyList()))
  }

  @Test
  fun `typed text and urls are escaped`() {
    assertEquals(
      """{"_tag":"InsertText","text":"say \"hi\"\nbye"}""",
      LiveMessages.browserText("say \"hi\"\nbye"),
    )
    assertEquals(
      """{"_tag":"Navigate","url":"https://example.com/a?b=1&c=2"}""",
      LiveMessages.browserNavigate("https://example.com/a?b=1&c=2"),
    )
  }

  @Test
  fun `viewports and acks match the wire tags`() {
    assertEquals("""{"_tag":"Viewport","width":390,"height":640}""", LiveMessages.browserViewport(390, 640))
    assertEquals("""{"_tag":"Viewport","width":1280,"height":800}""", LiveMessages.desktopViewport(1280, 800))
    assertEquals("""{"_tag":"FrameAck"}""", LiveMessages.browserFrameAck())
    assertEquals("""{"_tag":"Ack"}""", LiveMessages.desktopAck())
  }

  @Test
  fun `a dialog answer omits a prompt it does not have`() {
    assertEquals(
      """{"_tag":"AnswerDialog","accept":true}""",
      LiveMessages.browserAnswerDialog(true, null),
    )
    assertEquals(
      """{"_tag":"AnswerDialog","accept":false,"promptText":"no thanks"}""",
      LiveMessages.browserAnswerDialog(false, "no thanks"),
    )
  }
}
