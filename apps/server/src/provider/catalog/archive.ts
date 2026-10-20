// @effect-diagnostics nodeBuiltinImport:off - bounded streaming extraction needs node streams.
/**
 * Bounded unpacking of a downloaded agent archive: `.zip`, `.tar.gz` / `.tgz`,
 * or a bare executable. It runs only on an archive whose SHA-256 already
 * matched, and still treats every entry as hostile.
 *
 * Refused: a path that leaves the folder (absolute, `..`, drive letters,
 * alternate streams, device names), symlinks and hard links, encrypted or
 * oddly compressed zip entries, duplicate entries, more entries or bytes
 * than the limits allow, and a file that is longer or shorter than its
 * header says.
 *
 * @module provider/catalog/archive
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as NodeZlib from "node:zlib";
import * as Yauzl from "yauzl";

import { normalizeRelativeCommand } from "./plan.ts";

export class ArchiveError extends Error {
  override readonly name = "ArchiveError";
}

export interface ExtractLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
}

export interface ExtractResult {
  readonly files: number;
  readonly bytes: number;
}

/** Limits scaled to the download: generous for a real agent, tight for a bomb. */
export function extractLimitsFor(archiveBytes: number): ExtractLimits {
  const sixGiB = 6 * 1024 * 1024 * 1024;
  return {
    maxEntries: 60_000,
    maxTotalBytes: Math.min(sixGiB, Math.max(1024 * 1024 * 1024, archiveBytes * 12)),
    maxFileBytes: Math.min(sixGiB, Math.max(1024 * 1024 * 1024, archiveBytes * 12)),
  };
}

/** Unix type bits of a zip entry's external attributes (0 = made on Windows). */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

class Budget {
  entries = 0;
  bytes = 0;
  private readonly limits: ExtractLimits;
  constructor(limits: ExtractLimits) {
    this.limits = limits;
  }
  entry() {
    this.entries += 1;
    if (this.entries > this.limits.maxEntries)
      throw new ArchiveError("The archive has too many files.");
  }
  declared(size: number) {
    if (size > this.limits.maxFileBytes)
      throw new ArchiveError("The archive has a file that is too large.");
    if (this.bytes + size > this.limits.maxTotalBytes)
      throw new ArchiveError("The archive unpacks to more than hbots allows.");
  }
  written(size: number) {
    this.bytes += size;
    if (this.bytes > this.limits.maxTotalBytes)
      throw new ArchiveError("The archive unpacks to more than hbots allows.");
  }
}

/** Destination file for an entry name, or throws. Names are vetted, then checked against the root. */
function targetFor(root: string, name: string): string {
  const relative = normalizeRelativeCommand(name);
  if (relative === null) throw new ArchiveError("The archive has an entry with an unsafe path.");
  const target = NodePath.resolve(root, ...relative.split("/"));
  const inside = NodePath.relative(root, target);
  if (inside === "" || inside.startsWith("..") || NodePath.isAbsolute(inside)) {
    throw new ArchiveError("The archive has an entry with an unsafe path.");
  }
  return target;
}

/** Counts bytes through a stream and fails when it passes `expected` (or ends short). */
function exactLength(expected: number, onBytes: (size: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.byteLength;
      if (seen > expected) {
        callback(new ArchiveError("A file in the archive is longer than its header says."));
        return;
      }
      onBytes(chunk.byteLength);
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        seen === expected
          ? null
          : new ArchiveError("A file in the archive is shorter than its header says."),
      );
    },
  });
}

async function writeFileFrom(
  source: NodeStream.Readable,
  target: string,
  expectedBytes: number,
  mode: number,
  budget: Budget,
  signal: AbortSignal | undefined,
): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await pipeline(
    source,
    exactLength(expectedBytes, (size) => budget.written(size)),
    NodeFS.createWriteStream(target, { flags: "wx", mode }),
    ...(signal === undefined ? [] : [{ signal }]),
  );
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

function openZip(archivePath: string): Promise<Yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    Yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
      (error, zip) =>
        error || !zip ? reject(new ArchiveError("The archive could not be opened.")) : resolve(zip),
    );
  });
}

function openEntry(zip: Yauzl.ZipFile, entry: Yauzl.Entry): Promise<NodeStream.Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) =>
      error || !stream
        ? reject(new ArchiveError("Could not read an archive member."))
        : resolve(stream),
    );
  });
}

export async function extractZip(
  archivePath: string,
  destination: string,
  limits: ExtractLimits,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const root = NodePath.resolve(destination);
  const zip = await openZip(archivePath);
  const budget = new Budget(limits);
  const seen = new Set<string>();
  let files = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) =>
        reject(
          error instanceof ArchiveError
            ? error
            : new ArchiveError("The archive could not be read."),
        );
      zip.on("error", fail);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: Yauzl.Entry) => {
        void (async () => {
          signal?.throwIfAborted();
          budget.entry();
          const isDirectory =
            entry.fileName.endsWith("/") || (entry.externalFileAttributes & 0x10) !== 0;
          const unixType = (entry.externalFileAttributes >>> 16) & S_IFMT;
          if (
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            ![0, 8].includes(entry.compressionMethod) ||
            (unixType !== 0 && unixType !== S_IFREG && unixType !== S_IFDIR)
          ) {
            throw new ArchiveError("The archive has an encrypted, linked or unusual member.");
          }
          const target = targetFor(root, entry.fileName);
          const key = target.toLowerCase();
          if (seen.has(key)) throw new ArchiveError("The archive lists the same file twice.");
          seen.add(key);
          if (isDirectory) {
            await NodeFSP.mkdir(target, { recursive: true });
          } else {
            budget.declared(entry.uncompressedSize);
            const permissions = (entry.externalFileAttributes >>> 16) & 0o777;
            const mode = (permissions & 0o111) !== 0 ? 0o755 : 0o644;
            await writeFileFrom(
              await openEntry(zip, entry),
              target,
              entry.uncompressedSize,
              mode,
              budget,
              signal,
            );
            files += 1;
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return { files, bytes: budget.bytes };
}

// ---------------------------------------------------------------------------
// tar.gz
// ---------------------------------------------------------------------------

const BLOCK = 512;
const METADATA_MAX = 64 * 1024;

/** Reads exact byte counts from a stream, so the tar parser can work block by block. */
class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private finished = false;
  constructor(stream: NodeStream.Readable) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async fill(minimum: number): Promise<void> {
    while (this.pending.byteLength < minimum && !this.finished) {
      const next = await this.iterator.next();
      if (next.done === true) this.finished = true;
      else
        this.pending =
          this.pending.byteLength === 0 ? next.value : Buffer.concat([this.pending, next.value]);
    }
  }

  /** Exactly `size` bytes. Null if the stream ends before the first byte; throws if it ends inside. */
  async read(size: number): Promise<Buffer | null> {
    await this.fill(size);
    if (this.pending.byteLength === 0) return null;
    if (this.pending.byteLength < size) throw new ArchiveError("The archive ended early.");
    const out = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(size);
    return out;
  }

  /** Streams `size` bytes into a writable-side pipeline, one chunk at a time. */
  async *take(size: number): AsyncGenerator<Buffer> {
    let remaining = size;
    while (remaining > 0) {
      await this.fill(1);
      if (this.pending.byteLength === 0) throw new ArchiveError("The archive ended early.");
      const length = Math.min(remaining, this.pending.byteLength);
      yield this.pending.subarray(0, length);
      this.pending = this.pending.subarray(length);
      remaining -= length;
    }
  }

  async skip(size: number): Promise<void> {
    for await (const _chunk of this.take(size)) {
      // discarded
    }
  }
}

const textField = (block: Buffer, start: number, end: number): string => {
  const slice = block.subarray(start, end);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero === -1 ? slice.byteLength : zero).toString("utf8");
};

function octalField(block: Buffer, start: number, end: number): number {
  const slice = block.subarray(start, end);
  if ((slice[0]! & 0x80) !== 0) {
    // GNU base-256 number: big-endian after the marker bit.
    let value = slice[0]! & 0x7f;
    for (let index = 1; index < slice.byteLength; index += 1) {
      value = value * 256 + slice[index]!;
      if (value > Number.MAX_SAFE_INTEGER)
        throw new ArchiveError("The archive has a number that is too large.");
    }
    return value;
  }
  const text = textField(block, start, end).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) throw new ArchiveError("The archive has a damaged header.");
  return Number.parseInt(text, 8);
}

function headerChecksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  return sum === octalField(block, 148, 156);
}

/** `path` and `size` from a pax extended header ("<len> key=value\n" records). */
function parsePax(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.byteLength) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (
      !Number.isInteger(length) ||
      length <= space - offset ||
      offset + length > data.byteLength
    ) {
      throw new ArchiveError("The archive has a damaged header.");
    }
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === "path") out.path = value;
      else if (key === "size") {
        const size = Number(value);
        if (!Number.isSafeInteger(size) || size < 0)
          throw new ArchiveError("The archive has a damaged header.");
        out.size = size;
      } else if (key === "linkpath") {
        throw new ArchiveError("The archive has an encrypted, linked or unusual member.");
      }
    }
    offset += length;
  }
  return out;
}

export async function extractTarGz(
  archivePath: string,
  destination: string,
  limits: ExtractLimits,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const root = NodePath.resolve(destination);
  const source = NodeFS.createReadStream(archivePath);
  const gunzip = NodeZlib.createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const abort = () => gunzip.destroy(new ArchiveError("Cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  const reader = new ByteReader(gunzip);
  const budget = new Budget(limits);
  const seen = new Set<string>();
  let files = 0;
  let longName: string | undefined;
  let pax: { path?: string; size?: number } = {};
  try {
    for (;;) {
      signal?.throwIfAborted();
      const block = await reader.read(BLOCK);
      if (block === null) break;
      if (block.every((byte) => byte === 0)) break;
      if (!headerChecksumOk(block)) throw new ArchiveError("The archive has a damaged header.");
      const type = String.fromCharCode(block[156]!);
      const headerSize = octalField(block, 124, 136);
      const size = pax.size ?? headerSize;
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      if (type === "x" || type === "g" || type === "L") {
        if (size > METADATA_MAX) throw new ArchiveError("The archive has a damaged header.");
        const data = (await reader.read(padded)) ?? Buffer.alloc(0);
        const content = data.subarray(0, size);
        if (type === "x") pax = { ...pax, ...parsePax(content) };
        else if (type === "L") longName = content.toString("utf8").replace(/\0.*$/su, "");
        continue;
      }
      if (
        type === "K" ||
        type === "1" ||
        type === "2" ||
        type === "3" ||
        type === "4" ||
        type === "6" ||
        type === "7"
      ) {
        throw new ArchiveError("The archive has an encrypted, linked or unusual member.");
      }
      if (type !== "0" && type !== "\0" && type !== "5") {
        throw new ArchiveError("The archive has an encrypted, linked or unusual member.");
      }

      const prefix = textField(block, 345, 500);
      const baseName = textField(block, 0, 100);
      const ustar = textField(block, 257, 263).startsWith("ustar");
      const name =
        pax.path ?? longName ?? (ustar && prefix !== "" ? `${prefix}/${baseName}` : baseName);
      pax = {};
      longName = undefined;

      budget.entry();
      const target = targetFor(root, name);
      const key = target.toLowerCase();
      if (type === "5" || name.endsWith("/")) {
        await NodeFSP.mkdir(target, { recursive: true });
        await reader.skip(padded);
        continue;
      }
      if (seen.has(key)) throw new ArchiveError("The archive lists the same file twice.");
      seen.add(key);
      budget.declared(size);
      const mode = (octalField(block, 100, 108) & 0o111) !== 0 ? 0o755 : 0o644;
      await writeFileFrom(Readable.from(reader.take(size)), target, size, mode, budget, signal);
      await reader.skip(padded - size);
      files += 1;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    source.destroy();
    gunzip.destroy();
  }
  return { files, bytes: budget.bytes };
}

// ---------------------------------------------------------------------------
// bare executable
// ---------------------------------------------------------------------------

/** A download that is the program itself: copy it to `fileName` inside the folder. */
export async function placeRawFile(
  archivePath: string,
  destination: string,
  fileName: string,
  limits: ExtractLimits,
): Promise<ExtractResult> {
  const root = NodePath.resolve(destination);
  const target = targetFor(root, fileName);
  const info = await NodeFSP.stat(archivePath);
  const budget = new Budget(limits);
  budget.entry();
  budget.declared(info.size);
  await writeFileFrom(
    NodeFS.createReadStream(archivePath),
    target,
    info.size,
    0o755,
    budget,
    undefined,
  );
  return { files: 1, bytes: info.size };
}
