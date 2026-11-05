/**
 * The personal RPC contract as JSON Schema.
 *
 * `WsPersonalRpcGroup` is the surface the web personal layer and the Android
 * app call, so its request, success and error schemas are a compatibility
 * contract. `serverGetConfig` and `serverRefreshProviders` ride in the server
 * group but the personal client depends on both, so they are snapshotted too.
 *
 * The snapshot is canonical: object keys are sorted, entries are sorted by tag,
 * and `$defs` are folded into each schema. Two runs over the same contract
 * produce byte-identical JSON.
 *
 * @module personalContractSnapshot
 */
import * as Schema from "effect/Schema";

import { WS_METHODS, WsPersonalRpcGroup, WsServerRpcGroup } from "./rpc.ts";

/** Server-group methods the personal client calls by name. */
export const PERSONAL_CONTRACT_EXTRA_METHODS = [
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverRefreshProviders,
] as const;

export type PersonalContractJson = unknown;

export interface PersonalContractEntry {
  readonly tag: string;
  readonly payload: PersonalContractJson;
  readonly success: PersonalContractJson;
  readonly error: PersonalContractJson;
}

export interface PersonalContractSnapshot {
  readonly entries: ReadonlyArray<PersonalContractEntry>;
}

export type PersonalContractDiffKind = "missing" | "added" | "changed";

export interface PersonalContractDiff {
  /** `tag/schema/field/...`, never an array index for the entry itself. */
  readonly path: string;
  readonly kind: PersonalContractDiffKind;
  readonly expected: unknown;
  readonly actual: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Sort object keys so serialization does not depend on schema construction order. */
export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isRecord(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
};

const schemaJson = (schema: Schema.Top): PersonalContractJson => {
  const document = Schema.toJsonSchemaDocument(schema);
  const definitions = document.definitions;
  const schemaJsonValue =
    definitions !== undefined && Object.keys(definitions).length > 0
      ? { ...document.schema, $defs: definitions }
      : document.schema;
  return canonicalize(schemaJsonValue);
};

const entryFor = (rpc: {
  readonly _tag: string;
  readonly payloadSchema: Schema.Top;
  readonly successSchema: Schema.Top;
  readonly errorSchema: Schema.Top;
}): PersonalContractEntry => ({
  tag: rpc._tag,
  payload: schemaJson(rpc.payloadSchema),
  success: schemaJson(rpc.successSchema),
  error: schemaJson(rpc.errorSchema),
});

/**
 * Every personal method plus the two server methods the personal client calls.
 * Sorted by tag so the golden reads as a list and diffs stay local.
 */
export const buildPersonalContractSnapshot = (): PersonalContractSnapshot => {
  const rpcs: Array<Parameters<typeof entryFor>[0]> = [];
  for (const rpc of WsPersonalRpcGroup.requests.values()) {
    rpcs.push(rpc);
  }
  for (const tag of PERSONAL_CONTRACT_EXTRA_METHODS) {
    const rpc = WsServerRpcGroup.requests.get(tag);
    if (rpc === undefined) {
      throw new Error(`personal contract: ${tag} is missing from WsServerRpcGroup`);
    }
    rpcs.push(rpc);
  }
  const entries = rpcs.map(entryFor).sort((left, right) => left.tag.localeCompare(right.tag));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.tag)) {
      throw new Error(`personal contract: duplicate method ${entry.tag}`);
    }
    seen.add(entry.tag);
  }
  return { entries };
};

export const serializePersonalContract = (snapshot: PersonalContractSnapshot): string =>
  `${JSON.stringify(snapshot, null, 2)}\n`;

/**
 * Read a golden file back. Rejects a file that is not the snapshot shape so a
 * hand-edited or half-written golden fails loudly instead of as a 1 MB diff.
 */
export const parsePersonalContract = (value: unknown): PersonalContractSnapshot => {
  if (!isRecord(value) || !Array.isArray(value["entries"])) {
    throw new Error("personal contract golden: expected an object with an entries array");
  }
  const entries = value["entries"].map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry["tag"] !== "string" ||
      !("payload" in entry) ||
      !("success" in entry) ||
      !("error" in entry)
    ) {
      throw new Error(`personal contract golden: entry ${index} is not a contract entry`);
    }
    return {
      tag: entry["tag"],
      payload: entry["payload"],
      success: entry["success"],
      error: entry["error"],
    };
  });
  return { entries };
};

const MAX_DIFFS = 100;

const walk = (
  expected: unknown,
  actual: unknown,
  path: string,
  diffs: Array<PersonalContractDiff>,
): void => {
  if (diffs.length >= MAX_DIFFS) {
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length && diffs.length < MAX_DIFFS; index += 1) {
      if (index >= expected.length) {
        diffs.push({ path, kind: "added", expected: undefined, actual: actual[index] });
        continue;
      }
      if (index >= actual.length) {
        diffs.push({ path, kind: "missing", expected: expected[index], actual: undefined });
        continue;
      }
      walk(expected[index], actual[index], `${path}/${index}`, diffs);
    }
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      if (diffs.length >= MAX_DIFFS) {
        return;
      }
      if (!(key in expected)) {
        diffs.push({
          path: `${path}/${key}`,
          kind: "added",
          expected: undefined,
          actual: actual[key],
        });
        continue;
      }
      if (!(key in actual)) {
        diffs.push({
          path: `${path}/${key}`,
          kind: "missing",
          expected: expected[key],
          actual: undefined,
        });
        continue;
      }
      walk(expected[key], actual[key], `${path}/${key}`, diffs);
    }
    return;
  }
  if (expected !== actual) {
    diffs.push({ path, kind: "changed", expected, actual });
  }
};

/**
 * Compare the golden with the live contract. Paths name the method and the
 * schema field, so a one-field change reports one line.
 */
export const diffPersonalContract = (
  expected: PersonalContractSnapshot,
  actual: PersonalContractSnapshot,
): ReadonlyArray<PersonalContractDiff> => {
  const diffs: Array<PersonalContractDiff> = [];
  const expectedByTag = new Map(expected.entries.map((entry) => [entry.tag, entry]));
  const actualByTag = new Map(actual.entries.map((entry) => [entry.tag, entry]));
  const tags = [...new Set([...expectedByTag.keys(), ...actualByTag.keys()])].sort();
  for (const tag of tags) {
    if (diffs.length >= MAX_DIFFS) {
      break;
    }
    const expectedEntry = expectedByTag.get(tag);
    const actualEntry = actualByTag.get(tag);
    if (expectedEntry === undefined) {
      diffs.push({ path: tag, kind: "added", expected: undefined, actual: actualEntry });
      continue;
    }
    if (actualEntry === undefined) {
      diffs.push({ path: tag, kind: "missing", expected: expectedEntry, actual: undefined });
      continue;
    }
    walk(expectedEntry.payload, actualEntry.payload, `${tag}/payload`, diffs);
    walk(expectedEntry.success, actualEntry.success, `${tag}/success`, diffs);
    walk(expectedEntry.error, actualEntry.error, `${tag}/error`, diffs);
  }
  return diffs;
};
