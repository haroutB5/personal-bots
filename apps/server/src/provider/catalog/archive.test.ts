// @effect-diagnostics nodeBuiltinImport:off - the tests unpack into real temp folders.
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ArchiveError,
  extractLimitsFor,
  extractTarGz,
  extractZip,
  placeRawFile,
  type ExtractLimits,
} from "./archive.ts";
import { makeTarGz, makeZip, paxRecord, tarBlocks } from "./archiveFixtures.ts";
import * as NodeZlib from "node:zlib";

const limits: ExtractLimits = {
  maxEntries: 100,
  maxTotalBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
};
const text = (value: string) => Buffer.from(value);

let root: string;
let archives: string;
let output: string;

beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hbots-archive-"));
  archives = NodePath.join(root, "in");
  output = NodePath.join(root, "out");
  await NodeFSP.mkdir(archives);
  await NodeFSP.mkdir(output);
});

afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

const write = async (name: string, data: Uint8Array) => {
  const file = NodePath.join(archives, name);
  await NodeFSP.writeFile(file, data);
  return file;
};

const listOutput = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(NodePath.join(directory, entry.name), relative);
      else out.push(relative);
    }
  };
  await walk(output, "");
  return out.toSorted();
};

/** Nothing may appear next to the output folder, whatever the archive says. */
const nothingEscaped = async () => {
  expect(await NodeFSP.readdir(root)).toEqual(["in", "out"]);
  expect(await NodeFSP.readdir(archives)).toHaveLength(1);
};

describe("extractZip", () => {
  it("unpacks files and nested folders and counts them", async () => {
    const zip = await write(
      "a.zip",
      makeZip([
        { name: "bin/", directory: true },
        { name: "bin/tool.exe", data: text("EXE"), mode: 0o100755 },
        { name: "readme.txt", data: text("hello") },
        { name: "deep/er/file.json", data: text("{}") },
      ]),
    );
    const result = await extractZip(zip, output, limits);
    expect(result).toEqual({ files: 3, bytes: 3 + 5 + 2 });
    expect(await listOutput()).toEqual(["bin/tool.exe", "deep/er/file.json", "readme.txt"]);
    expect(await NodeFSP.readFile(NodePath.join(output, "bin", "tool.exe"), "utf8")).toBe("EXE");
  });

  it("refuses a path that leaves the folder, and writes nothing outside it", async () => {
    for (const name of [
      "../escape.txt",
      "a/../../escape.txt",
      "/abs.txt",
      "C:/drive.txt",
      "a/b:stream",
    ]) {
      const zip = await write("t.zip", makeZip([{ name, data: text("x") }]));
      await expect(extractZip(zip, output, limits), name).rejects.toBeInstanceOf(ArchiveError);
      await NodeFSP.rm(zip);
    }
    expect(await listOutput()).toEqual([]);
    expect(await NodeFSP.readdir(root)).toEqual(["in", "out"]);
  });

  it("refuses device names", async () => {
    const zip = await write("t.zip", makeZip([{ name: "nul.txt", data: text("x") }]));
    await expect(extractZip(zip, output, limits)).rejects.toBeInstanceOf(ArchiveError);
    expect(await listOutput()).toEqual([]);
  });

  it("refuses a symlink member", async () => {
    const zip = await write(
      "t.zip",
      makeZip([
        { name: "ok.txt", data: text("ok") },
        { name: "link", data: text("/etc/passwd"), mode: 0o120777 },
      ]),
    );
    await expect(extractZip(zip, output, limits)).rejects.toBeInstanceOf(ArchiveError);
    expect(await listOutput()).not.toContain("link");
  });

  it("refuses an encrypted member and an unusual compression method", async () => {
    const encrypted = await write(
      "e.zip",
      makeZip([{ name: "a.txt", data: text("x"), encrypted: true }]),
    );
    await expect(extractZip(encrypted, output, limits)).rejects.toBeInstanceOf(ArchiveError);
    const odd = await write("o.zip", makeZip([{ name: "a.txt", data: text("x"), method: 12 }]));
    await expect(extractZip(odd, output, limits)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("refuses the same file twice, including by letter case", async () => {
    const zip = await write(
      "d.zip",
      makeZip([
        { name: "A.txt", data: text("1") },
        { name: "a.txt", data: text("2") },
      ]),
    );
    await expect(extractZip(zip, output, limits)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("stops at the entry and byte limits", async () => {
    const many = await write(
      "m.zip",
      makeZip(Array.from({ length: 5 }, (_, index) => ({ name: `f${index}`, data: text("x") }))),
    );
    await expect(extractZip(many, output, { ...limits, maxEntries: 4 })).rejects.toThrow(
      /too many files/u,
    );
    await NodeFSP.rm(output, { recursive: true });
    await NodeFSP.mkdir(output);
    const big = await write("b.zip", makeZip([{ name: "big", data: Buffer.alloc(2_000) }]));
    await expect(extractZip(big, output, { ...limits, maxFileBytes: 1_000 })).rejects.toThrow(
      /too large/u,
    );
    await NodeFSP.rm(output, { recursive: true });
    await NodeFSP.mkdir(output);
    const total = await write(
      "t.zip",
      makeZip([
        { name: "a", data: Buffer.alloc(600) },
        { name: "b", data: Buffer.alloc(600) },
      ]),
    );
    await expect(extractZip(total, output, { ...limits, maxTotalBytes: 1_000 })).rejects.toThrow(
      /more than hbots allows/u,
    );
  });

  it("rejects a damaged or truncated archive", async () => {
    const good = makeZip([{ name: "a.txt", data: text("hello") }]);
    await expect(
      extractZip(await write("trunc.zip", good.subarray(0, good.byteLength - 10)), output, limits),
    ).rejects.toBeInstanceOf(ArchiveError);
    await expect(
      extractZip(await write("junk.zip", text("not a zip at all")), output, limits),
    ).rejects.toBeInstanceOf(ArchiveError);
  });

  it("stops when cancelled", async () => {
    const zip = await write("c.zip", makeZip([{ name: "a.txt", data: text("x") }]));
    const controller = new AbortController();
    controller.abort();
    await expect(extractZip(zip, output, limits, controller.signal)).rejects.toThrow();
    expect(await listOutput()).toEqual([]);
  });
});

describe("extractTarGz", () => {
  it("unpacks files, folders, a ustar prefix, a pax path and a GNU long name", async () => {
    const longName = `long/${"d".repeat(120)}/file.txt`;
    const tar = makeTarGz([
      { name: "bin/", type: "5" },
      { name: "bin/tool.exe", data: text("EXE"), mode: 0o755 },
      { name: "short.txt", prefix: "pre/fix", data: text("P") },
      { name: "paxheader", type: "x", data: paxRecord("path", "from/pax/name.txt") },
      { name: "ignored", data: text("PAX") },
      { name: "././@LongLink", type: "L", data: Buffer.from(`${longName}\0`) },
      { name: "ignored2", data: text("LONG") },
    ]);
    const result = await extractTarGz(await write("a.tar.gz", tar), output, limits);
    expect(result.files).toBe(4);
    expect(await listOutput()).toEqual([
      "bin/tool.exe",
      "from/pax/name.txt",
      longName,
      "pre/fix/short.txt",
    ]);
    expect(await NodeFSP.readFile(NodePath.join(output, "from", "pax", "name.txt"), "utf8")).toBe(
      "PAX",
    );
  });

  it("refuses symlinks, hard links and other special members", async () => {
    for (const type of ["2", "1", "3", "4", "6"]) {
      const tar = makeTarGz([{ name: "x", type, linkname: "/etc/passwd" }]);
      await expect(
        extractTarGz(await write(`t${type}.tar.gz`, tar), output, limits),
        type,
      ).rejects.toBeInstanceOf(ArchiveError);
    }
    expect(await listOutput()).toEqual([]);
  });

  it("refuses a pax linkpath", async () => {
    const tar = makeTarGz([
      { name: "p", type: "x", data: paxRecord("linkpath", "/etc/passwd") },
      { name: "f", data: text("x") },
    ]);
    await expect(extractTarGz(await write("p.tar.gz", tar), output, limits)).rejects.toBeInstanceOf(
      ArchiveError,
    );
  });

  it("refuses a path that leaves the folder", async () => {
    for (const name of ["../escape.txt", "a/../../escape.txt", "/abs.txt", "C:/drive.txt"]) {
      const tar = makeTarGz([{ name, data: text("x") }]);
      await expect(
        extractTarGz(await write("t.tar.gz", tar), output, limits),
        name,
      ).rejects.toBeInstanceOf(ArchiveError);
      await NodeFSP.rm(NodePath.join(archives, "t.tar.gz"));
    }
    expect(await listOutput()).toEqual([]);
    expect(await NodeFSP.readdir(root)).toEqual(["in", "out"]);
  });

  it("refuses a header with a bad checksum", async () => {
    const tar = makeTarGz([{ name: "a.txt", data: text("x"), badChecksum: true }]);
    await expect(extractTarGz(await write("c.tar.gz", tar), output, limits)).rejects.toThrow(
      /damaged header/u,
    );
  });

  it("refuses a file that is cut short, or a header that promises more than the archive holds", async () => {
    const cut = makeTarGz([{ name: "a.txt", data: Buffer.alloc(2_000, 1) }], { truncateBy: 1_800 });
    await expect(extractTarGz(await write("cut.tar.gz", cut), output, limits)).rejects.toThrow(
      /ended early/u,
    );
    const lying = makeTarGz([{ name: "a.txt", data: text("short"), declaredSize: 4_000 }]);
    await expect(extractTarGz(await write("lie.tar.gz", lying), output, limits)).rejects.toThrow();
  });

  it("refuses the same file twice", async () => {
    const tar = makeTarGz([
      { name: "a.txt", data: text("1") },
      { name: "A.TXT", data: text("2") },
    ]);
    await expect(extractTarGz(await write("d.tar.gz", tar), output, limits)).rejects.toThrow(
      /same file twice/u,
    );
  });

  it("stops at the entry and byte limits before writing a bomb", async () => {
    const many = makeTarGz(
      Array.from({ length: 5 }, (_, index) => ({ name: `f${index}`, data: text("x") })),
    );
    await expect(
      extractTarGz(await write("m.tar.gz", many), output, { ...limits, maxEntries: 4 }),
    ).rejects.toThrow(/too many files/u);
    const big = makeTarGz([{ name: "big", data: Buffer.alloc(5_000) }]);
    await NodeFSP.rm(output, { recursive: true });
    await NodeFSP.mkdir(output);
    await expect(
      extractTarGz(await write("b.tar.gz", big), output, { ...limits, maxFileBytes: 4_000 }),
    ).rejects.toThrow(/too large/u);
    expect(await listOutput()).toEqual([]);
  });

  it("rejects a file that is not gzip, and a gzip that is not tar", async () => {
    await expect(
      extractTarGz(await write("x.tar.gz", text("plain text, not gzip")), output, limits),
    ).rejects.toThrow();
    const notTar = NodeZlib.gzipSync(Buffer.alloc(1024, 65));
    await expect(extractTarGz(await write("y.tar.gz", notTar), output, limits)).rejects.toThrow(
      /damaged header/u,
    );
  });

  it("accepts an archive that ends at a block boundary without the end marker", async () => {
    const bare = NodeZlib.gzipSync(tarBlocks([{ name: "a.txt", data: text("hi") }]));
    const result = await extractTarGz(await write("bare.tar.gz", bare), output, limits);
    expect(result.files).toBe(1);
  });
});

describe("placeRawFile", () => {
  it("copies a bare executable to the name the registry launches", async () => {
    const source = await write("sigit-win-amd64.exe", text("MZ"));
    expect(await placeRawFile(source, output, "sigit-win-amd64.exe", limits)).toEqual({
      files: 1,
      bytes: 2,
    });
    expect(await listOutput()).toEqual(["sigit-win-amd64.exe"]);
  });

  it("refuses an unsafe target name", async () => {
    const source = await write("x.exe", text("MZ"));
    await expect(placeRawFile(source, output, "../x.exe", limits)).rejects.toBeInstanceOf(
      ArchiveError,
    );
    await nothingEscaped();
  });
});

describe("extractLimitsFor", () => {
  it("scales with the download but never past 6 GiB", () => {
    expect(extractLimitsFor(10).maxTotalBytes).toBe(1024 * 1024 * 1024);
    expect(extractLimitsFor(100 * 1024 * 1024).maxTotalBytes).toBe(1200 * 1024 * 1024);
    expect(extractLimitsFor(10 * 1024 * 1024 * 1024).maxTotalBytes).toBe(6 * 1024 * 1024 * 1024);
  });
});
