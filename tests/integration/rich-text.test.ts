import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { richTextFromPlainText } from "../../packages/excalidraw/lib/element/src/richTextDocument";

for (const format of [1, 2] as const)
  test(`v${format} snapshot and library APIs preserve rich text against legacy overwrites and validate new documents`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "rich-text-library-"));
    const storage = await nodeStorage(directory);
    let cookie = "";

    async function request(path: string, method = "GET", data?: unknown) {
      const pending: Promise<unknown>[] = [];
      const response = await handleApi(
        new Request(`https://demo.test/api${path}`, {
          method,
          headers: {
            Origin: "https://demo.test",
            "Content-Type": "application/json",
            "X-Requested-With": "excalidraw-demo",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        }),
        {
          ...storage,
          publicOrigin: "https://demo.test",
          waitUntil: (promise) => pending.push(promise),
        },
      );

      await Promise.all(pending);
      if (response.headers.has("set-cookie"))
        cookie = response.headers.get("set-cookie")!.split(";")[0];

      return { status: response.status, body: (await response.json()) as any };
    }

    try {
      assert.equal(
        (
          await request("/setup", "POST", {
            email: "rich@example.test",
            password: "RichTextPassword123!",
          })
        ).status,
        200,
      );
      const element = {
        id: "text",
        type: "text",
        text: "safe",
        originalText: "safe",
        richText: { ...richTextFromPlainText("safe"), version: format },
      };
      const items = [
        { id: "rich-item", status: "unpublished", elements: [element] },
      ];

      assert.equal(
        (await request("/library", "PUT", { revision: 0, items })).body.error
          .code,
        "TEXT_FORMAT_REQUIRED",
      );
      assert.equal(
        (
          await request("/library", "PUT", {
            revision: 0,
            items,
            textFormatVersion: format,
          })
        ).status,
        200,
      );
      const read = (await request("/library")).body;

      assert.equal(read.revision, 1);
      // An old client has fetched the newest revision but its restore silently removes the new field.
      const stripped = [
        { ...items[0], elements: [{ ...element, richText: undefined }] },
        { id: "added-by-old-client" },
      ];
      const rejected = await request("/library", "PUT", {
        revision: read.revision,
        items: stripped,
        ...(format === 2 ? { textFormatVersion: 1 } : {}),
      });

      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error.code, "TEXT_FORMAT_REQUIRED");
      assert.deepEqual((await request("/library")).body, read);
      assert.equal(
        (
          await request("/library", "PUT", {
            revision: 1,
            items: [
              {
                ...items[0],
                elements: [{ ...element, originalText: "tampered" }],
              },
            ],
            textFormatVersion: format,
          })
        ).body.error.code,
        "INVALID_RICH_TEXT",
      );
      assert.equal(
        (
          await request("/library", "PUT", {
            revision: 1,
            items,
            textFormatVersion: format,
          })
        ).status,
        200,
      );
      assert.deepEqual((await request("/library")).body.items, items);
      const space = (await request("/workspaces")).body.workspaces[0];
      const canvas = (await request(`/workspaces/${space.id}/canvases`)).body
        .canvases[0];
      const path = `/canvases/${canvas.id}`;
      const scene = { elements: [element], appState: {}, files: {} };

      assert.equal(
        (await request(path, "PUT", { revision: canvas.revision, scene })).body
          .error.code,
        "TEXT_FORMAT_REQUIRED",
      );
      assert.equal(
        (
          await request(path, "PUT", {
            revision: canvas.revision,
            scene,
            textFormatVersion: format,
          })
        ).status,
        200,
      );
      const saved = (await request(path)).body.canvas;
      const rejectedCanvas = await request(path, "PUT", {
        revision: saved.revision,
        ...(format === 2 ? { textFormatVersion: 1 } : {}),
        scene: { ...scene, elements: [{ ...element, richText: undefined }] },
      });

      assert.equal(rejectedCanvas.status, 409);
      assert.equal(rejectedCanvas.body.error.code, "TEXT_FORMAT_REQUIRED");
      assert.deepEqual((await request(path)).body.canvas.scene, scene);
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
