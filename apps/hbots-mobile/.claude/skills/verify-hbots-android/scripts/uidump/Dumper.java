// A persistent `uiautomator dump` for verify-hbots-android (ui.py starts it once per run).
//
// `uiautomator dump` starts a new app_process, connects a UiAutomation, waits for the screen to
// be idle for a fixed 1000 ms, dumps, and disconnects: about 2 s per dump on the laptop emulator,
// most of the flow time. This runs the same code (uiautomator.jar's UiAutomationShellWrapper and
// AccessibilityNodeInfoDumper.dumpWindowToFile, the non-compressed default of DumpCommand) in one
// process that stays connected, and waits for idle with the timeouts it is given.
//
// Protocol on stdin/stdout: it prints READY once connected. Each line "dump" is answered with the
// XML (as `uiautomator dump` writes it) and then a line END; a failure prints ERR <why> then END.
// "quit" or the end of stdin disconnects and exits.
//
// Run: CLASSPATH=/system/framework/uiautomator.jar:/data/local/tmp/hbots-uidump.jar \
//        app_process /system/bin Dumper <idle ms> <global ms>
import android.app.UiAutomation;
import android.graphics.Point;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeoutException;

public class Dumper {
  public static void main(String[] args) throws Exception {
    long idleMs = args.length > 0 ? Long.parseLong(args[0]) : 1000;
    long globalMs = args.length > 1 ? Long.parseLong(args[1]) : 10000;
    PrintStream out = new PrintStream(System.out, false, "UTF-8");
    Class<?> wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
    Object wrapper = wrapperClass.getConstructor().newInstance();
    wrapperClass.getMethod("connect").invoke(wrapper);
    try {
      wrapperClass.getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
      UiAutomation automation = (UiAutomation) wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
      Method dumpWindow =
          Class.forName("com.android.uiautomator.core.AccessibilityNodeInfoDumper")
              .getMethod("dumpWindowToFile", AccessibilityNodeInfo.class, File.class, int.class, int.class, int.class);
      Class<?> dmgClass = Class.forName("android.hardware.display.DisplayManagerGlobal");
      Object dmg = dmgClass.getMethod("getInstance").invoke(null);
      Method realDisplay = dmgClass.getMethod("getRealDisplay", int.class);
      File file = new File("/data/local/tmp/hbots-uidump.xml");
      BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
      out.println("READY");
      out.flush();
      String line;
      while ((line = in.readLine()) != null) {
        line = line.trim();
        if (line.equals("quit")) break;
        if (!line.equals("dump")) continue;
        try {
          try {
            automation.waitForIdle(idleMs, globalMs);
          } catch (TimeoutException e) {
            // Same as a busy screen for `uiautomator dump`: dump what is there.
          }
          AccessibilityNodeInfo root = automation.getRootInActiveWindow();
          if (root == null) {
            out.println("ERR null root node");
          } else {
            Display display = (Display) realDisplay.invoke(dmg, 0);
            Point size = new Point();
            display.getRealSize(size);
            dumpWindow.invoke(null, root, file, display.getRotation(), size.x, size.y);
            out.println(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
          }
        } catch (Throwable t) {
          Throwable cause = t.getCause() != null ? t.getCause() : t;
          out.println("ERR " + cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage()).replace('\n', ' '));
        }
        out.println("END");
        out.flush();
      }
    } finally {
      wrapperClass.getMethod("disconnect").invoke(wrapper);
    }
  }
}
