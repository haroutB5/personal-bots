import { AppState } from "react-native";

import { noteStartCold, noteStartMark } from "./startPerf";

/** First import of index.ts: the clock reading is when the bundle began to run. */
noteStartMark("jsMain");
noteStartCold(AppState.currentState === "active");
