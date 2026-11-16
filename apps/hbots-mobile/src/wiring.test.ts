/**
 * The screens and App.tsx cannot be rendered in this node test setup, so these read the source
 * and check the calls that connect them to the chat-open and update-on-reconnect code. Each
 * check takes the text of one handler or call and looks for the call inside it, so a reformat
 * does not matter. They fail when a call is removed or retargeted.
 */
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const source = (relative: string) =>
  NodeFS.readFileSync(new URL(relative, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The text from the bracket at `open` to its match. Strings with brackets do not occur here. */
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[text[open]!]!;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === text[open]) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error(`no closing bracket for ${text.slice(open, open + 40)}`);
}

/** The bracketed text after each occurrence of `anchor`, which ends in its opening bracket. */
function after(text: string, anchor: string): string[] {
  const found: string[] = [];
  for (let at = text.indexOf(anchor); at !== -1; at = text.indexOf(anchor, at + 1)) {
    found.push(balanced(text, at + anchor.length - 1));
  }
  return found;
}

describe("a chat row press reaches the early snapshot request", () => {
  it("opens a chat from the chats list through pressChat, with the open as its callback", () => {
    const presses = after(source("./screens/ChatsListScreen.tsx"), "onPress={").filter((handler) =>
      handler.includes("pressChat("),
    );

    expect(presses).toHaveLength(1);
    expect(presses[0]).toMatch(/pressChat\(\s*item\.link\.threadId,\s*\(\) => onOpenChat\(/);
  });

  it("opens a chat from a bot tile through pressChat, with the open as its callback", () => {
    const bots = source("./shell/BotsScreen.tsx");
    const declaration = bots.indexOf("const openBot = ");
    const body = balanced(bots, bots.indexOf("{", bots.indexOf("=>", declaration)));
    const openBot = bots.split("const openBot = ").slice(1);

    expect(openBot).toHaveLength(1);
    expect(body).toMatch(/pressChat\(\s*tap\.threadId,\s*\(\) => onOpenChat\(/);
  });
});

describe("the chat screen holds its chat", () => {
  it("holds the chat in an effect while it has data", () => {
    const effects = after(source("./screens/ChatScreen.tsx"), "useEffect(").filter((effect) =>
      effect.includes("holdChat("),
    );

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatch(/hasThread \? holdChat\(threadId\) : undefined/);
  });
});

describe("the app checks for an update when the connection returns", () => {
  const app = source("./App.tsx");
  const effects = after(app, "useEffect(").filter((effect) => effect.includes("startReconnectCheck("));
  const options = effects.flatMap((effect) => after(effect, "startReconnectCheck("));

  it("starts it in an effect, once", () => {
    expect(effects).toHaveLength(1);
    expect(options).toHaveLength(1);
  });

  it("listens to the native client's connection and to the updater state", () => {
    expect(options[0]).toMatch(/connection:\s*\{\s*subscribe:\s*readyNative\.subscribeConnected\s*\}/);
    expect(options[0]).toMatch(/updates:\s*\{\s*subscribe:\s*subscribeUpdate\s*\}/);
  });

  it("starts the same update check the foreground and the timer start", () => {
    const check = after(options[0]!, "check: () => {");

    expect(check).toHaveLength(1);
    expect(check[0]).toMatch(/checkForUpdate\(session, false\)/);
  });

  it("is switched by android-update-on-reconnect and by no other name", () => {
    const names = [...options[0]!.matchAll(/androidPerfOptimizationOn\(\s*"([^"]+)"\s*\)/g)].map(
      (match) => match[1],
    );

    expect(names).toEqual(["android-update-on-reconnect"]);
    expect(options[0]).toMatch(/isOn:\s*\(\)\s*=>\s*androidPerfOptimizationOn\(/);
  });
});
