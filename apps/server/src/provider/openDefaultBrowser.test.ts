import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildDefaultBrowserLaunch,
  makeOpenInDefaultBrowser,
  type DefaultBrowserLaunch,
} from "./openDefaultBrowser.ts";

const url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s";

it("uses the OS default-browser handler with an argument array and no shell", () => {
  assert.deepEqual(buildDefaultBrowserLaunch(url, "win32", "rundll32.exe"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
  assert.deepEqual(buildDefaultBrowserLaunch(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(buildDefaultBrowserLaunch(url, "linux"), { command: "xdg-open", args: [url] });
});

it.effect("launches an https link once and refuses other schemes", () =>
  Effect.gen(function* () {
    const launches: DefaultBrowserLaunch[] = [];
    const open = makeOpenInDefaultBrowser({
      platform: "linux",
      spawn: (launch) => Promise.resolve(void launches.push(launch)),
    });
    yield* open(url);
    assert.deepEqual(launches, [{ command: "xdg-open", args: [url] }]);

    for (const refused of [
      "http://accounts.google.com/",
      "file:///C:/x",
      "javascript:1",
      "nope",
      "https://evil.example/o/oauth2/v2/auth",
      "https://accounts.google.com.evil.example/o/oauth2/v2/auth",
      "https://accounts.google.com/other",
      "https://user@accounts.google.com/o/oauth2/v2/auth",
      `${url} bad`,
      `${url}${"a".repeat(16_384)}`,
    ]) {
      const error = yield* open(refused).pipe(Effect.flip);
      assert.equal(error.reason, "not-https");
    }
    assert.equal(launches.length, 1);
  }),
);

it.effect("canonicalizes quotes before handing a URL to the OS", () =>
  Effect.gen(function* () {
    const launches: DefaultBrowserLaunch[] = [];
    const open = makeOpenInDefaultBrowser({
      platform: "win32",
      spawn: (launch) => Promise.resolve(void launches.push(launch)),
    });
    yield* open(`${url}&quoted="value"`);
    assert.equal(launches[0]?.args[1], `${url}&quoted=%22value%22`);
  }),
);

it.effect("reports a failed launch without the link", () =>
  Effect.gen(function* () {
    const open = makeOpenInDefaultBrowser({
      platform: "linux",
      spawn: () => Promise.reject(new Error(`spawn failed for ${url}`)),
    });
    const error = yield* open(url).pipe(Effect.flip);
    assert.equal(error.reason, "launch-failed");
    assert.notInclude(
      `${error._tag} ${error.reason} ${String(error.message)}`,
      "accounts.google.com",
    );
  }),
);
