/**
 * Routing rules for the personal Bots shell and the "Developer view" escape
 * hatch to the upstream T3 UI.
 *
 * Developer view is tab-scoped (sessionStorage): choosing it keeps `/` on the
 * upstream workspace for the rest of the session, and a fresh launch lands on
 * `/bots` again. The upstream routes themselves are always reachable by URL.
 */

export type PersonalTab = "chats" | "tasks" | "computer" | "files";

export const PERSONAL_TABS: ReadonlyArray<{
  readonly tab: PersonalTab;
  readonly label: string;
  readonly to: "/bots" | "/tasks" | "/computer" | "/files";
}> = [
  { tab: "chats", label: "Chats", to: "/bots" },
  { tab: "tasks", label: "Tasks", to: "/tasks" },
  { tab: "computer", label: "Computer", to: "/computer" },
  { tab: "files", label: "Files", to: "/files" },
];

const DEVELOPER_VIEW_KEY = "t3.personal.developerView";

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** Paths rendered by the personal shell instead of the upstream sidebar layout. */
export function isPersonalPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return (
    path === "/bots" ||
    path.startsWith("/bots/") ||
    path === "/tasks" ||
    path.startsWith("/tasks/") ||
    path === "/computer" ||
    path === "/files"
  );
}

/** Tab highlighted for a path; `null` hides the tab bar (focused editors). */
export function activeTabFor(pathname: string): PersonalTab | null {
  const path = normalizePath(pathname);
  if (path === "/bots" || path === "/bots/settings" || path === "/bots/team") return "chats";
  // Task and routine detail keep the tab bar; the routine editor is focused.
  if (path === "/tasks" || (path.startsWith("/tasks/") && !isRoutineEditorPath(path))) {
    return "tasks";
  }
  if (path === "/computer") return "computer";
  if (path === "/files") return "files";
  return null;
}

function isRoutineEditorPath(path: string): boolean {
  return path === "/tasks/routines/new" || /^\/tasks\/routines\/[^/]+\/edit$/.test(path);
}

/**
 * How a routed screen sits in the desktop pane (md+, right of the bot list).
 * The phone never reads this: there every screen fills the column.
 *
 * - `conversation`: a chat. It fills the whole pane and centres its own
 *   header, messages and composer on the reading column, so the scroller and
 *   the composer's rule run edge to edge instead of floating in a box.
 * - `column`: lists and detail screens (Tasks, Files, Computer, a bot's chats,
 *   Team) in the reading column, centred in the pane.
 * - `form`: editors and settings, in a narrower centred column.
 */
export type DesktopPaneLayout = "conversation" | "column" | "form";

export function desktopPaneLayout(pathname: string): DesktopPaneLayout {
  const path = normalizePath(pathname);
  if (path === "/bots/settings" || path.startsWith("/bots/settings/")) return "form";
  if (path === "/bots/new" || path === "/bots/groups/new" || /^\/bots\/[^/]+\/edit$/.test(path)) {
    return "form";
  }
  if (isRoutineEditorPath(path)) return "form";
  if (/^\/bots\/groups\/[^/]+$/.test(path)) return "conversation";
  if (/^\/bots\/[^/]+\/[^/]+$/.test(path)) return "conversation";
  return "column";
}

/**
 * Which row the desktop bot list (md+) marks as open, read off the route
 * params. A bot's chat (any of its threads, not only the newest one the row
 * links to), its chats list and its editor select that bot; a group chat
 * selects the group. Team/home, settings, the new bot/group forms, Tasks,
 * Files and Computer carry neither param and select nothing.
 *
 * A key rather than an object so the router `select` stays a primitive (no
 * re-render per navigation) and a row compares one string.
 */
export type SidebarSelectionKey = `bot:${string}` | `group:${string}`;

export function sidebarSelectionKey(params: {
  readonly botId?: string | undefined;
  readonly groupId?: string | undefined;
}): SidebarSelectionKey | null {
  if (params.groupId) return groupSelectionKey(params.groupId);
  if (params.botId) return botSelectionKey(params.botId);
  return null;
}

export function botSelectionKey(botId: string): SidebarSelectionKey {
  return `bot:${botId}`;
}

export function groupSelectionKey(groupId: string): SidebarSelectionKey {
  return `group:${groupId}`;
}

export function readDeveloperView(): boolean {
  try {
    return window.sessionStorage.getItem(DEVELOPER_VIEW_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDeveloperView(enabled: boolean): void {
  try {
    if (enabled) {
      window.sessionStorage.setItem(DEVELOPER_VIEW_KEY, "1");
    } else {
      window.sessionStorage.removeItem(DEVELOPER_VIEW_KEY);
    }
  } catch {
    // Storage unavailable (private mode): Developer view still opens once via
    // the link; the next visit to `/` simply returns to Bots.
  }
}
