import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";
import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
  createThreadEnvironmentAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadStatus,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";

export type ChatEnvironment = ReturnType<typeof createChatEnvironment>;

export function createChatEnvironment(native: NativePersonal) {
  const states = createEnvironmentThreadStateAtoms(native.runtime);
  const details = createEnvironmentThreadDetailAtoms(states.stateAtom);
  const snapshotAtom = (environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrNull(get(native.shell.stateValueAtom(environmentId)).snapshot),
    ).pipe(Atom.withLabel(`native-shell-snapshot:${environmentId}`));
  const thread = createThreadEnvironmentAtoms(native.runtime, snapshotAtom);
  const attachments = createAttachmentEnvironmentAtoms(native.runtime);
  const assets = createAssetEnvironmentAtoms(native.runtime);
  return { states, details, thread, attachments, assets };
}

export function useThreadRef(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): ScopedThreadRef | null {
  return useMemo(
    () =>
      environmentId === null || threadId === null
        ? null
        : scopeThreadRef(environmentId, threadId as ThreadId),
    [environmentId, threadId],
  );
}

export interface ThreadDetailView {
  readonly thread: EnvironmentThread | null;
  readonly status: EnvironmentThreadStatus;
  readonly state: EnvironmentThreadState;
  readonly error: unknown;
}

export function useThreadDetailView(
  chat: ChatEnvironment,
  ref: ScopedThreadRef | null,
): ThreadDetailView {
  const emptyThread = useMemo(
    () => Atom.make<EnvironmentThread | null>(null).pipe(Atom.withLabel("native-thread:none")),
    [],
  );
  const emptyStatus = useMemo(
    () =>
      Atom.make<EnvironmentThreadStatus>("empty").pipe(Atom.withLabel("native-thread-status:none")),
    [],
  );
  const emptyState = useMemo(
    () =>
      Atom.make(EMPTY_ENVIRONMENT_THREAD_STATE).pipe(Atom.withLabel("native-thread-state:none")),
    [],
  );
  const emptyError = useMemo(
    () => Atom.make<unknown>(null).pipe(Atom.withLabel("native-thread-error:none")),
    [],
  );
  const thread = useAtomValue(ref === null ? emptyThread : chat.details.detailAtom(ref));
  const status = useAtomValue(ref === null ? emptyStatus : chat.details.statusAtom(ref));
  const state = useAtomValue(ref === null ? emptyState : chat.details.stateAtom(ref));
  const error = useAtomValue(ref === null ? emptyError : chat.details.errorAtom(ref));
  return { thread, status, state, error };
}
