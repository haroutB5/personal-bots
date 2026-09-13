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
  if (path === "/bots" || path === "/bots/settings") return "chats";
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
