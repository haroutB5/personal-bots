import { useEffect, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { KeptBotsHome } from "./KeptBotsHome";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("KeptBotsHome", () => {
  for (const variant of ["supported", "unsupported", "off"] as const) {
    it(`pauses descendant work and preserves filter state on Back (${variant})`, () => {
      vi.useFakeTimers();
      vi.stubGlobal("CSS", { supports: () => variant !== "unsupported" });
      vi.stubGlobal("localStorage", {
        getItem: () => (variant === "off" ? "home-back-layout" : null),
      });
      vi.stubGlobal("requestIdleCallback", undefined);
      class ContentElement {
        style = {
          display: "none",
          setProperty: vi.fn((_name: string, value: string) => {
            this.style.display = value;
          }),
        };
      }
      let notifyStyleChange: (() => void) | undefined;
      const disconnect = vi.fn();
      vi.stubGlobal(
        "MutationObserver",
        class {
          constructor(callback: () => void) {
            notifyStyleChange = callback;
          }
          observe() {}
          disconnect = disconnect;
        },
      );
      vi.stubGlobal("HTMLElement", ContentElement);
      const content = new ContentElement();
      let ticks = 0;
      let initializations = 0;
      let changeFilter!: (value: string) => void;
      function Probe() {
        const [filter, setFilter] = useState(() => {
          initializations++;
          return "all";
        });
        useEffect(() => {
          changeFilter = setFilter;
        }, []);
        useEffect(() => {
          const timer = setInterval(() => ticks++, 100);
          return () => clearInterval(timer);
        }, []);
        return <span>{filter}</span>;
      }
      const child = <Probe />;
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(<KeptBotsHome shown>{child}</KeptBotsHome>, {
          createNodeMock: (element) =>
            (element.props as Record<string, unknown>)["data-kept-bots-home"] !== undefined
              ? { firstElementChild: content }
              : null,
        });
      });
      act(() => changeFilter("unread"));
      act(() => renderer.update(<KeptBotsHome shown={false}>{child}</KeptBotsHome>));
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const paused = ticks;
      // Overwriting Activity's host display must not reconnect its effects.
      expect(content.style.setProperty).toHaveBeenCalledTimes(variant === "supported" ? 1 : 0);
      if (variant === "supported") {
        content.style.display = "none";
        notifyStyleChange!();
        expect(content.style.display).toBe("block");
        notifyStyleChange!();
        expect(content.style.setProperty).toHaveBeenCalledTimes(2);
      }
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(ticks).toBe(paused);
      act(() => renderer.update(<KeptBotsHome shown>{child}</KeptBotsHome>));
      expect(disconnect).toHaveBeenCalledTimes(variant === "supported" ? 1 : 0);
      expect(renderer.root.findByType("span").children).toEqual(["unread"]);
      expect(initializations).toBe(1);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(ticks).toBe(paused + 1);
      act(() => renderer.unmount());
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});
