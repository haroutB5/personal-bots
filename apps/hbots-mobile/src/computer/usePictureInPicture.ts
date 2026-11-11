import { useEffect, useRef, useState } from "react";

import { onPipChanged, setPip } from "./pipBridge";
import { samePipRequest, type FrameSize } from "./pipModel";

const DEFAULT_FRAME: FrameSize = { width: 16, height: 9 };

/** True while the window is in picture-in-picture. */
export function useInPip(): boolean {
  const [inPip, setInPip] = useState(false);
  useEffect(() => onPipChanged(setInPip), []);
  return inPip;
}

/**
 * Keeps Android's auto enter PiP in step with `enabled`, with the last frame's shape for the
 * window. Turns auto enter off when the screen goes away.
 */
export function usePipRequest(enabled: boolean, frame: FrameSize | null): void {
  const last = useRef<{ enabled: boolean; frame: FrameSize } | null>(null);
  const width = frame?.width ?? DEFAULT_FRAME.width;
  const height = frame?.height ?? DEFAULT_FRAME.height;

  useEffect(() => {
    const next = { enabled, frame: { width, height } };
    if (last.current !== null && samePipRequest(last.current, next)) return;
    last.current = next;
    setPip(enabled, width, height);
  }, [enabled, width, height]);

  useEffect(
    () => () => {
      last.current = null;
      setPip(false, DEFAULT_FRAME.width, DEFAULT_FRAME.height);
    },
    [],
  );
}
