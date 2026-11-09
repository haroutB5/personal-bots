import type { TabName } from "../nav/routes";

/** Where the chat's Computer link goes: the Computer tab, as the web header does. */
export function chatComputerTarget(): { readonly tab: TabName } {
  return { tab: "computer" };
}
