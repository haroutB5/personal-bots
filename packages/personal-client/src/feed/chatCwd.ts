/**
 * The folder a chat's files live under. A project chat uses its worktree; a
 * personal chat has no worktree, so its files resolve under the Personal
 * project's workspace root, exactly as the web viewer resolves them.
 */
export interface ChatFolderThread {
  readonly projectId: string;
  readonly worktreePath: string | null;
}

export interface ChatFolderProject {
  readonly id: string;
  readonly workspaceRoot: string;
}

export function resolveChatCwd(
  thread: ChatFolderThread | null,
  projects: ReadonlyArray<ChatFolderProject>,
): string | null {
  if (thread === null) return null;
  if (thread.worktreePath !== null) return thread.worktreePath;
  return projects.find((project) => project.id === thread.projectId)?.workspaceRoot ?? null;
}
