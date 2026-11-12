import {
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";

/**
 * The asset the server mints a link for. The same resource the web chat asks
 * for: the `text/html` type makes the asset route answer with its sandbox
 * policy, which gives the page an opaque origin.
 */
export function pageAssetResource(reference: HtmlRenderReference) {
  return {
    _tag: "attachment" as const,
    attachmentId: reference.attachmentId,
    fileName: htmlRenderFileName(reference.title),
    mimeType: "text/html",
    disposition: "inline" as const,
  };
}

const DARK_THEME_FRAGMENT = htmlRenderThemeFragment(
  htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark"),
);

/** The signed link with the app's dark theme, which the page reads from its own address. */
export function pageUrlWithTheme(url: string): string {
  return `${url.split("#", 1)[0]}${DARK_THEME_FRAGMENT}`;
}

/**
 * The inline frame's height for the chat's width. The server measured the page
 * at several widths; the page's own height, once the view reports it, wins.
 */
export function pageFrameHeight(
  reference: HtmlRenderReference,
  width: number,
  contentHeight: number | null,
): number {
  const measured = htmlRenderFrameHeight(reference, Math.max(1, Math.round(width)));
  if (contentHeight === null || !Number.isFinite(contentHeight) || contentHeight <= 0) {
    return measured;
  }
  // The native view reports at least its own height, so it can only grow the frame.
  return htmlRenderFrameHeight(reference, width, Math.max(measured, contentHeight));
}

/** A link a page asked to open: only web addresses leave the app. */
export function pageLinkToOpen(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return /^https?:\/\/[^\s]+$/iu.test(trimmed) ? trimmed : null;
}
