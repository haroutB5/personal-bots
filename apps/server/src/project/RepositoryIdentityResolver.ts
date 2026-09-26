import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
/**
 * Background sweeps resolve every project each minute. A long TTL keeps them
 * from spawning git each time (at a TTL equal to the sweep period every sweep
 * re-spawned `git rev-parse` + `git remote -v` for each repository root: 812 ms
 * of idle CPU per minute on Windows in the 2026-09-22 audit). Clone, publish,
 * and PR discovery (after a turn and before it saves links) resolve with
 * `refresh: true`.
 */
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
// Short, so a folder that gains a remote shows up quickly.
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);
/**
 * "This directory is not a repository" is the one answer that cannot go stale
 * on its own: nothing but a `git init` changes it, and that is a thing a person
 * does, not something that drifts. Every other cached answer keeps the short
 * TTL above.
 *
 * It gets its own, much longer TTL because the short one was the single
 * largest source of this server's idle cost. The bots' workspaces are not
 * repositories, so a one-minute negative TTL meant `git rev-parse
 * --show-toplevel` was re-spawned against each of them every minute forever —
 * 8 git spawns plus 13 conhosts per 7 minutes in a 2026-09-16 host
 * measurement, most of an idle core on Windows, where every "cheap" check costs
 * 2-4 process creations. The cost of caching is that a folder someone
 * `git init`s is recognised up to one TTL later; `resolve(cwd, { refresh:
 * true })` still sees it at once.
 */
const DEFAULT_NOT_A_REPOSITORY_CACHE_TTL = Duration.minutes(20);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  /** How long git's "not a repository" answer is trusted. See the constant. */
  readonly notARepositoryCacheTtl?: Duration.Input;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

/**
 * `git rev-parse --show-toplevel` exits 128 both for a directory that is not a
 * repository and for one that does not exist — the two definitive "no root
 * here" answers. Any other failure (spawn error, timeout, some other non-zero
 * code) means git did not answer, which must stay uncached so a transient
 * failure does not pin a workspace root to `null` for a whole TTL.
 */
const GIT_NOT_A_REPOSITORY_EXIT_CODE = 128;

/** git could not answer. Never cached, so the next resolve retries. */
class GitRootUnavailable {
  readonly _tag = "GitRootUnavailable";
}

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.timedOut) {
      return yield* Effect.fail(new GitRootUnavailable());
    }
    if (topLevelResult.value.code !== 0) {
      return topLevelResult.value.code === GIT_NOT_A_REPOSITORY_EXIT_CODE
        ? null
        : yield* Effect.fail(new GitRootUnavailable());
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const remoteResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cacheKey, "remote", "-v"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
  return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  // Git errors and timeouts resolve to null, so they use the negative TTL like
  // "no repository" or "no remote". Only interrupts and defects skip the cache.
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === null
          ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
          : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
      onFailure: () => Duration.zero,
    });

  const repositoryRootCache = yield* Cache.makeWith<string, string | null, GitRootUnavailable>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    {
      capacity: cacheCapacity,
      // A root that is not a git repository is cached for the long
      // not-a-repository TTL. Without any caching every caller re-spawns `git
      // rev-parse` for a non-repo workspace root forever: a shell snapshot over
      // four roots, three of them non-repos, measured 977-1816 ms and was the
      // slowest endpoint in the app by three orders of magnitude, and the same
      // loop later turned out to be most of the server's idle CPU.
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null
            ? (options.notARepositoryCacheTtl ?? DEFAULT_NOT_A_REPOSITORY_CACHE_TTL)
            : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.filterOrElse(
          (identity): identity is null => identity === null,
          (identity) => refine(identity).pipe(Effect.orElseSucceed(() => identity)),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  // Untraced because almost every call is a cache hit. The lookups that spawn
  // git keep their own spans.
  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      // A lookup git could not answer surfaces as a cache failure, which is never
      // cached; the caller sees the same `null` it always did.
      const cacheKeyResult = yield* Cache.get(repositoryRootCache, cwd).pipe(Effect.option);
      const cacheKey = cacheKeyResult._tag === "Some" ? cacheKeyResult.value : null;
      if (cacheKey === null) return null;
      if (options?.refresh) yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    },
  );

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
