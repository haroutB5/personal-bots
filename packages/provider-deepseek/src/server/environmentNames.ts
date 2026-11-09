/**
 * Case-insensitive environment names, one entry per name: the last value wins
 * under the first spelling seen. A child that inherits `Path` and `PATH` breaks
 * PowerShell 5.1 inside a dsh tool with a duplicate-key error.
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
