import { layerOf } from "../adapters.ts";
import { makeGithubAdapter } from "./github.ts";
import { makeNeonAdapter } from "./neon.ts";
import { makeUpstashAdapter } from "./upstash.ts";
import { makeFetchVendorHttp } from "./vendorHttp.ts";
import { makeVercelAdapter } from "./vercel.ts";

/**
 * The adapters that ship. A vendor absent from this list is refused by name at
 * the gateway rather than half-executed; so is an operation whose vendor is
 * here but which its adapter does not speak for, which is what
 * `neon.run_sql` and `upstash.redis_command` still are.
 */
const http = makeFetchVendorHttp();

export const layer = layerOf([
  makeGithubAdapter(http),
  makeVercelAdapter(http),
  makeNeonAdapter(http),
  makeUpstashAdapter(http),
]);
