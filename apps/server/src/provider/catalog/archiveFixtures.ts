// @effect-diagnostics nodeBuiltinImport:off - test fixtures build archives byte by byte.
/**
 * Byte-level zip and tar.gz writers for tests. They exist so a test can make
 * the hostile archives (symlinks, traversal, bad checksums, lying sizes) that
 * real tools refuse to write.
 *
 * @module provider/catalog/archiveFixtures
 */
import * as NodeZlib from "node:zlib";

export interface ZipEntry {
  readonly name: string;
  readonly data?: Uint8Array;
  /** Unix mode including the type bits, for example 0o100755 or 0o120777 (symlink). */
  readonly mode?: number;
  readonly directory?: boolean;
  readonly encrypted?: boolean;
  /** Overrides the compression method field (the data is still stored). */
  readonly method?: number;
}

/** A stored (uncompressed) zip. */
export function makeZip(entries: ReadonlyArray<ZipEntry>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(
      entry.directory === true && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name,
    );
    const data = Buffer.from(entry.data ?? new Uint8Array());
    const crc = NodeZlib.crc32(data);
    const flags = entry.encrypted === true ? 1 : 0;
    const method = entry.method ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    const mode = entry.mode ?? (entry.directory === true ? 0o040755 : 0o100644);
    central.writeUInt32LE(((mode << 16) | (entry.directory === true ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.byteLength + data.byteLength;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

export interface TarEntry {
  readonly name: string;
  readonly data?: Uint8Array;
  /** "0" file, "5" directory, "1" hard link, "2" symlink, "x" pax header, "L" GNU long name. */
  readonly type?: string;
  readonly linkname?: string;
  readonly mode?: number;
  /** ustar `prefix` field. */
  readonly prefix?: string;
  /** Header size field when it should differ from the data length. */
  readonly declaredSize?: number;
  /** Corrupt the header checksum. */
  readonly badChecksum?: boolean;
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, "utf8");
  header.write(octal(entry.mode ?? 0o644, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(entry.declaredSize ?? size, 12), 124, "ascii");
  header.write(octal(0, 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write(entry.type ?? "0", 156, "ascii");
  if (entry.linkname !== undefined) header.write(entry.linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  if (entry.prefix !== undefined) header.write(entry.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = entry.badChecksum === true ? sum + 7 : sum;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}

/** Tar blocks without the end marker. */
export function tarBlocks(entries: ReadonlyArray<TarEntry>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? new Uint8Array());
    parts.push(tarHeader(entry, data.byteLength));
    if (data.byteLength > 0) {
      parts.push(data, Buffer.alloc((512 - (data.byteLength % 512)) % 512));
    }
  }
  return Buffer.concat(parts);
}

export function makeTarGz(
  entries: ReadonlyArray<TarEntry>,
  options: { readonly truncateBy?: number } = {},
): Buffer {
  const body = Buffer.concat([tarBlocks(entries), Buffer.alloc(1024)]);
  const cut =
    options.truncateBy === undefined
      ? body
      : body.subarray(0, body.byteLength - options.truncateBy);
  return NodeZlib.gzipSync(cut);
}

/** A pax extended header record block ("<len> key=value\n"). */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return Buffer.from(`${length}${body}`);
}
