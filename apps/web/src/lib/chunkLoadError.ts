/**
 * Does this error mean a split chunk could not be fetched? Chrome says "Failed
 * to fetch dynamically imported module", Safari "Importing a module script
 * failed", Firefox "error loading dynamically imported module", and Vite adds
 * "Unable to preload CSS" for a stylesheet chunk.
 */
const CHUNK_LOAD_MESSAGE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isChunkLoadError(error: unknown): boolean {
  if (error instanceof Error) {
    return CHUNK_LOAD_MESSAGE.test(error.message) || isChunkLoadError(error.cause);
  }
  return typeof error === "string" && CHUNK_LOAD_MESSAGE.test(error);
}
