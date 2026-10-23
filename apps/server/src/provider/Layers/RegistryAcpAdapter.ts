import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ProviderDriverKind } from "@t3tools/contracts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { CatalogInstaller } from "../catalog/installer.ts";
import { toSpawnInput } from "../catalog/launch.ts";
import { makeNativeAcpAdapter, type NativeAcpAdapterOptions } from "./NativeAcpAdapter.ts";

export interface RegistryAcpAdapterOptions extends Omit<
  NativeAcpAdapterOptions,
  "provider" | "runtimeOptions" | "configureTurn"
> {
  readonly catalogId: string;
  readonly nodePath: string | null;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export function makeRegistryAcpAdapter(options: RegistryAcpAdapterOptions) {
  return Effect.gen(function* () {
    const installer = yield* CatalogInstaller;
    const path = yield* Path.Path;
    const provider = ProviderDriverKind.make("registry");
    return yield* makeNativeAcpAdapter({
      ...options,
      provider,
      runtimeOptions: (input) =>
        Effect.gen(function* () {
          const installed = yield* installer.acquire(options.catalogId).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider,
                  threadId: input.threadId,
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
          const spawn = toSpawnInput(
            installed,
            {
              nodePath: options.nodePath,
              hostEnvironment: options.hostEnvironment ?? process.env,
              ...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
            },
            path.join,
          );
          if (!spawn)
            return yield* new ProviderAdapterProcessError({
              provider,
              threadId: input.threadId,
              detail: "Could not resolve launch program for registry agent.",
            });
          return {
            spawn,
            cwd: path.resolve(input.cwd!),
            authMethodId: null,
            clientInfo: { name: "hbots", version: "1.66.77" },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          };
        }),
    });
  });
}
