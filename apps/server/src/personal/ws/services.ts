import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalConnectionApprovalService from "../connections/approvalService.ts";
import * as PersonalConnectionService from "../connections/service.ts";
import { PersonalProvidersV2Live } from "../engine/PersonalProvidersV2Live.ts";
import * as PersonalLeadBots from "../leadBots/PersonalLeadBotService.ts";
import * as PersonalMemoryService from "../memory/PersonalMemoryService.ts";
import * as PersonalMemoryTidy from "../memory/PersonalMemoryTidyService.ts";
import * as PersonalPushService from "../push/PersonalPushService.ts";
import * as PersonalRoutineService from "../routines/PersonalRoutineService.ts";
import * as PersonalLoginService from "../secrets/PersonalLoginService.ts";
import * as PersonalSecretService from "../secrets/PersonalSecretService.ts";
import { makePersonalSessionPrewarmer } from "../sessionPrewarm.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";

/**
 * Server-lifetime personal services the websocket route hands down. One
 * instance per process keeps the task dispatcher, push queue and login
 * requests shared across every connected client.
 */
export const makePersonalWsServices = () =>
  Effect.gen(function* () {
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const secrets = yield* PersonalSecretService.PersonalSecretService;
    const logins = yield* PersonalLoginService.PersonalLoginService;
    const connections = yield* PersonalConnectionService.PersonalConnectionService;
    const connectionApprovals =
      yield* PersonalConnectionApprovalService.PersonalConnectionApprovalService;
    const leadBots = yield* PersonalLeadBots.PersonalLeadBotService;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const memory = yield* PersonalMemoryService.PersonalMemoryService;
    const memoryTidy = yield* PersonalMemoryTidy.PersonalMemoryTidy;
    const push = yield* PersonalPushService.PersonalPushService;
    return {
      tasks,
      secrets,
      logins,
      connections,
      connectionApprovals,
      leadBots,
      routines,
      memory,
      memoryTidy,
      push,
    };
  });

export type PersonalWsServices = Effect.Success<ReturnType<typeof makePersonalWsServices>>;

/** The per-chat prewarm debounce outlives one connection, like the services above. */
export const makePersonalWsSessionPrewarmer = makePersonalSessionPrewarmer().pipe(
  Effect.provide(PersonalProvidersV2Live),
);

/** The exact service instances the ws handlers must share with the server. */
export const personalWsProvisionLayer = (services: PersonalWsServices) =>
  Layer.mergeAll(
    PersonalBotService.layer.pipe(Layer.provide(PersonalBotRepository.layer)),
    Layer.succeed(PersonalTaskService.PersonalTaskService, services.tasks),
    Layer.succeed(PersonalSecretService.PersonalSecretService, services.secrets),
    Layer.succeed(PersonalLoginService.PersonalLoginService, services.logins),
    Layer.succeed(PersonalConnectionService.PersonalConnectionService, services.connections),
    Layer.succeed(
      PersonalConnectionApprovalService.PersonalConnectionApprovalService,
      services.connectionApprovals,
    ),
    Layer.succeed(PersonalLeadBots.PersonalLeadBotService, services.leadBots),
    Layer.succeed(PersonalRoutineService.PersonalRoutineService, services.routines),
    Layer.succeed(PersonalMemoryService.PersonalMemoryService, services.memory),
    Layer.succeed(PersonalMemoryTidy.PersonalMemoryTidy, services.memoryTidy),
    Layer.succeed(PersonalPushService.PersonalPushService, services.push),
  );
