/**
 * The bots' key names to XKB keysym names.
 *
 * `desktopKeys.ts` stays exactly as it is: it parses every tool's key syntax
 * into Windows virtual-key codes (or a literal character), which the Windows
 * helper presses. On Linux the same parsed chord is mapped here to the keysym
 * the virtual keyboard knows, so `computer_key`, `computer_hold_key` and the
 * modifiers around clicks all keep one grammar and one allowlist.
 */
import { DesktopHelperError } from "../DesktopHelper.ts";
import type { KeyEntry } from "../desktopKeys.ts";

const VK_TO_KEYSYM: Readonly<Record<number, string>> = {
  0x11: "Control_L",
  0x12: "Alt_L",
  0x10: "Shift_L",
  0x5b: "Super_L",
  0x0d: "Return",
  0x09: "Tab",
  0x1b: "Escape",
  0x20: "space",
  0x08: "BackSpace",
  0x2e: "Delete",
  0x2d: "Insert",
  0x24: "Home",
  0x23: "End",
  0x21: "Page_Up",
  0x22: "Page_Down",
  0x25: "Left",
  0x26: "Up",
  0x27: "Right",
  0x28: "Down",
  0x14: "Caps_Lock",
  0x2c: "Print",
  0x5d: "Menu",
  0x90: "Num_Lock",
  0x91: "Scroll_Lock",
  0x13: "Pause",
  0xaf: "XF86AudioRaiseVolume",
  0xae: "XF86AudioLowerVolume",
  0xad: "XF86AudioMute",
  0xb0: "XF86AudioNext",
  0xb1: "XF86AudioPrev",
  0xb3: "XF86AudioPlay",
  0xbb: "plus",
  0xbd: "minus",
};

/** The modifier VKs the tool layer may hold around a pointer action. */
export const KEY_MODIFIER_VKS: ReadonlySet<number> = new Set([0x10, 0x11, 0x12, 0x5b]);

export function isModifierEntry(entry: KeyEntry): boolean {
  return typeof entry === "number" && KEY_MODIFIER_VKS.has(entry);
}

/** The XKB keysym name for one parsed key. */
export function keysymName(entry: KeyEntry): string {
  if (typeof entry !== "number") return entry.char;
  const named = VK_TO_KEYSYM[entry];
  if (named !== undefined) return named;
  if (entry >= 0x41 && entry <= 0x5a) return String.fromCharCode(entry).toLowerCase();
  if (entry >= 0x30 && entry <= 0x39) return String.fromCharCode(entry);
  if (entry >= 0x70 && entry <= 0x87) return `F${entry - 0x6f}`;
  throw new DesktopHelperError(
    "invalid",
    `The key ${entry} has no Linux equivalent. Use a letter, digit, F1-F24 or a named key.`,
  );
}
