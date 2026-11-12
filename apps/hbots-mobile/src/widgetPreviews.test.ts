import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const res = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../modules/hbots-launcher/android/src/main/res",
);
const infoFiles = NodeFS.readdirSync(NodePath.join(res, "xml")).filter((name) =>
  name.endsWith("_info.xml"),
);

describe("widget picker previews", () => {
  it("covers all eight widgets", () => {
    expect(infoFiles).toHaveLength(8);
  });

  it.each(infoFiles)("%s names a preview picture that exists", (name) => {
    const xml = NodeFS.readFileSync(NodePath.join(res, "xml", name), "utf8");
    const preview = /android:previewImage="@drawable\/(\w+)"/.exec(xml)?.[1];
    expect(preview).toBeDefined();
    expect(NodeFS.existsSync(NodePath.join(res, "drawable-nodpi", `${preview}.png`))).toBe(true);
  });
});
