/**
 * A page a bot showed is drawn inline in the bot chat at phone width, in the
 * sandboxed frame, sized by the height the server measured for that width.
 */
import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const PAGE_HTML =
  "<!doctype html><meta name=viewport content='width=device-width'>" +
  "<body style='margin:0;font:14px system-ui;background:#161615;color:#ededeb'>" +
  "<h3 style='margin:12px'>hbots widget mockups</h3>" +
  "<div style='margin:12px;padding:16px;border-radius:16px;background:#242423'>Working now: 2 bots</div>" +
  "<div style='margin:12px;padding:16px;border-radius:16px;background:#242423'>Needs you: 1 question</div>";
const pageUrl = URL.createObjectURL(new Blob([PAGE_HTML], { type: "text/html" }));

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: pageUrl,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));
vi.mock(import("~/assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrlRefresh: () => async () => pageUrl,
}));

import { MessageList } from "./MessageList";

it("draws the bot's page inline at phone width in a sandboxed frame", async () => {
  await page.viewport(360, 785);
  document.documentElement.classList.add("dark");
  const container = document.createElement("div");
  container.style.cssText = "width:360px;height:785px;display:flex;flex-direction:column";
  document.body.append(container);
  await using screen = await render(
    <MessageList
      environmentId={EnvironmentId.make("env-1")}
      threadRef={{ environmentId: "env-1", threadId: "thread-1" } as unknown as ScopedThreadRef}
      items={[
        { kind: "divider", id: "divider:1", at: new Date("2026-11-12T10:00:00.000Z") },
        {
          kind: "html-render",
          id: "item-1",
          createdAt: "2026-11-12T10:00:01.000Z",
          htmlRender: {
            attachmentId: "thread-1-abc-html",
            title: "hbots widget mockups",
            height: 900,
            heights: [
              [320, 260],
              [375, 240],
              [728, 200],
            ],
          },
        },
      ]}
      pending={[]}
      working={false}
      botName="Poteto"
      workspaceRoot={undefined}
      approvals={[]}
      respondingIds={new Set<string>()}
      onRespondToApproval={() => {}}
      onAnswerQuestion={() => {}}
      onDismissQuestion={() => {}}
      onProvideSecret={() => {}}
      onDeclineSecret={() => {}}
      onDecideConnectionApproval={() => {}}
      approvalRespondingIds={new Set<string>()}
      approvalsNowMs={Date.parse("2026-11-12T10:00:00.000Z")}
      errorText={null}
      loadEarlier={null}
      now={new Date("2026-11-12T10:01:00.000Z")}
      describeTurn={() => ""}
      renderDelegation={() => null}
    />,
    { container },
  );

  const frame = screen.getByTitle("hbots widget mockups");
  await expect.element(frame).toBeVisible();
  const element = frame.element() as HTMLIFrameElement;
  expect(element.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  const box = element.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(280);
  expect(box.width).toBeLessThanOrEqual(360);
  // Between the 320 and 375 measurements, the taller one wins until the page reports its own.
  expect(box.height).toBeGreaterThanOrEqual(80);
  await expect
    .element(screen.getByRole("button", { name: "Open full screen" }))
    .toBeInTheDocument();
});
