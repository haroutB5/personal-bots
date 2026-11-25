// @effect-diagnostics nodeBuiltinImport:off - local 0600 hook env files use atomic Node fs operations.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const ROUTINE_HOOKS_DIR = "routine-hooks";

const SAFE_ROUTINE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Returns `<baseDir>/personal/routine-hooks/<routineId>.env` after validating
 * that `routineId` is a safe single-segment basename (no traversal or slashes).
 */
export function routineHookEnvPath(baseDir: string, routineId: string): string {
  if (
    routineId.length === 0 ||
    routineId === "." ||
    routineId === ".." ||
    NodePath.basename(routineId) !== routineId ||
    !SAFE_ROUTINE_ID.test(routineId)
  ) {
    throw new Error(`Invalid routineId for hook env path: '${routineId}'.`);
  }
  return NodePath.join(baseDir, "personal", ROUTINE_HOOKS_DIR, `${routineId}.env`);
}

/**
 * Atomically writes `<baseDir>/personal/routine-hooks/<routineId>.env` (`0o600`
 * inside a `0o700` directory) containing `HBOTS_HOOK_URL=http://127.0.0.1:<port>/api/personal/hooks/<hookToken>\n`.
 */
export async function writeRoutineHookEnv(
  baseDir: string,
  port: number,
  routineId: string,
  hookToken: string,
): Promise<string> {
  const envPath = routineHookEnvPath(baseDir, routineId);
  const dir = NodePath.dirname(envPath);
  await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(dir, 0o700);
  const tmpPath = `${envPath}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  const content = `HBOTS_HOOK_URL=http://127.0.0.1:${port}/api/personal/hooks/${hookToken}\n`;
  try {
    await NodeFSP.writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    await NodeFSP.chmod(tmpPath, 0o600);
    await NodeFSP.rename(tmpPath, envPath);
  } catch (error) {
    await NodeFSP.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
  return envPath;
}

/** Removes the routine's hook env file if present (ignores ENOENT). */
export async function removeRoutineHookEnv(baseDir: string, routineId: string): Promise<void> {
  const envPath = routineHookEnvPath(baseDir, routineId);
  await NodeFSP.unlink(envPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
