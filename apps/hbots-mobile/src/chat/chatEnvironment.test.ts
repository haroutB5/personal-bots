import {
  EnvironmentId,
  ProjectId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createProjectRootAtom } from "./chatEnvironment.ts";

const ENVIRONMENT = EnvironmentId.make("env-laptop");
const PROJECT = ProjectId.make("project-personal");
const PERSONAL_ROOT = "/home/harout/.personal-bots/dev/personal-workspace";

function project(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: PROJECT,
    title: "Personal",
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
  };
}

function snapshot(
  overrides: Partial<OrchestrationV2ShellSnapshot> = {},
): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    threads: [],
    archivedThreads: [],
    projects: [project(PERSONAL_ROOT)],
    ...overrides,
  };
}

describe("projectRootAtom", () => {
  it("reads the project's folder and stays null for an unknown id", () => {
    const source = Atom.make<OrchestrationV2ShellSnapshot | null>(snapshot());
    const projectRoot = createProjectRootAtom(() => source);
    const registry = AtomRegistry.make();
    try {
      expect(registry.get(projectRoot(ENVIRONMENT, PROJECT))).toBe(PERSONAL_ROOT);
      expect(registry.get(projectRoot(ENVIRONMENT, ProjectId.make("project-other")))).toBeNull();
      expect(registry.get(projectRoot(ENVIRONMENT, null))).toBeNull();
    } finally {
      registry.dispose();
    }
  });

  it("does not emit when only unrelated snapshot fields change", () => {
    const source = Atom.make<OrchestrationV2ShellSnapshot | null>(snapshot());
    const projectRoot = createProjectRootAtom(() => source);
    const registry = AtomRegistry.make();
    const root = projectRoot(ENVIRONMENT, PROJECT);
    const seen: Array<string | null> = [];
    const stop = registry.subscribe(root, (value) => seen.push(value), { immediate: true });
    try {
      registry.set(source, snapshot({ snapshotSequence: 2 }));
      expect(seen).toEqual([PERSONAL_ROOT]);
      registry.set(source, snapshot({ projects: [project("/home/harout/Claude/AI/_wt/moved")] }));
      expect(seen).toEqual([PERSONAL_ROOT, "/home/harout/Claude/AI/_wt/moved"]);
    } finally {
      stop();
      registry.dispose();
    }
  });
});
