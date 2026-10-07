// @effect-diagnostics nodeBuiltinImport:off - compiles and loads the real helper in a child powershell.
/**
 * 1.66.6 helper commands, checked against the compiled C# itself in its
 * dry-run mode: the helper's `dryLog` is set through reflection, so every
 * mouse and keyboard event is written to a list instead of being injected.
 * Runs anywhere Windows does, locked or not, and never touches the real mouse
 * or keyboard.
 *
 * What it proves: a held mouse button or key is let go on every path in the
 * helper (normal end, the user touching the PC part way, releaseAll), the
 * modifiers around click, drag and scroll always come back up, and the
 * owner's remote input is left to the server.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { ensureHelperCompiled } from "./DesktopHelper.ts";

const PROBE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Web.Extensions
$asm = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($env:PB_DLL))
$t = $asm.GetType('PbDesktopHelper')
$bf = [System.Reflection.BindingFlags]'NonPublic,Public,Static'
$log = New-Object 'System.Collections.Generic.List[string]'
$t.GetField('dryLog', $bf).SetValue($null, $log)
$handle = $t.GetMethod('Handle', $bf)
function Cmd([hashtable]$h) {
  $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  # GetEnumerator, not .Keys: a hashtable entry named keys would shadow the property.
  foreach ($entry in $h.GetEnumerator()) { $d[$entry.Key] = $entry.Value }
  $invokeArgs = New-Object 'object[]' 1
  $invokeArgs[0] = $d.psobject.BaseObject
  return $handle.Invoke($null, $invokeArgs)
}
function Ints($values) {
  $list = New-Object System.Collections.ArrayList
  foreach ($v in $values) { [void]$list.Add([int]$v) }
  return ,$list.psobject.BaseObject
}
function Mark { $script:mark = $log.Count }
function Since { if ($log.Count -le $script:mark) { return @() } return @($log.GetRange($script:mark, $log.Count - $script:mark)) }
function Failure([hashtable]$h) {
  try { [void](Cmd $h); return 'none' } catch { return $_.Exception.InnerException.Message }
}
function SetPhysical([long]$ticks) { $t.GetField('lastPhysicalInput', $bf).SetValue($null, $ticks) }
$r = [ordered]@{}

# A button pressed by a bot stays down until it is released.
Mark
[void](Cmd @{ cmd = 'button'; button = 'left'; down = $true })
$r.pressLog = @(Since)
$res = Cmd @{ cmd = 'releaseAll' }
$r.releasedAfterPress = $res['released']
$r.pressThenReleaseAllLog = @(Since)
$res = Cmd @{ cmd = 'releaseAll' }
$r.releasedTwice = $res['released']

# A normal press and release leaves nothing behind.
Mark
[void](Cmd @{ cmd = 'button'; button = 'right'; down = $true })
[void](Cmd @{ cmd = 'button'; button = 'right'; down = $false })
$r.rightLog = @(Since)
$res = Cmd @{ cmd = 'releaseAll' }
$r.releasedAfterCleanRelease = $res['released']

# The owner's remote input is tracked by the server, not by releaseAll.
Mark
[void](Cmd @{ cmd = 'button'; button = 'left'; down = $true; remote = $true })
$res = Cmd @{ cmd = 'releaseAll' }
$r.releasedRemote = $res['released']
$r.remoteLog = @(Since)

# hold: presses in order, releases in reverse.
Mark
[void](Cmd @{ cmd = 'hold'; keys = (Ints @(0x11, 0x10)); durationMs = 60; repeat = $false })
$r.holdChordLog = @(Since)
$res = Cmd @{ cmd = 'releaseAll' }
$r.releasedAfterHold = $res['released']

# hold with repeat: a held navigation key repeats after 500 ms; without it, one press only.
Mark
[void](Cmd @{ cmd = 'hold'; keys = (Ints @(0x28)); durationMs = 900; repeat = $true })
$repeatLog = @(Since)
$r.repeatDowns = @($repeatLog | Where-Object { $_ -eq 'key:40:1' }).Count
$r.repeatLast = $repeatLog[$repeatLog.Count - 1]
Mark
[void](Cmd @{ cmd = 'hold'; keys = (Ints @(0x41)); durationMs = 700; repeat = $false })
$r.noRepeatLog = @(Since)

# hold interrupted part way (the person at the PC touches the mouse): keys still come up.
Mark
SetPhysical ([DateTime]::UtcNow.Ticks + 1000000000)
$r.holdInterruptedError = Failure @{ cmd = 'hold'; keys = (Ints @(0x11, 0x5A)); durationMs = 5000; repeat = $true }
SetPhysical 0
$r.holdInterruptedLog = @(Since)
$res = Cmd @{ cmd = 'releaseAll' }
$r.releasedAfterInterruptedHold = $res['released']

# click: modifiers wrap the presses and come back up.
Mark
[void](Cmd @{ cmd = 'click'; x = 5; y = 6; button = 'left'; count = 2; modifiers = (Ints @(0x11)) })
$r.clickLog = @(Since)

# drag and scroll take modifiers too.
Mark
[void](Cmd @{ cmd = 'drag'; fromX = 1; fromY = 2; toX = 25; toY = 50; button = 'left'; modifiers = (Ints @(0x10)) })
$dragLog = @(Since)
$r.dragFirst = $dragLog[0]
$r.dragPressIndex = [array]::IndexOf($dragLog, 'mouse:2:0')
$r.dragReleaseIndex = [array]::IndexOf($dragLog, 'mouse:4:0')
$r.dragLast = $dragLog[$dragLog.Count - 1]
$r.dragMoves = @($dragLog | Where-Object { $_ -like 'move:*' }).Count
Mark
[void](Cmd @{ cmd = 'scroll'; dy = 2; dx = 0; modifiers = (Ints @(0x11)) })
$r.scrollLog = @(Since)
Mark
[void](Cmd @{ cmd = 'scroll'; dy = 1; dx = 0 })
$r.scrollPlainLog = @(Since)

# drag interrupted by the person at the PC: the button and the modifier both come up.
Mark
SetPhysical ([DateTime]::UtcNow.Ticks + 1000000000)
$r.dragInterruptedError = Failure @{ cmd = 'drag'; fromX = 1; fromY = 2; toX = 25; toY = 50; button = 'left'; modifiers = (Ints @(0x10)) }
SetPhysical 0
$r.dragInterruptedLog = @(Since)
$res = Cmd @{ cmd = 'releaseAll' }
$r.releasedAfterInterruptedDrag = $res['released']

# releaseAll lets go of several things at once, in any order the bot left them.
Mark
[void](Cmd @{ cmd = 'button'; button = 'left'; down = $true })
[void](Cmd @{ cmd = 'button'; button = 'middle'; down = $true })
$res = Cmd @{ cmd = 'releaseAll' }
$r.releasedTwoButtons = $res['released']
$r.twoButtonsLog = @(Since)

$r | ConvertTo-Json -Compress -Depth 4
`;

// oxlint-disable-next-line t3code/no-global-process-runtime -- the skip decision needs the real host platform, outside any Effect runtime.
describe.skipIf(process.platform !== "win32")("desktop helper held input (dry run)", () => {
  it("lets go of every button and key on every path, and wraps pointer actions in their modifiers", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pb-helper-hold-"));
    try {
      const { dllPath } = ensureHelperCompiled(dir);
      const script = NodePath.join(dir, "probe.ps1");
      NodeFS.writeFileSync(script, PROBE, "utf8");
      const result = NodeChildProcess.spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 90_000,
          env: { ...process.env, PB_DLL: dllPath },
        },
      );
      expect(result.stderr).toBe("");
      const probe = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? "{}");

      // Flags: 2 / 4 left down / up, 8 / 16 right, 32 / 64 middle. Keys: vk:flags, flag 2 = key up, 1 = extended.
      expect(probe.pressLog).toEqual(["mouse:2:0"]);
      expect(probe.releasedAfterPress).toBe(1);
      expect(probe.pressThenReleaseAllLog).toEqual(["mouse:2:0", "mouse:4:0"]);
      expect(probe.releasedTwice).toBe(0);

      expect(probe.rightLog).toEqual(["mouse:8:0", "mouse:16:0"]);
      expect(probe.releasedAfterCleanRelease).toBe(0);

      expect(probe.releasedRemote).toBe(0);
      expect(probe.remoteLog).toEqual(["mouse:2:0"]);

      expect(probe.holdChordLog).toEqual(["key:17:0", "key:16:0", "key:16:2", "key:17:2"]);
      expect(probe.releasedAfterHold).toBe(0);

      expect(probe.repeatDowns).toBeGreaterThanOrEqual(4);
      expect(probe.repeatLast).toBe("key:40:3");
      expect(probe.noRepeatLog).toEqual(["key:65:0", "key:65:2"]);

      expect(probe.holdInterruptedError).toContain("started using the mouse or keyboard");
      expect(probe.holdInterruptedLog).toEqual(["key:17:0", "key:90:0", "key:90:2", "key:17:2"]);
      expect(probe.releasedAfterInterruptedHold).toBe(0);

      expect(probe.clickLog).toEqual([
        "move:5,6",
        "key:17:0",
        "mouse:2:0",
        "mouse:4:0",
        "mouse:2:0",
        "mouse:4:0",
        "key:17:2",
      ]);

      expect(probe.dragFirst).toBe("key:16:0");
      expect(probe.dragPressIndex).toBeGreaterThan(0);
      expect(probe.dragReleaseIndex).toBeGreaterThan(probe.dragPressIndex);
      expect(probe.dragLast).toBe("key:16:2");
      expect(probe.dragMoves).toBe(25);
      expect(probe.scrollLog).toEqual([
        "key:17:0",
        "mouse:2048:-120",
        "mouse:2048:-120",
        "key:17:2",
      ]);
      expect(probe.scrollPlainLog).toEqual(["mouse:2048:-120"]);

      expect(probe.dragInterruptedError).toContain("started using the mouse or keyboard");
      expect(probe.dragInterruptedLog).toEqual([
        "key:16:0",
        "move:1,2",
        "mouse:2:0",
        "mouse:4:0",
        "key:16:2",
      ]);
      expect(probe.releasedAfterInterruptedDrag).toBe(0);

      expect(probe.releasedTwoButtons).toBe(2);
      expect([...probe.twoButtonsLog].toSorted()).toEqual(
        ["mouse:2:0", "mouse:32:0", "mouse:4:0", "mouse:64:0"].toSorted(),
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
