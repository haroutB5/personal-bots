/**
 * Key names a bot writes ("ctrl+shift+t", "Return", "cmd+a", "alt+F4") to the
 * Windows virtual-key codes the helper presses. A single character without a
 * name (such as "/" or "?") is left for the helper to resolve against the
 * active keyboard layout, since its key depends on that layout.
 */

export type KeyEntry = number | { readonly char: string };

const NAMED: Readonly<Record<string, number>> = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  option: 0x12,
  shift: 0x10,
  win: 0x5b,
  windows: 0x5b,
  super: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
  command: 0x5b,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  ins: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  prior: 0x21,
  pagedown: 0x22,
  next: 0x22,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  capslock: 0x14,
  printscreen: 0x2c,
  print: 0x2c,
  menu: 0x5d,
  apps: 0x5d,
  contextmenu: 0x5d,
  numlock: 0x90,
  scrolllock: 0x91,
  pause: 0x13,
  volumeup: 0xaf,
  volumedown: 0xae,
  volumemute: 0xad,
  medianext: 0xb0,
  mediaprev: 0xb1,
  mediaplaypause: 0xb3,
  plus: 0xbb,
  minus: 0xbd,
};

export class DesktopKeyError extends Error {}

function keyEntry(raw: string): KeyEntry {
  const name = raw.trim();
  if (name.length === 0) throw new DesktopKeyError("Empty key in the combination.");
  if (name.length === 1) {
    const char = name;
    if (/[a-z]/i.test(char)) return char.toUpperCase().charCodeAt(0);
    if (/[0-9]/.test(char)) return char.charCodeAt(0);
    return { char };
  }
  const normalized = name.toLowerCase().replace(/[_\s-]/g, "");
  const named = NAMED[normalized];
  if (named !== undefined) return named;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(normalized);
  if (fn) return 0x6f + Number(fn[1]);
  throw new DesktopKeyError(`Unknown key "${name}".`);
}

/**
 * One combination per space-separated group, keys within a group joined by
 * "+": "ctrl+a Delete" is Ctrl+A, then Delete. A literal "+" key is written
 * "plus" ("ctrl+plus").
 */
export function parseKeyCombos(keys: string): ReadonlyArray<ReadonlyArray<KeyEntry>> {
  const groups = keys
    .trim()
    .split(/\s+/)
    .filter((group) => group.length > 0);
  if (groups.length === 0) throw new DesktopKeyError("No keys given.");
  if (groups.length > 20) throw new DesktopKeyError("At most 20 key combinations per call.");
  return groups.map((group) => {
    const parts = group === "+" ? ["+"] : group.split("+");
    if (parts.length > 5) throw new DesktopKeyError(`"${group}" presses too many keys at once.`);
    return parts.map(keyEntry);
  });
}
