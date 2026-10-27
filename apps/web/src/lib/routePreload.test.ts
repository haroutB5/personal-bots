import { describe, expect, it } from "vite-plus/test";

import { ROUTE_PRELOADS, routePreloadScript } from "../../vite/routePreload";

function chunk(
  fileName: string,
  facadeModuleId: string | null,
  imports: string[],
  isEntry = false,
) {
  return { type: "chunk" as const, fileName, facadeModuleId, imports, isEntry };
}

const ROUTE = "/repo/apps/web/src/routes/";
const bundle = {
  "assets/index.js": chunk("assets/index.js", "/repo/apps/web/index.html", [], true),
  "assets/main.js": chunk("assets/main.js", "/repo/apps/web/src/main.tsx", [
    "assets/index.js",
    "assets/utils.js",
  ]),
  "assets/utils.js": chunk("assets/utils.js", null, []),
  "assets/personal.js": chunk("assets/personal.js", `${ROUTE}_personal.tsx?tsr-split=component`, [
    "assets/utils.js",
    "assets/shared.js",
  ]),
  "assets/shared.js": chunk("assets/shared.js", null, []),
  "assets/chat.js": chunk(
    "assets/chat.js",
    `${ROUTE}_personal.bots_.$botId.$threadId.tsx?tsr-split=component`,
    ["assets/shared.js", "assets/markdown.js"],
  ),
  "assets/markdown.js": chunk("assets/markdown.js", null, []),
  "assets/list.js": chunk("assets/list.js", `${ROUTE}_personal.bots.tsx?tsr-split=component`, []),
  "assets/bot.js": chunk(
    "assets/bot.js",
    `${ROUTE}_personal.bots_.$botId.index.tsx?tsr-split=component`,
    [],
  ),
  "favicon.ico": { type: "asset" as const },
};

function payload(script: string) {
  const json = script.slice(script.lastIndexOf("})(") + 3, -2);
  return JSON.parse(json) as { base: string; main: string[]; routes: [string, string[]][] };
}

function routeFor(pathname: string): number {
  return ROUTE_PRELOADS.findIndex((preload) => preload.path.test(pathname));
}

describe("routePreloadScript", () => {
  it("lists main's closure once and each route's extra chunks", () => {
    const script = routePreloadScript(bundle, "/");
    expect(script).not.toBeNull();
    const data = payload(script!);
    expect(data.main.toSorted()).toEqual(["assets/main.js", "assets/utils.js"]);
    expect(data.routes[0]![1].toSorted()).toEqual([
      "assets/chat.js",
      "assets/markdown.js",
      "assets/personal.js",
      "assets/shared.js",
    ]);
    expect(data.routes[1]![1].toSorted()).toEqual([
      "assets/list.js",
      "assets/personal.js",
      "assets/shared.js",
    ]);
  });

  it("writes no hints when a route chunk is missing", () => {
    const { ["assets/chat.js"]: _chat, ...rest } = bundle;
    expect(routePreloadScript(rest, "/")).toBeNull();
  });

  it("matches only the pages it preloads for", () => {
    expect(routeFor("/bots/bot-1/thread-1")).toBe(0);
    expect(routeFor("/bots")).toBe(1);
    expect(routeFor("/bots/")).toBe(1);
    expect(routeFor("/bots/bot-1")).toBe(2);
    for (const other of [
      "/bots/bot-1/edit",
      "/bots/groups/g-1",
      "/bots/groups/new",
      "/bots/settings/memory",
      "/bots/teams/new",
      "/bots/new",
      "/bots/team",
      "/bots/settings",
      "/tasks",
      "/",
    ]) {
      expect(routeFor(other), other).toBe(-1);
    }
  });
});
