// 验证真实 API、共享富文本校验与隔离 Node 存储往返；不连接生产，不覆盖浏览器和协作网络。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";

test("高亮文档保存到素材库后读取保留标记，非法样式和纯文本投影不覆盖已保存数据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rich-highlight-"));
  const storage = await nodeStorage(directory);
  let cookie = "";
  const request = async (path: string, method = "GET", data?: unknown) => {
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
    if (response.headers.has("set-cookie")) {
      cookie = response.headers.get("set-cookie")!.split(";")[0];
    }

    return { status: response.status, body: (await response.json()) as any };
  };

  try {
    assert.equal(
      (
        await request("/setup", "POST", {
          email: "highlight@example.test",
          password: "HighlightPassword123!",
        })
      ).status,
      200,
    );
    const richText = {
      version: 2,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "重点", marks: [{ type: "highlight" }] },
            ],
          },
        ],
      },
    };
    const element = {
      id: "highlight",
      type: "text",
      text: "重点",
      originalText: "重点",
      richText,
    };
    const items = [
      { id: "highlight-item", status: "unpublished", elements: [element] },
    ];

    for (const textFormatVersion of [1, 2]) {
      const rejected = await request("/library", "PUT", {
        revision: 0,
        items,
        textFormatVersion,
      });

      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error.code, "TEXT_FORMAT_REQUIRED");
    }

    assert.equal(
      (
        await request("/library", "PUT", {
          revision: 0,
          items,
          textFormatVersion: 3,
        })
      ).status,
      200,
    );
    const saved = await request("/library");

    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.items[0].elements[0].richText, richText);
    // 模拟旧客户端提交已丢失高亮或整个 richText 字段的载荷，即使携带最新 revision 也拒绝。
    const plainRichText = {
      ...richText,
      doc: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "重点" }] },
        ],
      },
    };

    for (const incoming of [
      { ...element, richText: plainRichText },
      {
        id: element.id,
        type: "text",
        text: element.text,
        originalText: element.originalText,
      },
    ]) {
      for (const textFormatVersion of [1, 2]) {
        const rejected = await request("/library", "PUT", {
          revision: saved.body.revision,
          items: [{ ...items[0], elements: [incoming] }],
          textFormatVersion,
        });

        assert.equal(rejected.status, 409);
        assert.equal(rejected.body.error.code, "TEXT_FORMAT_REQUIRED");
        assert.deepEqual((await request("/library")).body, saved.body);
      }
    }

    for (const invalid of [
      { ...element, originalText: "==重点==" },
      {
        ...element,
        richText: {
          version: 2,
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "重点",
                    marks: [
                      { type: "highlight", attrs: { style: "color:red" } },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ]) {
      const result = await request("/library", "PUT", {
        revision: saved.body.revision,
        items: [{ ...items[0], elements: [invalid] }],
        textFormatVersion: 3,
      });

      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, "INVALID_RICH_TEXT");
      assert.deepEqual((await request("/library")).body, saved.body);
    }

    const clearedItems = [
      { ...items[0], elements: [{ ...element, richText: plainRichText }] },
    ];

    assert.equal(
      (
        await request("/library", "PUT", {
          revision: saved.body.revision,
          items: clearedItems,
          textFormatVersion: 3,
        })
      ).status,
      200,
    );
    const cleared = (await request("/library")).body;

    assert.deepEqual(cleared.items, clearedItems);
    // 清除高亮后仍是普通 v2，旧能力 2 可继续写入。
    assert.equal(
      (
        await request("/library", "PUT", {
          revision: cleared.revision,
          items: clearedItems,
          textFormatVersion: 2,
        })
      ).status,
      200,
    );
    assert.deepEqual((await request("/library")).body.items, clearedItems);
  } finally {
    await storage.close();
    // directory 是本用例在系统临时目录中新建且直接持有的隔离路径。
    assert.equal(directory.startsWith(join(tmpdir(), "rich-highlight-")), true);
    await rm(directory, { recursive: true, force: true });
  }
});
