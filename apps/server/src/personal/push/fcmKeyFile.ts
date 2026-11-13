// @effect-diagnostics nodeBuiltinImport:off - one small optional file read from the server's data folder.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import { FcmKeyFile } from "./fcmSender.ts";

export const FCM_KEY_FILE_NAME = "fcm-service-account.json";

/** Missing or unreadable means "no file": the sender then reports push as disabled. */
export const fcmKeyFileLive = Layer.effect(
  FcmKeyFile,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = NodePath.join(config.baseDir, "personal", FCM_KEY_FILE_NAME);
    return {
      read: Effect.promise(() =>
        NodeFSP.readFile(path).then(
          (bytes) => Option.some(new Uint8Array(bytes)),
          () => Option.none<Uint8Array>(),
        ),
      ),
    };
  }),
);
