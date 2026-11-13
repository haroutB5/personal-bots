import type * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import {
  acceptsPrivateNetworkConnection,
  formatHeadlessServeLogOutput,
  prepareHeadlessServeOutput,
  loopbackUrlHostForAddress,
  resolveHeadlessConnectionString,
  shouldPrintStartupToken,
} from "./startupAccess.ts";

const ipv4 = (address: string, internal = false): NodeOS.NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    interfaces: { en0: [ipv4("192.168.1.42")], lo0: [ipv4("127.0.0.1", true)] },
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("skips public and container addresses for a private-network listener", () => {
  const interfaces = {
    eth0: [ipv4("203.0.113.7")],
    docker0: [ipv4("172.17.0.1")],
    bridge200: [ipv4("192.168.64.1")],
    eth1: [ipv4("10.0.0.5")],
  };

  expect(resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces })).toBe(
    "http://203.0.113.7:3773",
  );
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces, privateNetworkOnly: true }),
  ).toBe("http://10.0.0.5:3773");
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { eth0: [ipv4("203.0.113.7")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://localhost:3773");
});

it("prefers a LAN address over a tailnet one for a private-network pairing URL", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { tailscale0: [ipv4("100.101.102.103")], en0: [ipv4("192.168.1.42")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://192.168.1.42:3773");
});

it("targets the bound interface when the listener binds a specific address", () => {
  const hostFor = (ip: string) =>
    loopbackUrlHostForAddress(NetAddress.inetAddressFromIpStringUnsafe(ip, 3773));

  expect(hostFor("0.0.0.0")).toBe("127.0.0.1");
  expect(hostFor("::")).toBe("127.0.0.1");
  expect(hostFor("::1")).toBe("[::1]");
  expect(hostFor("127.0.0.1")).toBe("127.0.0.1");
  expect(hostFor("127.0.0.2")).toBe("127.0.0.2");
  expect(hostFor("100.101.102.103")).toBe("100.101.102.103");
});

describe("acceptsPrivateNetworkConnection", () => {
  const accepts = (localAddress: string | undefined, remoteAddress: string | undefined) =>
    acceptsPrivateNetworkConnection({ localAddress, remoteAddress });

  it("serves loopback, LAN, and tailnet clients", () => {
    expect(accepts("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(accepts("::ffff:192.168.1.20", "::ffff:192.168.1.31")).toBe(true);
    expect(accepts("100.101.102.103", "100.90.1.2")).toBe(true);
  });

  it("closes connections from or to a public address", () => {
    // A cloud VM's public address is NATed to a private interface address.
    expect(accepts("172.31.4.10", "203.0.113.7")).toBe(false);
    expect(accepts("203.0.113.7", "192.168.1.31")).toBe(false);
    expect(accepts("169.254.10.1", "169.254.10.2")).toBe(false);
    expect(accepts(undefined, "192.168.1.31")).toBe(false);
  });
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
  const httpServer = HttpServer.make({
    address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 4123),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
  const config = {
    host: "127.0.0.1",
    port: 3773,
  } as unknown as ServerConfig.ServerConfig["Service"];
  return prepareHeadlessServeOutput(printToken).pipe(
    Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
    Effect.provideService(HttpServer.HttpServer, httpServer),
    Effect.provideService(ServerConfig.ServerConfig, config),
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
