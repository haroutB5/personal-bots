/**
 * Personal services the WS RPC layer needs, mocked for U tests that build that layer.
 *
 * @module personal/testing/personalWsMocks
 */
import * as Layer from "effect/Layer";

import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalBotTokenUsage from "../PersonalBotTokenUsageService.ts";
import * as PersonalBrowser from "../browser/PersonalBrowser.ts";
import * as PersonalConnectionApprovalService from "../connections/approvalService.ts";
import * as PersonalConnectionService from "../connections/service.ts";
import * as PersonalDesktop from "../desktop/PersonalDesktop.ts";
import * as PersonalEngine from "../engine/PersonalEngine.ts";
import * as PersonalGroupService from "../groups/PersonalGroupService.ts";
import * as PersonalLeadBots from "../leadBots/PersonalLeadBotService.ts";
import * as PersonalLoginRequestService from "../secrets/PersonalLoginRequestService.ts";
import * as PersonalLoginService from "../secrets/PersonalLoginService.ts";
import * as PersonalMemoryService from "../memory/PersonalMemoryService.ts";
import * as PersonalMemoryTidy from "../memory/PersonalMemoryTidyService.ts";
import * as PersonalProviderUpdates from "../providerUpdates/PersonalProviderUpdates.ts";
import * as PersonalPushService from "../push/PersonalPushService.ts";
import * as PersonalRoutineService from "../routines/PersonalRoutineService.ts";
import * as PersonalSecretService from "../secrets/PersonalSecretService.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalVoiceCallService from "../voiceCalls/PersonalVoiceCallService.ts";
import * as PersonalVoiceSampleService from "../voiceCalls/PersonalVoiceSampleService.ts";

export const layerUnusedPersonalWsServices = Layer.mergeAll(
  Layer.mock(PersonalBotRepository.PersonalBotRepository)({}),
  Layer.mock(PersonalBotService.PersonalBotService)({}),
  Layer.mock(PersonalBotTokenUsage.PersonalBotTokenUsage)({}),
  Layer.mock(PersonalBrowser.PersonalBrowser)({}),
  Layer.mock(PersonalConnectionApprovalService.PersonalConnectionApprovalService)({}),
  Layer.mock(PersonalConnectionService.PersonalConnectionService)({}),
  Layer.mock(PersonalDesktop.PersonalDesktop)({ available: false }),
  Layer.mock(PersonalEngine.PersonalEngine)({}),
  Layer.mock(PersonalGroupService.PersonalGroupService)({}),
  Layer.mock(PersonalLeadBots.PersonalLeadBotService)({}),
  Layer.mock(PersonalLoginRequestService.PersonalLoginRequestService)({}),
  Layer.mock(PersonalLoginService.PersonalLoginService)({}),
  Layer.mock(PersonalMemoryService.PersonalMemoryService)({}),
  Layer.mock(PersonalMemoryTidy.PersonalMemoryTidy)({}),
  Layer.mock(PersonalProviderUpdates.PersonalProviderUpdates)({}),
  Layer.mock(PersonalPushService.PersonalPushService)({}),
  Layer.mock(PersonalRoutineService.PersonalRoutineService)({}),
  Layer.mock(PersonalSecretService.PersonalSecretService)({}),
  Layer.mock(PersonalTaskService.PersonalTaskService)({}),
  Layer.mock(PersonalVoiceCallService.PersonalVoiceCallService)({}),
  Layer.mock(PersonalVoiceSampleService.PersonalVoiceSampleService)({}),
);
