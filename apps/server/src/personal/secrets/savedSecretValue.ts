/**
 * The server's own read of a saved secret by name, for a feature the server
 * itself runs (the Coolify app health on the Bots page). Same slot order as
 * the phone push key (push/fcmSender.ts): the shared slot first, then each
 * bot's private slot that holds this name, newest save first.
 *
 * The value comes back Redacted. It is for a request header only: never log
 * it, never put it in a response, never hand it to a bot.
 */
import type { PersonalBotId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalSecretRepository from "./PersonalSecretRepository.ts";
import { personalSecretStoreKey } from "./PersonalSecretService.ts";

export function savedSecretStoreKeys(
  name: string,
  rows: ReadonlyArray<{
    readonly name: string;
    readonly botId: PersonalBotId;
    readonly shared: boolean;
    readonly fulfilledAtMs: number;
  }>,
): ReadonlyArray<string> {
  const privateRows = rows
    .filter((row) => row.name === name && !row.shared)
    .toSorted((a, b) => b.fulfilledAtMs - a.fulfilledAtMs);
  return [
    personalSecretStoreKey(name),
    ...privateRows.map((row) =>
      personalSecretStoreKey({ name: row.name, botId: row.botId, shared: false }),
    ),
  ];
}

/** The saved value, trimmed, or none when no slot holds a non-empty value. Never fails. */
export const readSavedSecretValue = (
  name: string,
): Effect.Effect<
  Option.Option<Redacted.Redacted<string>>,
  never,
  ServerSecretStore.ServerSecretStore | PersonalSecretRepository.PersonalSecretRepository
> =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const repository = yield* PersonalSecretRepository.PersonalSecretRepository;
    const rows = yield* repository.listByStatus("fulfilled").pipe(Effect.orElseSucceed(() => []));
    const keys = savedSecretStoreKeys(
      name,
      rows.map((row) => ({
        name: row.name,
        botId: row.botId,
        shared: row.shared,
        fulfilledAtMs: row.fulfilledAt === null ? 0 : DateTime.toEpochMillis(row.fulfilledAt),
      })),
    );
    for (const key of keys) {
      const found = yield* store
        .get(key)
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isSome(found)) {
        const text = new TextDecoder().decode(found.value).trim();
        if (text !== "") return Option.some(Redacted.make(text));
      }
    }
    return Option.none();
  });
