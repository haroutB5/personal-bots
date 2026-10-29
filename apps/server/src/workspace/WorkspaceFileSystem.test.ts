// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toEqual({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
        });
      }),
    );

    // The home folder and path map come from the process, so each test sets
    // them for its own run.
    const withHost = <A, E, R>(
      host: { readonly home: string; readonly pathMap?: string },
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = { home: process.env.HOME, pathMap: process.env.T3CODE_PATH_MAP };
          process.env.HOME = host.home;
          if (host.pathMap === undefined) delete process.env.T3CODE_PATH_MAP;
          else process.env.T3CODE_PATH_MAP = host.pathMap;
          return previous;
        }),
        () => effect,
        (previous) =>
          Effect.sync(() => {
            if (previous.home === undefined) delete process.env.HOME;
            else process.env.HOME = previous.home;
            if (previous.pathMap === undefined) delete process.env.T3CODE_PATH_MAP;
            else process.env.T3CODE_PATH_MAP = previous.pathMap;
          }),
      );

    it.effect("finds a home-relative path the workspace does not have", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir;
        const cwd = path.join(home, ".bots", "workspace");
        yield* writeTextFile(cwd, "keep.txt", "x");
        yield* writeTextFile(home, ".bots/qa/run/RESULT.md", "# Result\n");

        const result = yield* withHost(
          { home },
          workspaceFileSystem.readFile({ cwd, relativePath: ".bots/qa/run/RESULT.md" }),
        );

        expect(result.contents).toBe("# Result\n");
        expect(result.relativePath).toBe(path.join(home, ".bots/qa/run/RESULT.md"));
      }),
    );

    it.effect("prefers the workspace file over a home file of the same relative path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir;
        const cwd = path.join(home, "work");
        yield* writeTextFile(cwd, "notes/a.md", "workspace");
        yield* writeTextFile(home, "notes/a.md", "home");

        const result = yield* withHost(
          { home },
          workspaceFileSystem.readFile({ cwd, relativePath: "notes/a.md" }),
        );

        expect(result).toMatchObject({ relativePath: "notes/a.md", contents: "workspace" });
      }),
    );

    it.effect("expands ~/ and maps Windows paths through the path map", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(home, "Claude/AI/notes.md", "tilde");
        yield* writeTextFile(home, "Desktop/win.md", "windows");
        const pathMap = `C:/Users/Ht=${home};C:/Claude/AI=${path.join(home, "Claude/AI")}`;

        const tilde = yield* withHost(
          { home, pathMap },
          workspaceFileSystem.readFile({ cwd, relativePath: "~/Claude/AI/notes.md" }),
        );
        const mappedAi = yield* withHost(
          { home, pathMap },
          workspaceFileSystem.readFile({ cwd, relativePath: "C:/Claude/AI/notes.md" }),
        );
        const mappedHome = yield* withHost(
          { home, pathMap },
          workspaceFileSystem.readFile({ cwd, relativePath: "C:\\Users\\Ht\\Desktop\\win.md" }),
        );

        expect(tilde.contents).toBe("tilde");
        expect(mappedAi.contents).toBe("tilde");
        expect(mappedHome.contents).toBe("windows");
      }),
    );

    it.effect("reports a missing file as not found for every path shape", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const home = yield* makeTempDir;
        const cwd = yield* makeTempDir;

        for (const relativePath of ["missing/a.md", "~/missing.md", "C:/Users/Ht/missing.md"]) {
          const error = yield* withHost(
            { home, pathMap: `C:/Users/Ht=${home}` },
            workspaceFileSystem.readFile({ cwd, relativePath }),
          ).pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        }
      }),
    );

    it.effect("refuses credential files in every place a path can resolve", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempDir;
        const cwd = path.join(home, "work");
        yield* writeTextFile(cwd, ".env", "SECRET=1");
        yield* writeTextFile(cwd, "config/auth.json", "{}");
        yield* writeTextFile(home, ".ssh/id_ed25519", "key");
        yield* writeTextFile(home, "bot/userdata/state.sqlite", "db");
        yield* writeTextFile(home, "bot/userdata/attachments/ok.txt", "fine");
        yield* writeTextFile(cwd, ".env.example", "SECRET=");
        const pathMap = `C:/Users/Ht=${home}`;

        for (const relativePath of [
          ".env",
          "config/auth.json",
          ".ssh/id_ed25519",
          "~/.ssh/id_ed25519",
          path.join(home, ".ssh/id_ed25519"),
          "C:/Users/Ht/.ssh/id_ed25519",
          "bot/userdata/state.sqlite",
        ]) {
          const error = yield* withHost(
            { home, pathMap },
            workspaceFileSystem.readFile({ cwd, relativePath }),
          ).pipe(Effect.flip);
          expect(error, relativePath).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceProtectedFileError,
          );
        }

        const attachment = yield* withHost(
          { home, pathMap },
          workspaceFileSystem.readFile({ cwd, relativePath: "bot/userdata/attachments/ok.txt" }),
        );
        const template = yield* withHost(
          { home, pathMap },
          workspaceFileSystem.readFile({ cwd, relativePath: ".env.example" }),
        );
        expect(attachment.contents).toBe("fine");
        expect(template.contents).toBe("SECRET=");
      }),
    );

    it.effect("keeps ../ from reaching files outside the workspace and the home folder", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const base = yield* makeTempDir;
        const home = path.join(base, "home");
        const cwd = path.join(home, "work");
        yield* writeTextFile(cwd, "keep.txt", "x");
        yield* writeTextFile(base, "outside.md", "outside");

        for (const relativePath of ["../../outside.md", "~/../outside.md"]) {
          const error = yield* withHost(
            { home },
            workspaceFileSystem.readFile({ cwd, relativePath }),
          ).pipe(Effect.flip);
          expect(error, relativePath).not.toBeUndefined();
          expect(error).not.toHaveProperty("contents");
        }
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a harmless-looking symlink that points at a credential file",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const home = yield* makeTempDir;
          const cwd = path.join(home, "work");
          yield* writeTextFile(home, ".ssh/id_rsa", "key");
          yield* writeTextFile(cwd, "keep.txt", "x");
          yield* fileSystem.symlink(path.join(home, ".ssh/id_rsa"), path.join(home, "harmless.md"));

          const error = yield* withHost(
            { home },
            workspaceFileSystem.readFile({ cwd, relativePath: "harmless.md" }),
          ).pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceProtectedFileError);
        }),
    );

    // Needs mkfifo; Windows has no FIFOs to reject.
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const fifoPath = path.join(outsideDir, "pipe");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: fifoPath })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          yield* fileSystem.symlink(
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: "linked-secret.txt" })
            .pipe(Effect.flip);
          const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
          const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(error).toMatchObject({
            workspaceRoot: cwd,
            relativePath: "linked-secret.txt",
            resolvedWorkspaceRoot,
            resolvedPath,
          });
          expect("cause" in error).toBe(false);
        }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
