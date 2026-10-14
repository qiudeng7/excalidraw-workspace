import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultEditorTool } from "../../src/lib/editorTools";

test("initial tool recognizes mobile UAs, Android tablets and desktop-UA iPads", () => {
  for (const [userAgent, maxTouchPoints] of [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile Safari", 5],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome Mobile", 5],
    ["Mozilla/5.0 (Linux; Android 15; Tablet) Chrome", 5],
    ["Mozilla/5.0 (iPad; CPU OS 18_0) Safari", 5],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari", 5],
  ] as const)
    assert.equal(defaultEditorTool({ userAgent, maxTouchPoints }).type, "hand");
});

test("desktop UAs remain selection even with touch support", () => {
  for (const [userAgent, maxTouchPoints] of [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome", 10],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari", 0],
    ["Mozilla/5.0 (X11; Linux x86_64) Chrome", 0],
  ] as const)
    assert.equal(
      defaultEditorTool({ userAgent, maxTouchPoints }).type,
      "selection",
    );
});
