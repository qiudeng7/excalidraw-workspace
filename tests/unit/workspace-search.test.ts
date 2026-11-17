// 工作空间搜索的纯函数契约：画布标题、文字正文与 Frame 已存名称的字面匹配。
// 真实实现 shared/workspace-search.ts；本组不覆盖数据库、房间读取或浏览器入口。
// 片段下标按协议是 snippet 内的 UTF-16 下标，必须能直接切出命中的原文字符。
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCanvas } from "../../shared/workspace-search";
import { richTextFromPlainText } from "../../packages/excalidraw/lib/element/src/richTextDocument";

const canvas = { id: "canvas-1", name: "季度计划", workspaceId: "space-1" };

const text = (
  id: string,
  originalText: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  angle: 0,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  text: originalText,
  originalText,
  ...extra,
});
const frame = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "frame",
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  angle: 0,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  ...extra,
});

test("标题命中返回空匹配组，无命中返回 undefined", () => {
  const group = searchCanvas(canvas, [], "季度");

  assert.ok(group);
  assert.deepEqual(group.canvas, canvas);
  assert.equal(group.titleMatched, true);
  assert.deepEqual(group.matches, []);
  assert.equal(searchCanvas(canvas, [], "不存在的词"), undefined);
});

test("正文命中一条/元素，片段下标按 UTF-16 切出原文字符", () => {
  const group = searchCanvas(
    canvas,
    [
      text("t-1", "重庆 补贴 政策"),
      text("t-2", "补贴补贴"),
      text("t-3", "无关内容"),
    ],
    "补贴",
  );

  assert.ok(group);
  assert.equal(group.titleMatched, false);
  assert.deepEqual(
    group.matches.map((match) => match.elementId),
    ["t-1", "t-2"],
  );
  for (const match of group.matches) {
    assert.equal(match.kind, "text");
    assert.equal(
      match.snippet.slice(match.matchStart, match.matchEnd),
      "补贴",
      "matchStart/matchEnd 是 snippet 内的 UTF-16 下标",
    );
    assert.equal(match.snippet.includes("补贴"), true);
  }
});

test("英文不分大小写，片段保留原文大小写并只截取附近内容", () => {
  const body = `${"背景说明".repeat(80)} Quarterly Plan ${"补充说明".repeat(80)}`;
  const group = searchCanvas(canvas, [text("t-plan", body)], "quarterly");

  assert.ok(group);
  const [match] = group.matches;

  assert.equal(
    match!.snippet.slice(match!.matchStart, match!.matchEnd),
    "Quarterly",
  );
  assert.equal(match!.snippet.length < body.length, true);
});

test("匹配是字面量：正则符号按字符处理，不会抛错也不会通配", () => {
  const elements = [
    text("t-dot", "版本 a.b 发布"),
    text("t-star", "星号 * 用法"),
  ];

  assert.deepEqual(
    searchCanvas(canvas, elements, "a.b")?.matches.map(
      (match) => match.elementId,
    ),
    ["t-dot"],
  );
  assert.equal(searchCanvas(canvas, elements, "a?b"), undefined);
  assert.equal(searchCanvas(canvas, elements, "a*"), undefined);
  assert.equal(
    searchCanvas(canvas, elements, "[")?.matches.map(
      (match) => match.elementId,
    ),
    undefined,
  );
  assert.deepEqual(
    searchCanvas(canvas, elements, "*")?.matches.map(
      (match) => match.elementId,
    ),
    ["t-star"],
  );
});

test("Frame 只匹配已存名称，未命名与默认名称不参与", () => {
  const group = searchCanvas(
    canvas,
    [
      frame("f-named", { name: "阶段一" }),
      frame("f-empty", { name: "" }),
      frame("f-none"),
    ],
    "阶段一",
  );

  assert.ok(group);
  assert.deepEqual(
    group.matches.map((match) => [match.kind, match.elementId]),
    [["frame", "f-named"]],
  );
  assert.equal(searchCanvas(canvas, [frame("f-none")], "frame"), undefined);
});

test("已删除、图片与其他元素不参与，富文本按可读投影而不是格式结构匹配", () => {
  const richText = richTextFromPlainText("重点内容");

  assert.ok(
    searchCanvas(
      canvas,
      [
        text("t-deleted", "已删词条", { isDeleted: true }),
        {
          id: "img",
          type: "image",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          angle: 0,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          fileId: "file-1",
        },
        {
          id: "t-rich",
          type: "text",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          angle: 0,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          text: "重点内容",
          originalText: "重点内容",
          richText: { ...richText, version: 2 },
        },
      ],
      "重点内容",
    )?.matches.some((match) => match.elementId === "t-rich"),
  );
  assert.equal(
    searchCanvas(
      canvas,
      [text("t-deleted", "已删词条", { isDeleted: true })],
      "已删词条",
    ),
    undefined,
  );
  assert.equal(
    searchCanvas(
      canvas,
      [text("t-image", "图片说明", { type: "image" })],
      "图片说明",
    ),
    undefined,
  );
  // 富文本结构里的键名与格式标记不是正文，不参与匹配。
  assert.equal(
    searchCanvas(
      canvas,
      [
        {
          ...text("t-rich", "重点内容"),
          richText: { ...richText, version: 2 },
        },
      ],
      "paragraph",
    ),
    undefined,
  );
});
