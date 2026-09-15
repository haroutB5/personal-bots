import type { EnvironmentId, PersonalFile } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deleteFileConfirmMessage, useDeleteFile } from "./useDeleteFile";

const command = vi.hoisted(() => ({
  result: { _tag: "Success" } as { readonly _tag: string; readonly cause?: unknown },
  confirmed: true,
  calls: [] as Array<unknown>,
}));

vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => command.confirmed }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    command.calls.push(input);
    return command.result;
  },
}));
vi.mock("./usePersonalBots", () => ({ personalFileDelete: {} }));

const file = { fileId: "attachment-1", name: "notes.txt" } as Pick<PersonalFile, "fileId" | "name">;

afterEach(() => {
  command.result = { _tag: "Success" };
  command.confirmed = true;
  command.calls.length = 0;
  vi.unstubAllGlobals();
});

describe("useDeleteFile", () => {
  it("confirms permanent removal from chats before deleting exactly one id", async () => {
    const message = deleteFileConfirmMessage(file.name);
    expect(message).toContain("permanently");
    expect(message).toContain("disappear from your chats");

    expect(await useDeleteFile("env-1" as EnvironmentId)(file)).toEqual({ status: "done" });
    expect(command.calls).toEqual([{ environmentId: "env-1", input: { fileId: "attachment-1" } }]);
  });

  it("does not call the server when confirmation is declined", async () => {
    command.confirmed = false;
    expect(await useDeleteFile("env-1" as EnvironmentId)(file)).toEqual({
      status: "cancelled",
    });
    expect(command.calls).toEqual([]);
  });

  it("returns the server failure for the screen's alert", async () => {
    command.result = { _tag: "Failure", cause: Cause.fail(new Error("Laptop unreachable")) };
    expect(await useDeleteFile("env-1" as EnvironmentId)(file)).toEqual({
      status: "failed",
      message: "Laptop unreachable",
    });
  });
});
