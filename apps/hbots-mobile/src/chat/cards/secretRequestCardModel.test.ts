import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { secretCardAlert, secretCommandError, withSecretError } from "./secretRequestCardModel";

const success = <A>(value: A): AtomCommandResult<A, Error> =>
  ({ _tag: "Success", value }) as unknown as AtomCommandResult<A, Error>;

const failure = <E>(cause: Cause.Cause<E>): AtomCommandResult<never, E> =>
  ({ _tag: "Failure", cause }) as unknown as AtomCommandResult<never, E>;

describe("secretCommandError", () => {
  it("returns null on success", () => {
    expect(secretCommandError(success("ok"), "Couldn't save this secret. Try again.")).toBeNull();
  });

  it("returns null when the command was interrupted", () => {
    expect(
      secretCommandError(failure(Cause.interrupt(1)), "Couldn't save this secret. Try again."),
    ).toBeNull();
  });

  it("surfaces the server error message when saving fails (e.g. locked secret store)", () => {
    const message =
      "Saved keys are locked on this computer. They were sealed on another machine, so hbots can't open or add keys until the secret key is moved over. Your value was not saved.";
    expect(
      secretCommandError(
        failure(Cause.fail(new Error(message))),
        "Couldn't save this secret. Try again.",
      ),
    ).toBe(message);
  });

  it("falls back when the failure carries no readable message", () => {
    expect(
      secretCommandError(
        failure(Cause.fail(new Error(""))),
        "Couldn't save this secret. Try again.",
      ),
    ).toBe("Couldn't save this secret. Try again.");
  });
});

describe("withSecretError", () => {
  it("sets and clears per-request errors immutably", () => {
    const empty = new Map<string, string>();
    expect(withSecretError(empty, "req-1", null)).toBe(empty);

    const withErr = withSecretError(empty, "req-1", "Secret store locked");
    expect(withErr.get("req-1")).toBe("Secret store locked");
    expect(empty.has("req-1")).toBe(false);
    expect(withSecretError(withErr, "req-1", "Secret store locked")).toBe(withErr);

    const cleared = withSecretError(withErr, "req-1", null);
    expect(cleared.has("req-1")).toBe(false);
  });
});

describe("secretCardAlert", () => {
  it("shows nothing before validation or server errors", () => {
    expect(
      secretCardAlert({
        showProblem: false,
        problem: "Enter the address this key may be sent to, like https://api.vercel.com.",
        serverError: null,
      }),
    ).toBeNull();
  });

  it("shows the access validation problem once the user tries to save", () => {
    expect(
      secretCardAlert({
        showProblem: true,
        problem: "Enter the address this key may be sent to, like https://api.vercel.com.",
        serverError: null,
      }),
    ).toBe("Enter the address this key may be sent to, like https://api.vercel.com.");
  });

  it("shows the server error when access is valid (e.g. env mode)", () => {
    expect(
      secretCardAlert({
        showProblem: false,
        problem: null,
        serverError: "Saved keys are locked on this computer.",
      }),
    ).toBe("Saved keys are locked on this computer.");
  });
});
