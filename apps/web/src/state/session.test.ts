import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface FakeAtom {
  readonly environmentId: string;
}

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: mocks.get, subscribe: mocks.subscribe },
}));

vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    preparedConnectionValueAtom: (environmentId: string): FakeAtom => ({ environmentId }),
  }),
}));

import { awaitPreparedConnection } from "./session";

const environmentId = EnvironmentId.make("environment-1");
const connection = { httpBaseUrl: "https://environment.test/" };

describe("awaitPreparedConnection", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.subscribe.mockReset();
  });

  it("answers from the registry when the atom is already mounted", async () => {
    mocks.get.mockReturnValue(Option.some(connection));

    await expect(awaitPreparedConnection(environmentId)).resolves.toBe(connection);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  /**
   * The bug this guards: `preparedConnectionAtom` is stream-backed with an
   * initial `None`, and the stream only runs while the atom has a subscriber.
   * A screen that renders nothing bound to the environment -- a new chat with
   * an empty transcript -- leaves it unmounted, so a bare `registry.get`
   * answers `None` forever. Subscribing is what makes the value appear.
   */
  it("subscribes and waits when nothing has mounted the atom yet", async () => {
    mocks.get.mockReturnValue(Option.none());
    const unsubscribe = vi.fn();
    let publish: ((value: Option.Option<typeof connection>) => void) | null = null;
    mocks.subscribe.mockImplementation(
      (_atom: FakeAtom, listener: (value: Option.Option<typeof connection>) => void) => {
        publish = listener;
        return unsubscribe;
      },
    );

    const pending = awaitPreparedConnection(environmentId);
    expect(mocks.subscribe).toHaveBeenCalledWith(
      { environmentId },
      expect.any(Function),
      expect.objectContaining({ immediate: true }),
    );

    // A `None` tick must not settle the wait: the stream replays the initial
    // value before the supervisor publishes the prepared connection.
    publish!(Option.none());
    publish!(Option.some(connection));

    await expect(pending).resolves.toBe(connection);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("releases the subscription when it answers synchronously", async () => {
    mocks.get.mockReturnValue(Option.none());
    const unsubscribe = vi.fn();
    mocks.subscribe.mockImplementation(
      (_atom: FakeAtom, listener: (value: Option.Option<typeof connection>) => void) => {
        listener(Option.some(connection));
        return unsubscribe;
      },
    );

    await expect(awaitPreparedConnection(environmentId)).resolves.toBe(connection);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("gives up with null once the wait elapses", async () => {
    mocks.get.mockReturnValue(Option.none());
    const unsubscribe = vi.fn();
    mocks.subscribe.mockReturnValue(unsubscribe);

    await expect(awaitPreparedConnection(environmentId, { timeoutMs: 1 })).resolves.toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
