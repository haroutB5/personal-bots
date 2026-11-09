// One prepared fixture per test: the cleanup is registered on the test context before the prepare
// assertion, so a failed prepare cannot leave a started unit behind.
import * as NodeAssert from "node:assert/strict";
import { makeEnv } from "./env.mjs";

export async function prepared(t, opts = {}, setup) {
  const env = await makeEnv(opts);
  t.after(() => env.stop());
  env.start();
  env.target(opts.target);
  await setup?.(env);
  env.writePins();
  const r = env.runner("--prepare");
  NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
  return env;
}
