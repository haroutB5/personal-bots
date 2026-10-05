import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { ServerConfig } from "./config.ts";
import {
  buildPairingUrl,
  formatHeadlessServeLogOutput,
  formatHeadlessServeOutput,
  prepareHeadlessServeOutput,
  renderTerminalQrCode,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
  shouldPrintStartupToken,
} from "./startupAccess.ts";

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

const QR_BLOCKS = /[█▀▄]/;

it("prints the startup token only to an interactive console or on the explicit override", () => {
  expect(shouldPrintStartupToken({ isTTY: true }, {})).toBe(true);
  expect(shouldPrintStartupToken({ isTTY: false }, {})).toBe(false);
  expect(shouldPrintStartupToken({}, {})).toBe(false);
  expect(shouldPrintStartupToken({}, { T3CODE_STARTUP_PRINT_TOKEN: "on" })).toBe(true);
  expect(shouldPrintStartupToken({}, { T3CODE_STARTUP_PRINT_TOKEN: "off" })).toBe(false);
});

it("formats the non-console output with the connection string and a pair.ps1 hint only", () => {
  const output = formatHeadlessServeLogOutput("http://192.168.1.42:3773");

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("pair.ps1");
  expect(output).not.toContain("Token:");
  expect(output).not.toContain("Pairing URL");
  expect(output).not.toContain("#token=");
  expect(QR_BLOCKS.test(output)).toBe(false);
});

const runPrepare = (printToken: boolean) => {
  let issued = 0;
  const auth = {
    issueStartupPairingCredential: () =>
      Effect.sync(() => {
        issued += 1;
        return {
          id: "link-1",
          credential: "SECRETPAIRCODE",
          label: undefined,
          expiresAt: undefined,
        };
      }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  const httpServer = HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 4123),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
  const config = { host: "127.0.0.1", port: 3773 } as unknown as ServerConfig["Service"];
  return prepareHeadlessServeOutput(printToken).pipe(
    Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
    Effect.provideService(HttpServer.HttpServer, httpServer),
    Effect.provideService(ServerConfig, config),
    Effect.map((output) => ({ output, issued })),
  );
};

it.effect("a console start prints the token, the pairing URL and the QR code", () =>
  Effect.gen(function* () {
    const { output, issued } = yield* runPrepare(true);

    expect(issued).toBe(1);
    expect(output).toContain("Connection string: http://127.0.0.1:4123");
    expect(output).toContain("Token: SECRETPAIRCODE");
    expect(output).toContain("Pairing URL: http://127.0.0.1:4123/pair#token=SECRETPAIRCODE");
    expect(QR_BLOCKS.test(output)).toBe(true);
  }),
);

it.effect("a start with output going to a file never contains or mints the credential", () =>
  Effect.gen(function* () {
    const { output, issued } = yield* runPrepare(false);

    expect(issued).toBe(0);
    expect(output).toContain("Connection string: http://127.0.0.1:4123");
    expect(output).toContain("pair.ps1");
    expect(output).not.toContain("SECRETPAIRCODE");
    expect(output).not.toContain("Token:");
    expect(output).not.toContain("#token=");
    expect(QR_BLOCKS.test(output)).toBe(false);
  }),
);
