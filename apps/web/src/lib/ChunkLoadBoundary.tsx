import { Component, type ReactNode } from "react";

import { isChunkLoadError } from "./chunkLoadError";

interface ChunkLoadBoundaryProps {
  readonly children: ReactNode;
  /** What stands in for the pieces that could not load; nothing by default. */
  readonly fallback?: ReactNode;
}

interface ChunkLoadBoundaryState {
  readonly error: unknown;
}

/**
 * Keeps a piece of the app that loads lazily (a dialog host, a side layer) from
 * taking the whole screen down when its code cannot be fetched, which is what
 * happens when the phone loses its network after the page opened. Only a
 * failed chunk fetch is held here, and it draws `fallback`; every other error
 * goes on to the nearest error screen as before. The piece comes back with the
 * next page load: React keeps a rejected lazy import rejected.
 */
export class ChunkLoadBoundary extends Component<ChunkLoadBoundaryProps, ChunkLoadBoundaryState> {
  override state: ChunkLoadBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ChunkLoadBoundaryState {
    return { error };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!isChunkLoadError(error)) throw error;
    return this.props.fallback ?? null;
  }
}
