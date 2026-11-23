// @effect-diagnostics nodeBuiltinImport:off - Pure-Node D-Bus wire client over Unix socket (zero child processes / zero libsystemd-shared).
/**
 * Minimal pure-Node.js D-Bus wire protocol client for systemd-logind reboot.
 *
 * Talks directly to `/run/dbus/system_bus_socket` over `node:net`, avoiding
 * `busctl` and `libsystemd-shared` completely. Implements just what reboot
 * needs:
 *   1. SASL `EXTERNAL` auth (`\0AUTH EXTERNAL <hex(uid)>\r\n` -> `OK ...\r\n` -> `BEGIN\r\n`)
 *   2. `org.freedesktop.DBus.Hello`
 *   3. `org.freedesktop.login1.Manager.CanReboot` -> string ("yes" | "no" | "challenge" | ...)
 *   4. `org.freedesktop.login1.Manager.Reboot(false)` -> boolean false (non-interactive)
 */
import * as NodeNet from "node:net";

export const DEFAULT_SYSTEM_BUS_SOCKET = "/run/dbus/system_bus_socket";
export const DBUS_SYSTEM_SOCKET_ENV = "HBOTS_DBUS_SYSTEM_SOCKET";
export const DEFAULT_DBUS_TIMEOUT_MS = 5_000;

const DBUS_ENDIAN_LITTLE = 0x6c; // 'l'
const DBUS_ENDIAN_BIG = 0x42; // 'B'
const DBUS_PROTOCOL_VERSION = 1;

const MSG_TYPE_METHOD_CALL = 1;
const MSG_TYPE_METHOD_RETURN = 2;
const MSG_TYPE_ERROR = 3;
const MSG_TYPE_SIGNAL = 4;

const FIELD_PATH = 1;
const FIELD_INTERFACE = 2;
const FIELD_MEMBER = 3;
const FIELD_ERROR_NAME = 4;
const FIELD_REPLY_SERIAL = 5;
const FIELD_DESTINATION = 6;
const FIELD_SIGNATURE = 8;

const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB safety cap

export interface DirectDbusOptions {
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  readonly uid?: number;
}

export type DirectDbusCanRebootResult =
  | { readonly ok: true; readonly answer: string }
  | { readonly ok: false; readonly error: string };

export type DirectDbusRebootResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

const alignUp = (offset: number, alignment: number): number => {
  const rem = offset % alignment;
  return rem === 0 ? offset : offset + (alignment - rem);
};

const padTo = (chunks: Buffer[], currentLen: number, alignment: number): number => {
  const target = alignUp(currentLen, alignment);
  if (target > currentLen) {
    chunks.push(Buffer.alloc(target - currentLen));
  }
  return target;
};

interface DbusMethodCall {
  readonly serial: number;
  readonly path: string;
  readonly iface: string;
  readonly member: string;
  readonly destination: string;
  readonly signature?: string;
  readonly body?: Buffer;
}

/** Encodes a D-Bus METHOD_CALL message in little-endian wire format. */
export function encodeDbusMethodCall(call: DbusMethodCall): Buffer {
  const body = call.body ?? Buffer.alloc(0);
  const fieldChunks: Buffer[] = [];
  // Header fields array starts at message byte offset 16 (already 8-byte aligned).
  let offset = 16;

  const pushStringField = (code: number, sigChar: "o" | "s", value: string) => {
    offset = padTo(fieldChunks, offset, 8);
    // Struct: BYTE code, VARIANT (1-byte sigLen, sig, NUL, align4, uint32 len, utf8, NUL)
    const strBytes = Buffer.from(value, "utf8");
    // Prefix: code (1) + sigLen (1) + sigChar (1) + NUL (1) = 4 bytes -> already 4-byte aligned!
    const prefix = Buffer.alloc(8);
    prefix[0] = code;
    prefix[1] = 1;
    prefix[2] = sigChar.charCodeAt(0);
    prefix[3] = 0;
    prefix.writeUInt32LE(strBytes.length, 4);
    fieldChunks.push(prefix, strBytes, Buffer.from([0]));
    offset += 8 + strBytes.length + 1;
  };

  const pushSignatureField = (sig: string) => {
    offset = padTo(fieldChunks, offset, 8);
    const sigBytes = Buffer.from(sig, "ascii");
    // code (1) + varSigLen (1) + 'g' (1) + NUL (1) + valSigLen (1) + sigBytes + NUL (1)
    const prefix = Buffer.alloc(5);
    prefix[0] = FIELD_SIGNATURE;
    prefix[1] = 1;
    prefix[2] = "g".charCodeAt(0);
    prefix[3] = 0;
    prefix[4] = sigBytes.length;
    fieldChunks.push(prefix, sigBytes, Buffer.from([0]));
    offset += 5 + sigBytes.length + 1;
  };

  pushStringField(FIELD_PATH, "o", call.path);
  pushStringField(FIELD_INTERFACE, "s", call.iface);
  pushStringField(FIELD_MEMBER, "s", call.member);
  pushStringField(FIELD_DESTINATION, "s", call.destination);
  if (call.signature !== undefined && call.signature.length > 0) {
    pushSignatureField(call.signature);
  }

  const fieldsLen = offset - 16;
  const headerPaddedLen = alignUp(offset, 8);
  const headerPadBytes = headerPaddedLen - offset;

  const fixed = Buffer.alloc(16);
  fixed[0] = DBUS_ENDIAN_LITTLE;
  fixed[1] = MSG_TYPE_METHOD_CALL;
  fixed[2] = 0; // flags
  fixed[3] = DBUS_PROTOCOL_VERSION;
  fixed.writeUInt32LE(body.length, 4);
  fixed.writeUInt32LE(call.serial, 8);
  fixed.writeUInt32LE(fieldsLen, 12);

  return Buffer.concat([
    fixed,
    ...fieldChunks,
    headerPadBytes > 0 ? Buffer.alloc(headerPadBytes) : Buffer.alloc(0),
    body,
  ]);
}

export interface DecodedDbusFrame {
  readonly littleEndian: boolean;
  readonly msgType: number;
  readonly serial: number;
  readonly replySerial: number | null;
  readonly errorName: string | null;
  readonly signature: string | null;
  readonly body: Buffer;
  readonly totalBytes: number;
}

const readUInt32 = (buf: Buffer, offset: number, littleEndian: boolean): number =>
  littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);

/**
 * Attempts to decode one complete D-Bus frame from the front of `buf`.
 * Returns `null` when more bytes are needed; throws on malformed framing.
 */
export function tryDecodeDbusFrame(buf: Buffer): DecodedDbusFrame | null {
  if (buf.length < 16) return null;

  const endianByte = buf[0];
  let littleEndian: boolean;
  if (endianByte === DBUS_ENDIAN_LITTLE) {
    littleEndian = true;
  } else if (endianByte === DBUS_ENDIAN_BIG) {
    littleEndian = false;
  } else {
    throw new Error(`Invalid D-Bus endianness byte: 0x${endianByte?.toString(16) ?? "??"}`);
  }

  const msgType = buf[1]!;
  const version = buf[3]!;
  if (version !== DBUS_PROTOCOL_VERSION) {
    throw new Error(`Unsupported D-Bus protocol version: ${version}`);
  }

  const bodyLen = readUInt32(buf, 4, littleEndian);
  const serial = readUInt32(buf, 8, littleEndian);
  const fieldsLen = readUInt32(buf, 12, littleEndian);

  const headerEnd = 16 + fieldsLen;
  const bodyStart = alignUp(headerEnd, 8);
  const totalBytes = bodyStart + bodyLen;
  if (totalBytes > MAX_FRAME_BYTES) {
    throw new Error(`D-Bus frame exceeds safety limit (${totalBytes} bytes)`);
  }
  if (buf.length < totalBytes) return null;

  let replySerial: number | null = null;
  let errorName: string | null = null;
  let signature: string | null = null;

  let pos = 16;
  while (pos < headerEnd) {
    pos = alignUp(pos, 8);
    if (pos >= headerEnd) break;
    const fieldCode = buf[pos++];
    if (pos >= headerEnd) throw new Error("Truncated D-Bus header field variant signature");
    const sigLen = buf[pos++]!;
    if (pos + sigLen + 1 > headerEnd) {
      throw new Error("Truncated D-Bus header field signature bytes");
    }
    const varSig = buf.subarray(pos, pos + sigLen).toString("ascii");
    pos += sigLen + 1; // include trailing NUL

    let value: string | number | null = null;
    if (varSig === "s" || varSig === "o") {
      pos = alignUp(pos, 4);
      if (pos + 4 > headerEnd) throw new Error("Truncated D-Bus string length");
      const strLen = readUInt32(buf, pos, littleEndian);
      pos += 4;
      if (pos + strLen + 1 > headerEnd) throw new Error("Truncated D-Bus string value");
      value = buf.subarray(pos, pos + strLen).toString("utf8");
      pos += strLen + 1;
    } else if (varSig === "g") {
      if (pos + 1 > headerEnd) throw new Error("Truncated D-Bus signature length");
      const gLen = buf[pos++]!;
      if (pos + gLen + 1 > headerEnd) throw new Error("Truncated D-Bus signature value");
      value = buf.subarray(pos, pos + gLen).toString("ascii");
      pos += gLen + 1;
    } else if (varSig === "u" || varSig === "i" || varSig === "b" || varSig === "h") {
      pos = alignUp(pos, 4);
      if (pos + 4 > headerEnd) throw new Error("Truncated D-Bus 32-bit header value");
      value = readUInt32(buf, pos, littleEndian);
      pos += 4;
    } else if (varSig === "y") {
      if (pos + 1 > headerEnd) throw new Error("Truncated D-Bus byte header value");
      value = buf[pos++]!;
    } else if (varSig === "n" || varSig === "q") {
      pos = alignUp(pos, 2);
      if (pos + 2 > headerEnd) throw new Error("Truncated D-Bus 16-bit header value");
      pos += 2;
    } else if (varSig === "x" || varSig === "t" || varSig === "d") {
      pos = alignUp(pos, 8);
      if (pos + 8 > headerEnd) throw new Error("Truncated D-Bus 64-bit header value");
      pos += 8;
    } else {
      throw new Error(`Unsupported D-Bus header variant signature: "${varSig}"`);
    }

    if (fieldCode === FIELD_REPLY_SERIAL && typeof value === "number") {
      replySerial = value;
    } else if (fieldCode === FIELD_ERROR_NAME && typeof value === "string") {
      errorName = value;
    } else if (fieldCode === FIELD_SIGNATURE && typeof value === "string") {
      signature = value;
    }
  }

  return {
    littleEndian,
    msgType,
    serial,
    replySerial,
    errorName,
    signature,
    body: Buffer.from(buf.subarray(bodyStart, totalBytes)),
    totalBytes,
  };
}

/** Decodes a leading D-Bus string (`s`) from a message body. */
export function decodeDbusStringBody(body: Buffer, littleEndian: boolean): string | null {
  if (body.length < 4) return null;
  const len = readUInt32(body, 0, littleEndian);
  if (4 + len > body.length) return null;
  return body.subarray(4, 4 + len).toString("utf8");
}

class DbusConnection {
  private readonly socket: NodeNet.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private closedError: Error | null = null;
  private waiters: Array<() => void> = [];
  private nextSerial = 1;

  private constructor(socket: NodeNet.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    socket.on("error", (err) => {
      this.closedError ??= err;
      this.notify();
    });
    socket.on("close", () => {
      this.closedError ??= new Error("D-Bus socket closed unexpectedly");
      this.notify();
    });
  }

  static connect(socketPath: string, deadlineMs: number): Promise<DbusConnection> {
    return new Promise((resolve, reject) => {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        reject(new Error("D-Bus connection timed out"));
        return;
      }
      const socket = NodeNet.createConnection({ path: socketPath });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("D-Bus connection timed out"));
      }, remaining);

      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new DbusConnection(socket));
      });
      socket.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      });
    });
  }

  private notify() {
    const list = this.waiters;
    this.waiters = [];
    for (const wake of list) wake();
  }

  private waitForData(deadlineMs: number): Promise<void> {
    if (this.closedError !== null) {
      return Promise.reject(this.closedError);
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new Error("D-Bus request timed out"));
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const onWake = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.waiters = this.waiters.filter((fn) => fn !== onWake);
        reject(new Error("D-Bus request timed out"));
      }, remaining);
      this.waiters.push(onWake);
    });
  }

  private async readLine(deadlineMs: number): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx !== -1) {
        const line = this.buffer.subarray(0, idx).toString("ascii");
        this.buffer = this.buffer.subarray(idx + 2);
        return line;
      }
      if (this.buffer.length > 4096) {
        throw new Error("D-Bus SASL reply too long");
      }
      await this.waitForData(deadlineMs);
    }
  }

  private write(data: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closedError !== null) {
        reject(this.closedError);
        return;
      }
      this.socket.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async authenticate(uid: number, deadlineMs: number): Promise<void> {
    const uidHex = Buffer.from(String(uid), "ascii").toString("hex");
    // Leading NUL byte is mandatory for Unix domain socket credential passing.
    await this.write(`\0AUTH EXTERNAL ${uidHex}\r\n`);
    const reply = await this.readLine(deadlineMs);
    if (!reply.startsWith("OK ")) {
      throw new Error(`D-Bus auth failed: ${reply}`);
    }
    await this.write("BEGIN\r\n");
  }

  async call(spec: Omit<DbusMethodCall, "serial">, deadlineMs: number): Promise<DecodedDbusFrame> {
    const serial = this.nextSerial++;
    const packet = encodeDbusMethodCall({ ...spec, serial });
    await this.write(packet);

    for (;;) {
      const frame = tryDecodeDbusFrame(this.buffer);
      if (frame !== null) {
        this.buffer = this.buffer.subarray(frame.totalBytes);
        if (frame.msgType === MSG_TYPE_SIGNAL || frame.replySerial !== serial) {
          continue;
        }
        if (frame.msgType === MSG_TYPE_ERROR) {
          const detail =
            frame.signature !== null && frame.signature.startsWith("s")
              ? decodeDbusStringBody(frame.body, frame.littleEndian)
              : null;
          const prefix = frame.errorName ?? "D-Bus error";
          throw new Error(detail ? `${prefix}: ${detail}` : prefix);
        }
        if (frame.msgType === MSG_TYPE_METHOD_RETURN) {
          return frame;
        }
        continue;
      }
      await this.waitForData(deadlineMs);
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

async function withDbusSession<T>(
  options: DirectDbusOptions | undefined,
  fn: (conn: DbusConnection, deadlineMs: number) => Promise<T>,
): Promise<T> {
  const socketPath =
    options?.socketPath ?? process.env[DBUS_SYSTEM_SOCKET_ENV] ?? DEFAULT_SYSTEM_BUS_SOCKET;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DBUS_TIMEOUT_MS;
  const uid = options?.uid ?? process.getuid?.() ?? 0;
  const deadlineMs = Date.now() + timeoutMs;

  const conn = await DbusConnection.connect(socketPath, deadlineMs);
  try {
    await conn.authenticate(uid, deadlineMs);
    await conn.call(
      {
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        iface: "org.freedesktop.DBus",
        member: "Hello",
      },
      deadlineMs,
    );
    return await fn(conn, deadlineMs);
  } finally {
    conn.close();
  }
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Calls `org.freedesktop.login1.Manager.CanReboot` directly over the system D-Bus Unix socket. */
export async function directDbusCanReboot(
  options?: DirectDbusOptions,
): Promise<DirectDbusCanRebootResult> {
  try {
    const answer = await withDbusSession(options, async (conn, deadlineMs) => {
      const reply = await conn.call(
        {
          destination: "org.freedesktop.login1",
          path: "/org/freedesktop/login1",
          iface: "org.freedesktop.login1.Manager",
          member: "CanReboot",
        },
        deadlineMs,
      );
      const parsed = decodeDbusStringBody(reply.body, reply.littleEndian);
      if (parsed === null) {
        throw new Error("D-Bus CanReboot returned an unreadable reply");
      }
      return parsed;
    });
    return { ok: true, answer };
  } catch (cause) {
    return { ok: false, error: errorMessage(cause) };
  }
}

/** Calls `org.freedesktop.login1.Manager.Reboot(false)` directly over the system D-Bus Unix socket. */
export async function directDbusReboot(
  options?: DirectDbusOptions,
): Promise<DirectDbusRebootResult> {
  try {
    await withDbusSession(options, async (conn, deadlineMs) => {
      // D-Bus boolean `false` is encoded as uint32 0.
      const body = Buffer.alloc(4);
      body.writeUInt32LE(0, 0);
      await conn.call(
        {
          destination: "org.freedesktop.login1",
          path: "/org/freedesktop/login1",
          iface: "org.freedesktop.login1.Manager",
          member: "Reboot",
          signature: "b",
          body,
        },
        deadlineMs,
      );
    });
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: errorMessage(cause) };
  }
}
