import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ChoiceButtons, type ChoicesState } from "./ChoiceButtons";

const OPTIONS = ["Yes, ship it", "Not yet", "Show me the diff"];
const OPEN: ChoicesState = { kind: "open", disabled: false };

describe("ChoiceButtons", () => {
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  const render = async (state: ChoicesState, onChoose?: (text: string) => Promise<boolean>) => {
    await act(async () => {
      renderer = create(
        <ChoiceButtons options={OPTIONS} state={state} botName="Mori" onChoose={onChoose} />,
      );
    });
    return renderer!.root;
  };
  const buttons = (root: ReturnType<typeof create>["root"]) => root.findAllByType("button");

  it("draws one tappable button per option", async () => {
    const root = await render(OPEN, async () => true);
    expect(buttons(root).map((button) => button.props.disabled)).toEqual([false, false, false]);
    expect(root.findByProps({ "data-testid": "choices" }).props["data-state"]).toBe("open");
  });

  it("sends the tapped option's text once, even on a double tap", async () => {
    let finish!: (ok: boolean) => void;
    const onChoose = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const root = await render(OPEN, onChoose);
    const second = buttons(root)[1]!;
    await act(async () => {
      second.props.onClick();
      second.props.onClick();
    });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("Not yet");
    // The whole set is locked while it is on its way, and the pick is marked.
    expect(buttons(root).every((button) => button.props.disabled === true)).toBe(true);
    expect(buttons(root)[1]!.props["aria-pressed"]).toBe(true);
    await act(async () => finish(true));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("frees the set again when the send did not go through", async () => {
    const onChoose = vi.fn(async () => false);
    const root = await render(OPEN, onChoose);
    await act(async () => buttons(root)[0]!.props.onClick());
    expect(buttons(root).map((button) => button.props.disabled)).toEqual([false, false, false]);
    await act(async () => buttons(root)[2]!.props.onClick());
    expect(onChoose).toHaveBeenCalledTimes(2);
    expect(onChoose).toHaveBeenLastCalledWith("Show me the diff");
  });

  it("does nothing while the chat is busy", async () => {
    const onChoose = vi.fn(async () => true);
    const root = await render({ kind: "open", disabled: true }, onChoose);
    expect(buttons(root).every((button) => button.props.disabled === true)).toBe(true);
    await act(async () => buttons(root)[0]!.props.onClick());
    expect(onChoose).not.toHaveBeenCalled();
    expect(root.findByProps({ "data-testid": "choices" }).props["data-state"]).toBe("disabled");
  });

  it("greys out once used and marks the option that was sent", async () => {
    const onChoose = vi.fn(async () => true);
    const root = await render({ kind: "used", picked: "Not yet" }, onChoose);
    expect(buttons(root).every((button) => button.props.disabled === true)).toBe(true);
    expect(buttons(root).map((button) => button.props["aria-pressed"])).toEqual([
      false,
      true,
      false,
    ]);
    await act(async () => buttons(root)[0]!.props.onClick());
    expect(onChoose).not.toHaveBeenCalled();
    expect(root.findByProps({ "data-testid": "choices" }).props["data-state"]).toBe("used");
  });

  it("is locked where nothing can be sent (an archived chat)", async () => {
    const root = await render(OPEN, undefined);
    expect(buttons(root).every((button) => button.props.disabled === true)).toBe(true);
  });

  it("uses the chip and card tokens, in both themes", () => {
    const html = renderToStaticMarkup(
      <ChoiceButtons options={OPTIONS} state={OPEN} botName="Mori" onChoose={async () => true} />,
    );
    expect(html).toContain("--personal-surface");
    expect(html).toContain("--personal-border");
    expect(html).toContain("--personal-radius-button");
    expect(html).toContain('aria-label="Quick answers for Mori"');
  });
});
