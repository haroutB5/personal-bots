import { perfOptimizationOn } from "./perfFlags";

/**
 * Runs `work` just after the next paint (a frame, then a task), or at once with
 * the "chat-open-after-paint" kill switch off. For the work a chat does as it
 * opens that the first frame does not need: React flushes passive effects
 * inside the tap's own task, so without this they (a forced layout, RPCs)
 * held the chat's first paint back. Returns a cancel function.
 */
export function afterPaint(work: () => void): () => void {
  if (!perfOptimizationOn("chat-open-after-paint") || typeof requestAnimationFrame !== "function") {
    work();
    return () => undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(work, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
}
