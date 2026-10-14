import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLicenseNotices } from "../../scripts/licenses.mjs";

test("published notices preserve both canonical licenses and escape HTML", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-licenses-"));
  const own =
    "Copyright Workspace <script>alert(1)</script>\nOwn permission text";
  const upstream = "Copyright Excalidraw\nComplete upstream permission text";

  try {
    await mkdir(join(root, "packages/excalidraw"), { recursive: true });
    await writeFile(join(root, "LICENSE"), own);
    await writeFile(join(root, "packages/excalidraw/LICENSE"), upstream);
    await writeLicenseNotices(root, join(root, "public"));
    const html = await readFile(join(root, "public/licenses.html"), "utf8");
    const text = await readFile(join(root, "public/licenses.txt"), "utf8");

    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes("<script>"));
    assert.ok(text.includes(own));
    assert.ok(text.includes(upstream));
    await writeFile(join(root, "LICENSE"), "Updated copyright and permission");
    await writeLicenseNotices(root, join(root, "public"));
    assert.ok(
      (await readFile(join(root, "public/licenses.txt"), "utf8")).includes(
        "Updated copyright and permission",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
