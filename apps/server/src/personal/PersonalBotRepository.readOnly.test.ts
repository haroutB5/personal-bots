import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import { seedV2Message, seedV2Thread } from "./test/v2ProjectionSeed.ts";

const botId = PersonalBotId.make("bot-e1");
const threadId = ThreadId.make("thread-e1");

const decodeCreateBot = Schema.decodeSync(PersonalBotRepository.CreatePersonalBotInput);
const decodeInsertThreadLink = Schema.decodeSync(
  PersonalBotRepository.InsertPersonalBotThreadInput,
);

/** File-backed WAL with the shipping reader worker; an in-memory database cannot open one. */
const makeLayer = () => {
  const scratch = NodePath.join(process.cwd(), ".tmp");
  NodeFS.mkdirSync(scratch, { recursive: true });
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "e1-readonly-"));
  const dbPath = NodePath.join(dir, "state.sqlite");
  const persistence = SqlitePersistence.layerFromPath(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  return PersonalBotRepository.layer.pipe(Layer.provideMerge(persistence));
};

it.live(
  "every personal read succeeds on a file-backed reader and listThreadLinks keeps the baseline",
  () =>
    Effect.gen(function* () {
      const repository = yield* PersonalBotRepository.PersonalBotRepository;

      yield* repository.createBot(
        decodeCreateBot({
          botId,
          name: "E1",
          title: "Lead",
          description: "Reads.",
          instructions: "Read.",
          avatarShape: "blob",
          avatarColor: "#1A73E8",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5-5",
          },
          team: "dev",
          lead: true,
          pinned: true,
          sortOrder: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        }),
      );
      yield* repository.insertThreadLink(
        decodeInsertThreadLink({
          botId,
          threadId,
          createdAt: "2026-10-01T00:00:00.000Z",
        }),
      );
      yield* seedV2Thread({ threadId, title: "E1 chat", createdAt: "2026-10-01T00:00:00.000Z" });
      yield* seedV2Message({
        messageId: "m-e1",
        threadId,
        role: "assistant",
        text: "read me",
        createdAt: "2026-10-01T00:05:00.000Z",
      });

      // The baseline is written on the writer before any read runs, so a fresh
      // database cannot leave listThreadLinks a write on the read-only reader.
      expect(
        (yield* repository.listThreadLinks()).map((link) => [link.botId, link.threadId]),
      ).toEqual([[botId, threadId]]);
      const baseline = yield* repository.getMeta({
        key: PersonalBotRepository.PERSONAL_CHAT_UNREAD_SINCE_META_KEY,
      });
      expect(Option.isSome(baseline)).toBe(true);

      expect(yield* repository.listBots()).toEqual([
        expect.objectContaining({ botId, name: "E1", title: "Lead" }),
      ]);
      expect((yield* repository.getBotById({ botId })).pipe(Option.map((bot) => bot.name))).toEqual(
        Option.some("E1"),
      );
      expect(
        (yield* repository.listThreadLinks()).map((link) => [link.botId, link.threadId]),
      ).toEqual([[botId, threadId]]);
      expect((yield* repository.getThreadLink({ threadId })).pipe(Option.isSome)).toBe(true);
      expect(yield* repository.isGroupRelay({ threadId })).toBe(false);
      expect(yield* repository.listFallbackStates()).toEqual([]);
      expect(yield* repository.searchMessages({ needle: "read me", limit: 10 })).toEqual([
        expect.objectContaining({ threadId, snippet: "read me" }),
      ]);
      expect(yield* repository.listOpenThreadIds()).toEqual([threadId]);
      expect(yield* repository.openThreadIds([threadId])).toEqual(new Set([threadId]));
      expect(yield* repository.listArchivedChatCounts()).toEqual([]);
      expect(yield* repository.listBotProviderSessions()).toEqual([]);
      expect(yield* repository.listOpenChatTitles({ botId })).toEqual(["E1 chat"]);
      expect((yield* repository.listOpenChats({ botId })).map((chat) => chat.threadId)).toEqual([
        threadId,
      ]);
      expect(yield* repository.getChatFacts({ threadId })).toEqual(
        Option.some(expect.objectContaining({ threadId, botId })),
      );
      expect(
        (yield* repository.listDirectChats({ botId, limit: 10 })).map((chat) => chat.threadId),
      ).toEqual([threadId]);
      expect(yield* repository.getRemovedChatOrigin({ threadId })).toEqual(Option.none());
      expect(yield* repository.getChatTitleScope({ threadId })).toEqual(
        Option.some(expect.objectContaining({ botId, archived: false })),
      );
      expect(yield* repository.listGroupPresence()).toEqual([
        expect.objectContaining({ botId, groupIds: [], hasPrivateChat: true }),
      ]);
      expect(yield* repository.getMeta({ key: "missing" })).toEqual(Option.none());
      expect(yield* repository.getInstructionsForThread({ threadId })).toEqual(
        Option.some(expect.objectContaining({ name: "E1", title: "Lead" })),
      );
      expect(yield* repository.listThreadAttachments()).toEqual([]);

      const second = yield* repository.getMeta({
        key: PersonalBotRepository.PERSONAL_CHAT_UNREAD_SINCE_META_KEY,
      });
      expect(second).toEqual(baseline);
    }).pipe(Effect.provide(makeLayer()), Effect.scoped),
);
