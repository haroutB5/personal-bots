package expo.modules.hbotsupdater

import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateSessionTest {
  private fun serve(handler: (Socket) -> Unit): ServerSocket {
    val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    val open = mutableListOf<Socket>()
    thread(isDaemon = true) {
      while (!server.isClosed) {
        val socket = runCatching { server.accept() }.getOrNull() ?: break
        synchronized(open) { open += socket }
        runCatching { handler(socket) }
      }
    }
    return server
  }

  private fun respond(socket: Socket, status: String, body: String) {
    val bytes = body.toByteArray()
    OutputStreamWriter(socket.getOutputStream()).apply {
      write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
      write(String(bytes))
      flush()
    }
    socket.close()
  }

  @Test
  fun `a valid session response is trusted`() {
    val server = serve { respond(it, "200 OK", """{"authenticated":true}""") }
    try {
      val probe = UpdateSession.probe("http://127.0.0.1:${server.localPort}", "tok")

      assertEquals(SessionVerdict.Valid, probe.verdict)
      assertEquals(200, probe.status)
    } finally {
      server.close()
    }
  }

  @Test
  fun `a body over sixteen kibibytes is not read and grants nothing`() {
    val payload = """{"authenticated":true,"pad":"""" + "a".repeat(17 * 1024) + """"}"""
    val server = serve { respond(it, "200 OK", payload) }
    try {
      val probe = UpdateSession.probe("http://127.0.0.1:${server.localPort}", "tok")

      assertEquals(SessionVerdict.Unknown, probe.verdict)
      assertEquals("body over 16384 bytes", probe.failure)
    } finally {
      server.close()
    }
  }

  @Test
  fun `a direct hang is cut by the call timeout`() {
    val server = serve { }
    try {
      val started = System.currentTimeMillis()
      val probe = UpdateSession.probe("http://127.0.0.1:${server.localPort}", "tok")
      val elapsed = System.currentTimeMillis() - started

      assertEquals(SessionVerdict.Unknown, probe.verdict)
      assertEquals("InterruptedIOException", probe.failure)
      assertTrue("elapsed ${probe.elapsedMs}ms", probe.elapsedMs in 9_000..13_000)
      assertTrue("wall clock ${elapsed}ms", elapsed in 9_000..13_000)
      println("direct hang verdict=${probe.verdict} failure=${probe.failure} elapsed=${probe.elapsedMs}ms")
    } finally {
      server.close()
    }
  }
}
