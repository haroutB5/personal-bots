export interface PulseGate {
  readonly focused: boolean;
  readonly appState: string;
  readonly reduced: boolean;
}

export function pulseRuns({ focused, appState, reduced }: PulseGate): boolean {
  return focused && appState === "active" && !reduced;
}
