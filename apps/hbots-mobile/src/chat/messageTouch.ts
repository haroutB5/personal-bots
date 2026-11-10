import { createContext, useContext } from "react";

/**
 * Tells the message's long-press surface that the current touch began on a
 * link, file chip or choice button, which own the press. The default is a
 * no-op outside a message body.
 */
const MarkInteractiveTouchContext = createContext<() => void>(() => {});

export const MarkInteractiveTouchProvider = MarkInteractiveTouchContext.Provider;

export function useMarkInteractiveTouch(): () => void {
  return useContext(MarkInteractiveTouchContext);
}
