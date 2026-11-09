import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { isPrivateNetworkHost, isSharedAddressSpaceHost } from "@t3tools/shared/hostClassification";
import { QrCode } from "@t3tools/shared/qrCode";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "./config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly token: string;
  readonly pairingUrl: string;
}

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

/**
 * Container and VM networks (Docker, libvirt, VMware, VirtualBox, Hyper-V, and
 * macOS's `bridge100`+) have private addresses only this machine reaches. A
 * host bridge such as `br0` or Proxmox's `vmbr0` carries the LAN address, so
 * it stays listed.
 */
export const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|podman|cni|flannel|cali|lxcbr|lxdbr|bridge[1-9]\d\d)/;

/**
 * Loopback or private-range IPv4 (LAN, tailnet, CGNAT), not link-local, in
 * plain or IPv4-mapped IPv6 form.
 */
export const isPrivateNetworkAddress = (address: string): boolean => {
  const ipv4 = address.replace(/^::ffff:/i, "");
  return NodeNet.isIPv4(ipv4) && !ipv4.startsWith("169.254.") && isPrivateNetworkHost(ipv4);
};

/**
 * A private-network listener binds every interface but serves only
 * connections that stay on loopback, a LAN, or the tailnet. Both ends must be
 * private: a cloud VM or a router port forward hands public clients to a
 * private local address.
 */
export const acceptsPrivateNetworkConnection = (socket: {
  readonly localAddress?: string | undefined;
  readonly remoteAddress?: string | undefined;
}): boolean =>
  [socket.localAddress, socket.remoteAddress].every(
    (address) => address !== undefined && isPrivateNetworkAddress(address),
  );

export const loopbackUrlHostForAddress = (address: NetAddress.InetAddress): string =>
  address._tag === "InetAddressV6" && NetAddress.isLoopback(address.address)
    ? "[::1]"
    : "127.0.0.1";

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap,
  privateNetworkOnly: boolean,
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  const interfaceEntries = Object.entries(interfaces).flatMap(([name, entries]) =>
    privateNetworkOnly && VIRTUAL_INTERFACE.test(name) ? [] : (entries ?? []),
  );
  const externalIpv4Entries = interfaceEntries.filter(
    (entry) =>
      !entry.internal &&
      isIpv4Family(entry.family) &&
      (!privateNetworkOnly || isPrivateNetworkAddress(entry.address)),
  );
  // A tailnet or other CGNAT address reaches fewer devices than the LAN one.
  const externalIpv4 = privateNetworkOnly
    ? (externalIpv4Entries.find((entry) => !isSharedAddressSpaceHost(entry.address)) ??
      externalIpv4Entries[0])
    : externalIpv4Entries[0];
  if (externalIpv4) {
    return externalIpv4.address;
  }
  if (privateNetworkOnly) {
    return "localhost";
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
};

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  options: {
    readonly interfaces?: NetworkInterfacesMap;
    readonly privateNetworkOnly?: boolean | undefined;
  } = {},
): string => {
  const connectionHost = resolveHeadlessConnectionHost(
    host,
    options.interfaces ?? NodeOS.networkInterfaces(),
    options.privateNetworkOnly === true,
  );
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
};

const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};

export const buildPairingUrl = (connectionString: string, token: string): string => {
  const url = new URL(connectionString);
  url.pathname = "/pair";
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
};

export const renderTerminalQrCode = (value: string, margin = 2): string => {
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const rows: Array<string> = [];
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && x < qrCode.size && y >= 0 && y < qrCode.size && qrCode.getModule(x, y);

  for (let y = -margin; y < qrCode.size + margin; y += 2) {
    let row = "";

    for (let x = -margin; x < qrCode.size + margin; x += 1) {
      const topDark = isDark(x, y);
      const bottomDark = isDark(x, y + 1);

      row += topDark ? (bottomDark ? "█" : "▀") : bottomDark ? "▄" : " ";
    }

    rows.push(row);
  }

  return rows.join("\n");
};

const formatHeadlessServeOutput = (accessInfo: HeadlessServeAccessInfo): string =>
  [
    "T3 Code server is ready.",
    `Connection string: ${accessInfo.connectionString}`,
    `Token: ${accessInfo.token}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    `App link: ${buildPairingAppLink(accessInfo.pairingUrl)}`,
    "",
    renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ].join("\n");

/**
 * What `serve` prints when stdout is not an interactive console (a log file, a
 * pipe): the pairing token, URL and QR are credentials, so they stay out of it.
 */
export const formatHeadlessServeLogOutput = (connectionString: string): string =>
  [
    "T3 Code server is ready.",
    `Connection string: ${connectionString}`,
    "Pairing token not printed: output is not an interactive console.",
    "For a pairing link run scripts\\personal\\pair.ps1 (or `t3 pair`).",
    "",
  ].join("\n");

/**
 * Credentials are printed only to an interactive console. T3CODE_STARTUP_PRINT_TOKEN=on
 * restores the upstream behaviour for a headless host that reads its token from a log.
 */
export const shouldPrintStartupToken = (
  stdout: { readonly isTTY?: boolean | undefined } = process.stdout,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => stdout.isTTY === true || env.T3CODE_STARTUP_PRINT_TOKEN === "on";

const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const connectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
    { privateNetworkOnly: serverConfig.privateNetworkOnly },
  );
  const issued = yield* serverAuth.issueStartupPairingCredential();

  return {
    connectionString,
    token: issued.credential,
    pairingUrl: buildPairingUrl(connectionString, issued.credential),
  } satisfies HeadlessServeAccessInfo;
});

const resolveServeConnectionString = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  return resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
    { privateNetworkOnly: serverConfig.privateNetworkOnly },
  );
});

/**
 * The text `serve` prints once it is ready. The startup credential is issued only
 * when it is going to be shown: a non-interactive start mints nothing, so no
 * unused admin credential is left in the pairing table either.
 */
export const prepareHeadlessServeOutput = Effect.fn("prepareHeadlessServeOutput")(function* (
  printToken: boolean,
) {
  if (printToken) {
    return formatHeadlessServeOutput(yield* issueHeadlessServeAccessInfo());
  }
  return formatHeadlessServeLogOutput(yield* resolveServeConnectionString);
});
