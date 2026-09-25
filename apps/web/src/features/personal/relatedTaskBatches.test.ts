import { PersonalTaskId, type PersonalTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeTaskLists } from "./taskPresentation";
import { RELATED_TASK_IDS_PER_REQUEST, relatedTasksInBatches } from "./relatedTaskBatches";

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    PersonalTaskId.make(`task-${String(index).padStart(3, "0")}`),
  );

const task = (taskId: PersonalTaskId) => ({ taskId, title: `Title ${taskId}` }) as PersonalTask;

describe("relatedTasksInBatches", () => {
  it("asks for 250 ids in 3 requests of at most 100 and resolves every title", () => {
    const requests: number[] = [];
    // Answers like the server: ids past its cap are dropped.
    const tasks = relatedTasksInBatches(ids(250), (batch) => {
      requests.push(batch.length);
      return batch.slice(0, RELATED_TASK_IDS_PER_REQUEST).map(task);
    });
    expect(requests).toEqual([100, 100, 50]);
    // Merged into the feed the way MemoryScreen labels its entries.
    const merged = mergeTaskLists(new Map(), tasks);
    for (const taskId of ids(250)) {
      expect(merged?.get(taskId)?.title).toBe(`Title ${taskId}`);
    }
  });

  it("keeps the batches that answered while others are still loading", () => {
    let call = 0;
    const tasks = relatedTasksInBatches(ids(150), (batch) =>
      call++ === 0 ? null : batch.map(task),
    );
    expect(tasks).toHaveLength(50);
  });

  it("is null until any batch answers", () => {
    expect(relatedTasksInBatches(ids(120), () => null)).toBeNull();
  });
});
