import type { EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { PersonalPorts } from "./ports/personalPorts.ts";
import { useAtomCommand } from "./react/command.ts";
import { useEnvironmentQuery } from "./react/query.ts";

export interface PersonalHost {
  readonly useActiveEnvironmentId: () => EnvironmentId | null;
  readonly usePrimaryEnvironmentId: () => EnvironmentId | null;
}

export interface PersonalClient<R, ER, BlobPayload> {
  readonly runtime: Atom.AtomRuntime<R, ER>;
  readonly ports: PersonalPorts<BlobPayload>;
  readonly host: PersonalHost;
  readonly useEnvironmentQuery: typeof useEnvironmentQuery;
  readonly useAtomCommand: typeof useAtomCommand;
}

export function createPersonalClient<R, ER, BlobPayload>(
  runtime: Atom.AtomRuntime<R, ER>,
  ports: PersonalPorts<BlobPayload>,
  host: PersonalHost,
): PersonalClient<R, ER, BlobPayload> {
  return { runtime, ports, host, useEnvironmentQuery, useAtomCommand };
}
