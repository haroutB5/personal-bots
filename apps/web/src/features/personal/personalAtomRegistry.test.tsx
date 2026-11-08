import { useEnvironmentQuery } from "@hbots/personal-client/react/query";
import { AsyncResult, Atom } from "effect/reactivity";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { act } from "../../../test/rendererAct";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";

const listAtom = Atom.make(AsyncResult.success("unset")).pipe(Atom.keepAlive);

function ListReader() {
  return <>{useEnvironmentQuery(listAtom).data}</>;
}

// A command's onSuccess refreshes queries in the app registry. A personal-client
// hook that read some other registry kept the old bots list after a new chat.
describe("personal-client queries", () => {
  it("read the atom registry the app provides", async () => {
    appAtomRegistry.set(listAtom, AsyncResult.success("from the app registry"));
    let renderer: ReactTestRenderer;
    await act(() => {
      renderer = create(
        <AppAtomRegistryProvider>
          <ListReader />
        </AppAtomRegistryProvider>,
      );
    });
    expect(renderer!.toJSON()).toBe("from the app registry");
    await act(() => {
      appAtomRegistry.set(listAtom, AsyncResult.success("refreshed"));
    });
    expect(renderer!.toJSON()).toBe("refreshed");
    await act(() => renderer.unmount());
  });
});
