import { describe, expect, it } from "vite-plus/test";

import { resolveChatCwd } from "./chatCwd";

const projects = [
  { id: "project-personal", workspaceRoot: "/home/harout/.personal-bots/dev/personal-workspace" },
];

describe("resolveChatCwd", () => {
  it("uses the worktree of a project chat", () => {
    expect(
      resolveChatCwd(
        { projectId: "project-personal", worktreePath: "/home/harout/Claude/AI/_wt/x" },
        projects,
      ),
    ).toBe("/home/harout/Claude/AI/_wt/x");
  });

  it("falls back to the personal project's workspace root when the chat has no worktree", () => {
    expect(resolveChatCwd({ projectId: "project-personal", worktreePath: null }, projects)).toBe(
      "/home/harout/.personal-bots/dev/personal-workspace",
    );
  });

  it("has no folder when the project is not in the shell yet", () => {
    expect(resolveChatCwd({ projectId: "project-other", worktreePath: null }, projects)).toBeNull();
  });
});
