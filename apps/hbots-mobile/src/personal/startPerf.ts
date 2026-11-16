/**
 * Stage times of a cold start, for the server's client-diag log: when the JS bundle began to
 * run, when the saved session was read, and when the chat list first painted from its saved
 * copy and from live data. Whole milliseconds on the JS clock (performance.now()), numbers
 * and one flag only: no chat text, id or key material leaves here.
 */

export type StartMark = "jsMain" | "session" | "cachedList" | "liveList";

const MARK_FIELDS: Record<StartMark, string> = {
  jsMain: "jsMainMs",
  session: "sessionMs",
  cachedList: "cachedListMs",
  liveList: "liveListMs",
};

export type StartPerfBody = Record<string, number | string | boolean>;

export interface StartPerf {
  /** Record a mark. The first time a mark is taken wins. */
  readonly mark: (mark: StartMark, at: number) => void;
  /** True when the process was started in front of the user (a tap), not by a background wake. */
  readonly setCold: (cold: boolean) => void;
  /** The beacon body, once per process: null when already taken or nothing was marked. */
  readonly take: () => StartPerfBody | null;
}

export function createStartPerf(): StartPerf {
  const marks = new Map<StartMark, number>();
  let cold = false;
  let taken = false;
  return {
    mark: (mark, at) => {
      if (!marks.has(mark)) marks.set(mark, at);
    },
    setCold: (value) => {
      cold = value;
    },
    take: () => {
      if (taken || marks.size === 0) return null;
      taken = true;
      const body: StartPerfBody = { event: "perf", journey: "a-start" };
      for (const mark of Object.keys(MARK_FIELDS) as StartMark[]) {
        const at = marks.get(mark);
        if (at !== undefined) body[MARK_FIELDS[mark]] = Math.round(at);
      }
      body.cold = cold;
      return body;
    },
  };
}

const processStart = createStartPerf();

export function noteStartMark(mark: StartMark): void {
  processStart.mark(mark, performance.now());
}

export function noteStartCold(cold: boolean): void {
  processStart.setCold(cold);
}

export function takeStartReport(): StartPerfBody | null {
  return processStart.take();
}
