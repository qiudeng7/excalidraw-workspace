import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalSavedColor,
  parseSavedColors,
  MAX_SAVED_COLORS,
} from "../../packages/excalidraw/components/ColorPicker/savedColors";

test("personal palette canonicalizes shorthand and alpha, rejects unsafe persisted CSS", () => {
  assert.equal(canonicalSavedColor(" #AbC "), "#aabbcc");
  assert.equal(canonicalSavedColor("#1234"), "#11223344");
  assert.equal(canonicalSavedColor("#12345678"), "#12345678");
  assert.equal(canonicalSavedColor("transparent"), "transparent");
  for (const invalid of [
    null,
    12,
    "red",
    "#12",
    "url(https://example.test)",
    "var(--secret)",
  ])
    assert.equal(canonicalSavedColor(invalid), null);
  assert.deepEqual(
    parseSavedColors(
      JSON.stringify(["#ABC", "#aabbcc", {}, "red", "transparent"]),
    ),
    ["#aabbcc", "transparent"],
  );
});

test("personal palette tolerates corrupt storage and bounds its size", () => {
  for (const invalid of [null, "", "broken", "{}", "null", '"#fff"'])
    assert.deepEqual(parseSavedColors(invalid), []);
  const colors = Array.from(
    { length: 100 },
    (_, index) => `#${index.toString(16).padStart(6, "0")}`,
  );

  assert.deepEqual(
    parseSavedColors(JSON.stringify(colors)),
    colors.slice(0, MAX_SAVED_COLORS),
  );
});
