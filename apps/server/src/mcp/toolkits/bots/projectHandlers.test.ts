import { EnvironmentId, PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import { PersonalEngine } from "../../../personal/engine/PersonalEngine.ts";
import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import { PersonalBrowser } from "../../../personal/browser/PersonalBrowser.ts";
import { PersonalGroupService } from "../../../personal/groups/PersonalGroupService.ts";
import { PersonalLeadBotService } from "../../../personal/leadBots/PersonalLeadBotService.ts";
import * as PersonalProjectRepository from "../../../personal/projects/PersonalProjectRepository.ts";
import { PersonalLoginRequestService } from "../../../personal/secrets/PersonalLoginRequestService.ts";
import { PersonalLoginService } from "../../../personal/secrets/PersonalLoginService.ts";
import { PersonalSecretService } from "../../../personal/secrets/PersonalSecretService.ts";
import {
  PersonalTaskService,
  type PersonalTaskDelegateInput,
} from "../../../personal/tasks/PersonalTaskService.ts";
import { mcpThreadScope } from "../../../personal/testing/mcpThreadScope.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { BotsToolkitHandlersLive } from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const LEAD = PersonalBotId.make("bot-poteto");
const BUILDER = PersonalBotId.make("bot-builder");
const THREAD = ThreadId.make("thread-lead");

const STEPS = [
  { label: "Build", state: "done" as const },
  { label: "Verify on emulator", state: "doing" as const },
  { label: "Release", state: "todo" as const },
];

function harness(input: { readonly lead: boolean }) {
  const delegated: Array<PersonalTaskDelegateInput> = [];
  const bot = (botId: PersonalBotId, name: string, lead: boolean) =>
    ({ botId, name, lead, enabled: true, team: "pstack", deletedAt: null }) as never;
  const layer = BotsToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.mock(PersonalTaskService)({
        resolveCallerTask: () => Effect.succeed({ taskId: "task-lead" } as never),
        taskForThread: () => Effect.succeed(Option.none()),
        delegate: (request) => {
          delegated.push(request);
          return Effect.succeed({ taskId: "task-child", status: "queued" } as never);
        },
      }),
    ),
    Layer.provide(
      Layer.mock(PersonalBotRepository)({
        getThreadLink: () => Effect.succeed(Option.some({ botId: LEAD } as never)),
        getBotById: () => Effect.succeed(Option.some(bot(LEAD, "Poteto", input.lead))),
        listBots: () =>
          Effect.succeed([bot(LEAD, "Poteto", input.lead), bot(BUILDER, "Builder", false)]),
      }),
    ),
    Layer.provide(Layer.mock(PersonalSecretService)({})),
    Layer.provide(Layer.mock(PersonalLoginService)({})),
    Layer.provide(Layer.mock(PersonalLoginRequestService)({})),
    Layer.provide(
      Layer.mock(PersonalEngine)({
        getThread: () =>
          Effect.succeed(Option.some({ session: { activeTurnId: "turn" } } as never)),
        latestUserMessage: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(Layer.mock(PersonalBrowser)({})),
    Layer.provide(
      Layer.mock(PersonalGroupService)({
        groupNameForMemberThread: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(Layer.mock(PersonalLeadBotService)({})),
    Layer.provideMerge(PersonalProjectRepository.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const call = (tool: "update_project" | "delegate_task", params: unknown) =>
    Effect.gen(function* () {
      const toolkit = yield* BotsToolkit;
      const results = yield* toolkit
        .handle(tool, params as never)
        .pipe(Stream.unwrap, Stream.runCollect);
      return encode(results);
    });
  const run = <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layer> | McpInvocationContext>,
  ) =>
    effect.pipe(
      Effect.provide(layer),
      Effect.provideService(
        McpInvocationContext,
        mcpThreadScope({
          environmentId: EnvironmentId.make("env"),
          threadId: THREAD,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["bots" as const]),
          issuedAt: 1,
        }),
      ),
    );
  return { delegated, run, call };
}

describe("update_project", () => {
  it.effect("refuses a bot that is not a team lead", () => {
    const { run, call } = harness({ lead: false });
    return run(
      Effect.gen(function* () {
        const refusal = yield* Effect.flip(
          call("update_project", { name: "Matchday optimisation", steps: STEPS }),
        );
        expect(refusal).toMatchObject({ reason: "Only a team lead keeps projects." });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT project_id FROM personal_projects`;
        expect(rows).toHaveLength(0);
      }),
    );
  });

  it.effect("the same call twice keeps one project", () => {
    const { run, call } = harness({ lead: true });
    return run(
      Effect.gen(function* () {
        const params = { name: "Matchday optimisation", steps: STEPS, minutesLeft: 120 };
        yield* call("update_project", params);
        const second = yield* call("update_project", params);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly name: string }>`
          SELECT name FROM personal_projects WHERE lead_bot_id = ${LEAD}
        `;
        expect(rows).toEqual([{ name: "Matchday optimisation" }]);
        expect(second).toContain("Matchday optimisation: step 2 of 3 (Verify on emulator)");
        expect(second).toContain("about 2 h left");
      }),
    );
  });

  it.effect("why is stored, kept when left out and cleared by an empty string", () => {
    const { run, call } = harness({ lead: true });
    return run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const why = () =>
          sql<{ readonly why: string | null }>`
            SELECT why FROM personal_projects WHERE lead_bot_id = ${LEAD}
          `.pipe(Effect.map((rows) => rows[0]?.why ?? null));
        yield* call("update_project", { name: "Kino", steps: STEPS, why: "Why it matters" });
        expect(yield* why()).toBe("Why it matters");
        yield* call("update_project", { name: "Kino" });
        expect(yield* why()).toBe("Why it matters");
        yield* call("update_project", { name: "Kino", why: "" });
        expect(yield* why()).toBeNull();
      }),
    );
  });
});

describe("delegate_task with a project", () => {
  it.effect("passes the open project's id to the child", () => {
    const { run, call, delegated } = harness({ lead: true });
    return run(
      Effect.gen(function* () {
        yield* call("update_project", { name: "CalTrack Android port", steps: STEPS });
        const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
        const project = yield* projects.findOpen({
          leadBotId: LEAD,
          name: "caltrack android port",
        });
        yield* call("delegate_task", {
          targetBot: "Builder",
          objective: "Port the settings screen.",
          project: "CALTRACK android PORT",
        });
        expect(delegated.map((entry) => entry.projectId)).toEqual([project?.projectId]);
      }),
    );
  });

  it.effect("an unknown name is an error that lists the open names", () => {
    const { run, call, delegated } = harness({ lead: true });
    return run(
      Effect.gen(function* () {
        yield* call("update_project", { name: "Matchday optimisation", steps: STEPS });
        yield* call("update_project", { name: "hbots changes", steps: STEPS });
        const refusal = yield* Effect.flip(
          call("delegate_task", {
            targetBot: "Builder",
            objective: "Port the settings screen.",
            project: "Kino",
          }),
        );
        const reason = (refusal as { readonly reason: string }).reason;
        expect(reason).toContain('No open project is named "Kino"');
        expect(reason).toContain("Matchday optimisation");
        expect(reason).toContain("hbots changes");
        expect(delegated).toHaveLength(0);
      }),
    );
  });
});
