import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ConnectOnboardingDialog } from "./ConnectOnboardingDialog";

const state = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, userId: "user-1" } as {
    isLoaded: boolean;
    isSignedIn: boolean;
    userId: string | null;
  },
  sessionReads: 0,
  linkReads: 0,
  off: new Set<string>(),
}));

vi.mock("@clerk/react", () => ({ useAuth: () => state.auth }));
vi.mock("~/cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("~/features/personal/perfFlags", () => ({
  perfOptimizationOn: (name: string) => !state.off.has(name),
}));
vi.mock("~/environments/primary", () => ({
  usePrimarySessionState: () => {
    state.sessionReads += 1;
    return { data: null, error: null, isPending: true, refresh: () => undefined };
  },
}));
vi.mock("~/cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => {
    state.linkReads += 1;
    return { linkState: { data: null, target: null, isPending: true } };
  },
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: () => [{ optOutAccounts: [] }, () => undefined],
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => [],
  usePrimaryEnvironment: () => null,
}));
vi.mock("./CloudEnvironmentConnectList", () => ({ CloudEnvironmentConnectRows: () => null }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-wizard="">{children}</div> : null,
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.sessionReads = 0;
  state.linkReads = 0;
  state.off.clear();
  state.auth = { isLoaded: true, isSignedIn: true, userId: "user-1" };
  vi.unstubAllGlobals();
});

const render = async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  await act(async () => {
    renderer = create(<ConnectOnboardingDialog />);
  });
};

it("reads no session scopes or link state on a cold load with a restored sign-in", async () => {
  await render();
  expect(state.sessionReads).toBe(0);
  expect(state.linkReads).toBe(0);
});

it("mounts the wizard when a sign-in completes in this session", async () => {
  state.auth = { isLoaded: true, isSignedIn: false, userId: null };
  await render();
  expect(state.sessionReads).toBe(0);
  state.auth = { isLoaded: true, isSignedIn: true, userId: "user-2" };
  await act(async () => renderer!.update(<ConnectOnboardingDialog />));
  expect(state.sessionReads).toBeGreaterThan(0);
  expect(state.linkReads).toBeGreaterThan(0);
});

it("mounts the wizard at boot with defer-connect-wizard off", async () => {
  state.off.add("defer-connect-wizard");
  await render();
  expect(state.sessionReads).toBeGreaterThan(0);
});
