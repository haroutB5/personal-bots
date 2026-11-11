package expo.modules.hbotsvoice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeRecorder : MicRecorder {
  @Volatile var released = false
  @Volatile var recording = false
  @Volatile var stopRequested = false
  val startedAfterStop = AtomicInteger()
  private val stopped = CountDownLatch(1)

  override fun startRecording() {
    check(!released) { "startRecording on a released recorder" }
    if (stopRequested) startedAfterStop.incrementAndGet()
    recording = true
  }

  override fun read(buffer: ShortArray, offset: Int, size: Int): Int {
    if (stopped.await(5, TimeUnit.MILLISECONDS)) return -3
    java.util.Arrays.fill(buffer, offset, offset + size, 1000.toShort())
    return size
  }

  override fun stop() {
    stopRequested = true
    recording = false
    stopped.countDown()
  }

  override fun release() {
    recording = false
    released = true
    stopped.countDown()
  }
}

private class FakeSource(private val gate: CountDownLatch? = null) : MicSource {
  val opened = mutableListOf<FakeRecorder>()
  val opening = CountDownLatch(1)

  override fun open(): OpenedMic {
    opening.countDown()
    gate?.await(5, TimeUnit.SECONDS)
    val recorder = FakeRecorder()
    synchronized(opened) { opened.add(recorder) }
    return OpenedMic(recorder, 16_000)
  }

  fun held(): List<FakeRecorder> = synchronized(opened) { opened.filter { !it.released } }
}

class MicCaptureTest {
  private val frames = AtomicInteger()
  private val failures = mutableListOf<String>()
  private val results = mutableListOf<Result<Unit>>()
  private var capture: MicCapture? = null

  private fun captureWith(source: MicSource): MicCapture =
    MicCapture({ frames.incrementAndGet() }, { synchronized(failures) { failures.add(it) } }, source).also { capture = it }

  private fun startAndWait(target: MicCapture) {
    val started = CountDownLatch(1)
    target.start { result ->
      synchronized(results) { results.add(result) }
      started.countDown()
    }
    assertTrue("capture never reported", started.await(2, TimeUnit.SECONDS))
  }

  private fun captureThreads(): List<Thread> =
    Thread.getAllStackTraces().keys.filter { it.name == "hbots-voice-capture" && it.isAlive }

  @After
  fun cleanUp() {
    capture?.stop()
  }

  @Test
  fun aCaptureThatIsStoppedReleasesTheRecorderAndEndsItsThread() {
    val source = FakeSource()
    val mic = captureWith(source)
    startAndWait(mic)
    assertEquals(1, source.held().size)
    mic.stop()
    assertTrue(source.held().isEmpty())
    assertTrue(captureThreads().isEmpty())
  }

  @Test
  fun startAfterStopOpensNoRecorderAndReportsAFailure() {
    val source = FakeSource()
    val mic = captureWith(source)
    startAndWait(mic)
    mic.stop()
    startAndWait(mic)
    assertEquals(1, source.opened.size)
    assertTrue(source.held().isEmpty())
    assertTrue(captureThreads().isEmpty())
    assertTrue(results.last().isFailure)
  }

  @Test
  fun stopBeforeAnyStartMakesTheLaterStartOpenNothing() {
    val source = FakeSource()
    val mic = captureWith(source)
    mic.stop()
    startAndWait(mic)
    assertTrue(source.opened.isEmpty())
    assertTrue(captureThreads().isEmpty())
    assertTrue(results.single().isFailure)
  }

  @Test
  fun startStopStartInQuickSuccessionEndsWithNothingHeld() {
    val source = FakeSource()
    val mic = captureWith(source)
    repeat(25) {
      mic.start { }
      mic.stop()
      mic.start { }
    }
    mic.stop()
    assertTrue(source.held().isEmpty())
    assertFalse(source.opened.any { it.recording })
    assertTrue(captureThreads().isEmpty())
  }

  @Test
  fun aStopThatArrivesWhileTheMicIsStillOpeningWins() {
    val gate = CountDownLatch(1)
    val source = FakeSource(gate)
    val mic = captureWith(source)
    val starter = Thread { mic.start { } }
    starter.start()
    assertTrue(source.opening.await(2, TimeUnit.SECONDS))
    val stopper = Thread { mic.stop() }
    stopper.start()
    Thread.sleep(50)
    gate.countDown()
    starter.join(2000)
    stopper.join(2000)
    assertFalse(starter.isAlive)
    assertFalse(stopper.isAlive)
    assertTrue(source.held().isEmpty())
    assertTrue(captureThreads().isEmpty())
  }

  @Test
  fun aCaptureWhoseLeaseIsDueStopsReadingAndAsksForTheEndOnce() {
    val source = FakeSource()
    val due = java.util.concurrent.atomic.AtomicBoolean(false)
    val asked = AtomicInteger()
    val mic = MicCapture(
      { frames.incrementAndGet() },
      { synchronized(failures) { failures.add(it) } },
      source,
      leaseDue = { due.get() },
      onLeaseDue = { asked.incrementAndGet() },
      post = { it() },
    ).also { capture = it }
    startAndWait(mic)
    val before = frames.get()
    due.set(true)
    val end = System.currentTimeMillis() + 2000
    while (asked.get() == 0 && System.currentTimeMillis() < end) Thread.sleep(5)
    Thread.sleep(100)
    val frozen = frames.get()
    Thread.sleep(100)
    assertEquals(1, asked.get())
    assertEquals(frozen, frames.get())
    assertTrue(frozen >= before)
    mic.stop()
    assertTrue(captureThreads().isEmpty())
  }

  @Test
  fun aStopRightAfterAStartNeverStartsTheRecorderAfterItWasStopped() {
    val source = FakeSource()
    repeat(200) {
      val mic = MicCapture({ }, { }, source)
      mic.start { }
      mic.stop()
    }
    assertEquals(0, source.opened.sumOf { it.startedAfterStop.get() })
    assertTrue(source.held().isEmpty())
  }
}
