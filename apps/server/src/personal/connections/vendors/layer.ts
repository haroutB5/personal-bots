import { layerOf } from "../adapters.ts";
import { makeGithubAdapter } from "./github.ts";
import { makeFetchVendorHttp } from "./vendorHttp.ts";
import { makeVercelAdapter } from "./vercel.ts";

/**
 * The adapters that ship. A vendor absent from this list is refused by name at
 * the gateway rather than half-executed, which is what the catalog's Neon and
 * Upstash entries still are.
 */
const http = makeFetchVendorHttp();

export const layer = layerOf([makeGithubAdapter(http), makeVercelAdapter(http)]);
