import {
  perfOptimizationOn as perfOptimizationOnIn,
  type PerfOptimization,
} from "@hbots/personal-client/perf/perfFlags";

import { webKeyValueStore } from "./platform/webStorage";

export { PERF_OFF_STORAGE_KEY, type PerfOptimization } from "@hbots/personal-client/perf/perfFlags";
export { whenIdle } from "./platform/webStorage";

export const perfOptimizationOn = (name: PerfOptimization): boolean =>
  perfOptimizationOnIn(webKeyValueStore, name);
