// @effect-diagnostics nodeBuiltinImport:off - compiles and loads the real helper in a child powershell.
/**
 * The helper's input tags, checked against the compiled C# itself: its hooks
 * are called directly (through reflection, with no real hook installed), so
 * this runs anywhere Windows does, locked or not, and never touches the
 * mouse or keyboard.
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
$out = New-Object System.IO.StringWriter
$t.GetField('output', $bf).SetValue($null, $out)
$t.GetField('armed', $bf).SetValue($null, $true)
$M = [System.Runtime.InteropServices.Marshal]
function Gen { $t.GetField('abortGeneration', $bf).GetValue($null) }
function Phys { $t.GetField('lastPhysicalInput', $bf).GetValue($null) }
function Key([int]$vk, [long]$extra, [int]$msg) {
  $p = $M::AllocHGlobal(32)
  $M::WriteInt32($p, 0, $vk); $M::WriteInt32($p, 4, 0); $M::WriteInt32($p, 8, 0); $M::WriteInt32($p, 12, 0)
  $M::WriteInt64($p, 16, $extra)
  try { return [long]$t.GetMethod('KeyboardHook', $bf).Invoke($null, @([int]0, [IntPtr]$msg, $p)) } finally { $M::FreeHGlobal($p) }
}
function Mouse([long]$extra) {
  $p = $M::AllocHGlobal(40)
  for ($i = 0; $i -lt 24; $i += 4) { $M::WriteInt32($p, $i, 0) }
  $M::WriteInt64($p, 24, $extra)
  try { [void]$t.GetMethod('MouseHook', $bf).Invoke($null, @([int]0, [IntPtr]0x200, $p)) } finally { $M::FreeHGlobal($p) }
}
$classify = $t.GetMethod('Classify', $bf)
$r = [ordered]@{}
$r.classifyBot = $classify.Invoke($null, @([IntPtr]0x50420001))
$r.classifyRemote = $classify.Invoke($null, @([IntPtr]0x50420002))
$r.classifyUser = $classify.Invoke($null, @([IntPtr]0))
$g0 = Gen
$r.remoteEscSwallowed = (Key 0x1B 0x50420002 0x100) -eq 1
[void](Key 0x1B 0x50420002 0x101)
$r.remoteEscAborted = (Gen) -ne $g0
$r.botEscSwallowed = (Key 0x1B 0x50420001 0x100) -eq 1
[void](Key 0x1B 0x50420001 0x101)
$r.botEscAborted = (Gen) -ne $g0
[void](Key 0x41 0x50420002 0x100)
Mouse 0x50420002
Mouse 0x50420001
$r.physicalAfterRemoteAndBot = Phys
$r.killsBeforeUserEsc = ($out.ToString() -split "\n" | Where-Object { $_ -match '"kill"' }).Count
$r.userEscSwallowed = (Key 0x1B 0 0x100) -eq 1
$r.userEscUpSwallowed = (Key 0x1B 0 0x101) -eq 1
$r.userEscAborted = (Gen) -ne $g0
$r.killsAfterUserEsc = ($out.ToString() -split "\n" | Where-Object { $_ -match '"kill"' }).Count
$r.physicalAfterUser = (Phys) -gt 0
$t.GetField('lastPhysicalInput', $bf).SetValue($null, [long]0)
Mouse 0
$r.physicalAfterUserMouse = (Phys) -gt 0
$r | ConvertTo-Json -Compress
`;

// oxlint-disable-next-line t3code/no-global-process-runtime -- the skip decision needs the real host platform, outside any Effect runtime.
describe.skipIf(process.platform !== "win32")("desktop helper input tags", () => {
  it("tells the owner's remote input from a bot's and from the person at the PC", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pb-helper-tags-"));
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
          timeout: 60_000,
          env: { ...process.env, PB_DLL: dllPath },
        },
      );
      expect(result.stderr).toBe("");
      const probe = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? "{}");
      expect(probe).toEqual({
        classifyBot: 1,
        classifyRemote: 2,
        classifyUser: 0,
        // The owner's Esc from the app reaches the PC: it never stops anything.
        remoteEscSwallowed: false,
        remoteEscAborted: false,
        // A bot's own Esc never stops itself either.
        botEscSwallowed: false,
        botEscAborted: false,
        // Neither counts as the person at the PC (no user-activity pause).
        physicalAfterRemoteAndBot: 0,
        killsBeforeUserEsc: 0,
        // The person at the PC: Esc is the stop key, eaten on the way down and up.
        userEscSwallowed: true,
        userEscUpSwallowed: true,
        userEscAborted: true,
        killsAfterUserEsc: 1,
        physicalAfterUser: true,
        physicalAfterUserMouse: true,
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
