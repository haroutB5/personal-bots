import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_INPUT_ATTRIBUTE,
  composerHasFocus,
  consumeComposerRefocus,
  requestComposerRefocus,
} from "./composerRefocus";

const fieldWithFocus = (attributes: string[]) =>
  ({
    activeElement: { hasAttribute: (name: string) => attributes.includes(name) },
  }) as unknown as Document;

describe("composer refocus after a chip switch", () => {
  it("is spent by the first composer that asks", () => {
    requestComposerRefocus(1_000);
    expect(consumeComposerRefocus(1_500)).toBe(true);
    expect(consumeComposerRefocus(1_500)).toBe(false);
  });

  it("expires, so a late mount never steals the focus", () => {
    requestComposerRefocus(1_000);
    expect(consumeComposerRefocus(1_000 + 3_001)).toBe(false);
  });

  it("is off when nothing asked", () => {
    expect(consumeComposerRefocus()).toBe(false);
  });

  it("tells whether the message field holds focus", () => {
    expect(composerHasFocus(fieldWithFocus([COMPOSER_INPUT_ATTRIBUTE]))).toBe(true);
    expect(composerHasFocus(fieldWithFocus([]))).toBe(false);
    expect(composerHasFocus({ activeElement: null })).toBe(false);
  });
});
