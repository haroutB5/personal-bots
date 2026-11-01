/** The app chooses the payload type `P`: a `Blob` on the web, a file descriptor on a phone. */
export interface BlobStore<P> {
  put(key: string, payload: P): Promise<void>;
  get(key: string): Promise<P | null>;
  deletePrefix(prefix: string): Promise<void>;
  keys(): Promise<ReadonlyArray<string>>;
  sizeOf(payload: P): number;
}
