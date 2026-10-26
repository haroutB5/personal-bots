import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { expect, it } from "vite-plus/test";

import * as Net from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as PortScanner from "./PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";

const SS_PORT = 5173;

/** Real `ss -ltnpH` output, including a listener `ss` could not attribute. */
const SS_OUTPUT = [
  `LISTEN 0      511        127.0.0.1:${SS_PORT} 0.0.0.0:* users:(("node",pid=1234,fd=26))`,
  "LISTEN 0      4096      127.0.0.53%lo:53    0.0.0.0:*",
  'LISTEN 0      511        [::1]:4000          [::]:*  users:(("bun",pid=4321,fd=9))',
  "",
].join("\n");

const htmlFetch = (async () =>
  new Response("<html>ok</html>", {
    headers: { "content-type": "text/html" },
  })) as typeof globalThis.fetch;

const makeLayer = (input: { readonly ssWorks: boolean }) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (command: { readonly command: string }) =>
            command.command === "lsof"
              ? Effect.fail(
                  new ProcessRunner.ProcessSpawnError({
                    command: "lsof",
                    argumentCount: 6,
                    cause: new Error("spawn lsof ENOENT"),
                  }),
                )
              : input.ssWorks
                ? Effect.succeed({
                    stdout: SS_OUTPUT,
                    stderr: "",
                    code: 0,
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  })
                : Effect.fail(
                    new ProcessRunner.ProcessSpawnError({
                      command: "ss",
                      argumentCount: 1,
                      cause: new Error("spawn ss ENOENT"),
                    }),
                  ),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred: number) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, htmlFetch))),
      ),
    ),
  );

it("falls back to ss when lsof is not installed, with pid and process name", async () => {
  const program = Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    return yield* scanner.scan();
  }).pipe(Effect.provide(makeLayer({ ssWorks: true })));

  const found = await Effect.runPromise(program);
  const server = found.find((entry) => entry.port === SS_PORT);
  expect(server).toBeDefined();
  expect(server?.processName).toBe("node");
  expect(server?.pid).toBe(1234);
  // The v6 loopback listener is local too.
  expect(found.some((entry) => entry.port === 4000)).toBe(true);
  // systemd-resolved's 127.0.0.53%lo is not a loopback dev server.
  expect(found.some((entry) => entry.port === 53)).toBe(false);
});

it("still probes common ports when neither lsof nor ss exists", async () => {
  const program = Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    return yield* scanner.scan();
  }).pipe(Effect.provide(makeLayer({ ssWorks: false })));

  // No listener is open on the curated ports in this test, so the answer is
  // empty; what matters is that the scan completes instead of failing.
  await expect(Effect.runPromise(program)).resolves.toEqual([]);
});
