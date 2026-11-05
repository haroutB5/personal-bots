import { createPersonalClient, type PersonalClient } from "@hbots/personal-client/client";
import type { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useActiveEnvironmentId } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { webPorts } from "./platform/webPorts";

type WebPersonalClient =
  typeof connectionAtomRuntime extends Atom.AtomRuntime<infer R, infer ER>
    ? PersonalClient<R, ER, Blob>
    : never;

export const personalClient: WebPersonalClient = createPersonalClient(
  connectionAtomRuntime,
  webPorts,
  {
    // Read through the module bindings at call time: tests and the router can
    // replace `~/state/entities` after this module loads.
    useActiveEnvironmentId: () => useActiveEnvironmentId(),
    usePrimaryEnvironmentId: () => usePrimaryEnvironmentId(),
  },
);
