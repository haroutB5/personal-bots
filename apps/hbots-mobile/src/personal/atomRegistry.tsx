import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { createElement, type PropsWithChildren } from "react";

export const appAtomRegistry = AtomRegistry.make();

export function AppAtomRegistryProvider({ children }: PropsWithChildren) {
  return createElement(RegistryContext.Provider, { value: appAtomRegistry }, children);
}
