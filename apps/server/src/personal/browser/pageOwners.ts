import type { BrowserPage } from "./driver.ts";

/**
 * Who a page belongs to. Only a page hbots opened for a thread is `bot`.
 * Every other page in the browser, however it appeared, is `owner`.
 */
export type PageOwner =
  | { readonly kind: "bot"; readonly threadId: string }
  | { readonly kind: "owner" };

export interface PageOwners {
  readonly recordBot: (page: BrowserPage, threadId: string) => void;
  readonly ownerOf: (page: BrowserPage) => PageOwner;
}

export const makePageOwners = (): PageOwners => {
  const bots = new WeakMap<BrowserPage, string>();
  return {
    recordBot: (page, threadId) => {
      bots.set(page, threadId);
    },
    ownerOf: (page) => {
      const threadId = bots.get(page);
      return threadId === undefined ? { kind: "owner" } : { kind: "bot", threadId };
    },
  };
};
