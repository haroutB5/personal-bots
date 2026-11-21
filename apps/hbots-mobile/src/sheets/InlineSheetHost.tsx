import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";

export type InlineSheetRegistry = (id: string, node: ReactNode | null) => void;

const InlineSheetContext = createContext<InlineSheetRegistry | null>(null);

export function useInlineSheetRegistry(): InlineSheetRegistry | null {
  return useContext(InlineSheetContext);
}

/**
 * Renders inline sheets (text-input sheets that stay outside a Modal for IME taps)
 * at the top of the host container so they cover BottomBar instead of floating above it.
 */
export function InlineSheetHost({ children }: PropsWithChildren) {
  const [nodes, setNodes] = useState<ReadonlyMap<string, ReactNode>>(() => new Map());
  const register = useCallback<InlineSheetRegistry>((id, node) => {
    setNodes((previous) => {
      if (node === null) {
        if (!previous.has(id)) return previous;
        const next = new Map(previous);
        next.delete(id);
        return next;
      }
      if (previous.get(id) === node) return previous;
      const next = new Map(previous);
      next.set(id, node);
      return next;
    });
  }, []);
  return (
    <InlineSheetContext.Provider value={register}>
      {children}
      {[...nodes.entries()].map(([id, node]) => (
        <Fragment key={id}>{node}</Fragment>
      ))}
    </InlineSheetContext.Provider>
  );
}
