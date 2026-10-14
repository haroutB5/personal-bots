/**
 * Case-insensitive environment-name handling, shared by both DeepSeek engines.
 *
 * Windows has one variable per name whatever it is spelled, and a process
 * environment can legitimately hold `Path` and `PATH` at once when a parent
 * mixed spellings. That is harmless until something iterates the block by
 * name: PowerShell 5.1 inside a tool then fails with "An item with the same key
 * has already been added", and a case-sensitive lookup in our own code can miss
 * the entry it meant to replace or drop.
 *
 * Kept in its own module because both the Claude-engine environment builder and
 * the harness (dsh) builder need it, and they must agree.
 *
 * @module provider/environmentNames
 */

/**
 * Case-insensitive de-duplication of environment names: one entry per name,
 * carrying the LAST value seen under the FIRST spelling seen.
 *
 * PowerShell 5.1 inside a dsh tool fails on `Get-ChildItem Env:` when the
 * process environment holds `Path` and `PATH` at once ("An item with the same
 * key has already been added"), and a spawned tool inherits exactly that.
 * Windows has one variable per name whatever it is spelled, so the last value
 * wins — that is what makes an instance's own `PATH` (or `TEMP`, `ComSpec`)
 * override stick even though it arrives spelled differently from the inherited
 * one — while the first spelling is kept, so the name the OS already uses is
 * the name the child gets.
 */
export function dedupeEnvironmentNames(
  environment: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const seen = new Map<string, string>();
  const spelled = new Map<string, string>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) spelled.set(key, name);
    seen.set(key, value);
  }
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of seen) next[spelled.get(key) ?? key] = value;
  return next;
}
