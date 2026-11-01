import {
  readDeveloperView as readDeveloperViewIn,
  setDeveloperView as setDeveloperViewIn,
} from "@hbots/personal-client/bots/personalMode";

import { webSessionKeyValueStore } from "./platform/webStorage";

export * from "@hbots/personal-client/bots/personalMode";

export const readDeveloperView = (): boolean => readDeveloperViewIn(webSessionKeyValueStore);

export const setDeveloperView = (enabled: boolean): void =>
  setDeveloperViewIn(webSessionKeyValueStore, enabled);
