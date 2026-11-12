export interface SheetMotionPort {
  readonly animateTo: (target: 0 | 1, done: (finished: boolean) => void) => void;
  readonly snapTo: (target: 0 | 1) => void;
}

export interface SheetPresence {
  readonly show: (reduced: boolean) => void;
  readonly hide: (reduced: boolean) => void;
}

/**
 * Keeps a sheet mounted until its close motion finishes. A close that is cut
 * short by a reopen never unmounts, and a stale completion is ignored.
 */
export function createSheetPresence(
  port: SheetMotionPort,
  setMounted: (mounted: boolean) => void,
): SheetPresence {
  let mounted = false;
  let generation = 0;
  return {
    show: (reduced) => {
      generation += 1;
      mounted = true;
      setMounted(true);
      if (reduced) port.snapTo(1);
      else port.animateTo(1, () => undefined);
    },
    hide: (reduced) => {
      if (!mounted) return;
      generation += 1;
      const mine = generation;
      if (reduced) {
        port.snapTo(0);
        mounted = false;
        setMounted(false);
        return;
      }
      port.animateTo(0, (finished) => {
        if (!finished || mine !== generation) return;
        mounted = false;
        setMounted(false);
      });
    },
  };
}
