import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";
import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";
import { scopeProject } from "@t3tools/client-runtime/state/models";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
  createThreadEnvironmentAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadStatus,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { toChatThread, type ChatThread } from "@hbots/personal-client/conversation/chatThread";

export type ChatEnvironment = ReturnType<typeof createChatEnvironment>;

/**
 * The project's folder, projected to one string. The shell snapshot is rebuilt
 * with every streamed message, so views read the folder rather than the
 * snapshot and stay put while the projects themselves do not move.
 */
export function createProjectRootAtom(
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  const family = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((projectId: ProjectId | null) =>
      Atom.make((get): string | null => {
        if (projectId === null) return null;
        const snapshot = get(snapshotAtom(environmentId));
        return (
          snapshot?.projects.find((project) => project.id === projectId)?.workspaceRoot ?? null
        );
      }).pipe(Atom.withLabel(`native-project-root:${environmentId}:${projectId ?? "none"}`)),
    ),
  );
  return (environmentId: EnvironmentId, projectId: ProjectId | null) =>
    family(environmentId)(projectId);
}

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
  const projects = createProjectEnvironmentAtoms(native.runtime, {
    projectAtom: (ref) =>
      Atom.make((get) => {
        const project = get(snapshotAtom(ref.environmentId))?.projects.find(
          (candidate) => candidate.id === ref.projectId,
        );
        return project === undefined ? null : scopeProject(ref.environmentId, project);
      }),
  });
  return {
    states,
    details,
    thread,
    attachments,
    assets,
    projects,
    projectRootAtom: createProjectRootAtom(snapshotAtom),
  };
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
  readonly thread: ChatThread | null;
  readonly status: EnvironmentThreadStatus;
  readonly state: EnvironmentThreadState;
  readonly error: unknown;
}

export function useThreadDetailView(
  chat: ChatEnvironment,
  ref: ScopedThreadRef | null,
): ThreadDetailView {
  const emptyThread = useMemo(
    () =>
      Atom.make<{ readonly projection: OrchestrationV2ThreadProjection } | null>(null).pipe(
        Atom.withLabel("native-thread:none"),
      ),
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
  const rawThread = useAtomValue(ref === null ? emptyThread : chat.details.threadAtom(ref));
  const environmentId = ref?.environmentId ?? null;
  const thread = useMemo(
    () =>
      rawThread === null || environmentId === null
        ? null
        : toChatThread(environmentId, rawThread.projection),
    [environmentId, rawThread],
  );
  const status = useAtomValue(ref === null ? emptyStatus : chat.details.statusAtom(ref));
  const state = useAtomValue(ref === null ? emptyState : chat.details.stateAtom(ref));
  const error = useAtomValue(ref === null ? emptyError : chat.details.errorAtom(ref));
  return { thread, status, state, error };
}
