/**
 * Which tab a bot's request means, and which tabs a saved login must close.
 * Pure functions over the tab list; the service keeps the pages and the lease.
 */

/** A tab as the policy sees it: who owns it and the page behind it. */
export interface PolicyTab<Page> {
  readonly threadId: string;
  readonly page: Page;
}

/**
 * The newest open tab a thread has. Tabs are kept in the order they were
 * opened, so the last one that is still open wins.
 */
export const latestOpenTab = <Page, Tab extends PolicyTab<Page>>(
  tabs: Iterable<Tab>,
  threadId: string,
  isOpen: (page: Page) => boolean,
): Tab | undefined => {
  let latest: Tab | undefined;
  for (const tab of tabs) {
    if (tab.threadId === threadId && isOpen(tab.page)) latest = tab;
  }
  return latest;
};

export interface TabRequest {
  readonly tabId?: string | undefined;
  /** The caller named this tab itself, rather than inheriting it from an earlier call. */
  readonly tabIdExplicit?: boolean | undefined;
  readonly threadId: string;
}

/**
 * The tab a request acts on. A named tab must belong to the caller's thread and
 * still be open. An explicit tab that is gone stays an error (no tab); an
 * inherited one falls back to the thread's newest open tab.
 */
export const resolveTabForRequest = <Page, Tab extends PolicyTab<Page>>(input: {
  readonly tabsById: ReadonlyMap<string, Tab>;
  readonly request: TabRequest;
  readonly isOpen: (page: Page) => boolean;
}): Tab | undefined => {
  const { request, tabsById, isOpen } = input;
  if (request.tabId !== undefined) {
    const tab = tabsById.get(request.tabId);
    if (tab !== undefined && tab.threadId === request.threadId && isOpen(tab.page)) return tab;
    if (request.tabIdExplicit === true) return undefined;
  }
  return latestOpenTab(tabsById.values(), request.threadId, isOpen);
};

/**
 * The tabs a login on one origin must close first: every open tab, of every
 * thread, whose address can see the cookies the login creates, except the tab
 * the login goes into. `about:blank` can see nothing.
 */
export const tabsInCookieScope = <Page, Tab extends PolicyTab<Page>>(input: {
  readonly tabs: Iterable<Tab>;
  readonly except: Tab;
  readonly isOpen: (page: Page) => boolean;
  readonly urlOf: (page: Page) => string;
  readonly covers: (url: string) => boolean;
}): Array<Tab> =>
  [...input.tabs].filter(
    (tab) =>
      tab !== input.except &&
      input.isOpen(tab.page) &&
      input.urlOf(tab.page) !== "about:blank" &&
      input.covers(input.urlOf(tab.page)),
  );

/** A help request ends when another chat starts using the browser. */
export const helpEndsOnAgentSwitch = (
  activeHelpThreadId: string | null,
  requestingThreadId: string,
): boolean => activeHelpThreadId !== null && activeHelpThreadId !== requestingThreadId;
