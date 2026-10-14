import type { Page } from "@playwright/test";
import { test, expect, editorState } from "./fixtures";
import { announcementKey } from "../../src/lib/releaseProgress";
import { currentRelease } from "../../src/data/releases";

const storageKey = "workspace:color-palette:v1:test-user";

async function rectangle(page: Page) {
  await page.getByTestId("toolbar-rectangle").first().click();
  const before = (await editorState(page)).elements.length;
  const box = (await page.locator(".excalidraw canvas").last().boundingBox())!;

  await page.mouse.move(box.x + 350, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 320);
  await page.mouse.up();
  await expect
    .poll(() => editorState(page).then((state) => state.elements.length))
    .toBe(before + 1);
}

async function picker(page: Page, type = "elementStroke") {
  await page.locator(`[data-openpopup="${type}"]`).first().click();

  return page.locator(".color-picker-content");
}

test("personal palette saves inputs, applies across stroke/fill/background and survives reload", async ({
  page,
  workspace,
}, testInfo) => {
  void workspace;
  await rectangle(page);
  let popup = await picker(page);
  const hex = popup.locator(".color-picker-input");

  await hex.fill("2468ac");
  await popup.getByRole("button", { name: "收藏当前颜色" }).click();
  await expect(
    popup.getByRole("button", { name: "已收藏此颜色" }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        storageKey,
      ),
    )
    .toEqual(["#2468ac"]);
  await hex.fill("f03a74");
  await popup.getByRole("button", { name: "收藏当前颜色" }).click();
  await popup.getByRole("button", { name: "使用收藏颜色 #2468ac" }).click();
  await expect
    .poll(() =>
      editorState(page).then((state) => state.elements[0].strokeColor),
    )
    .toBe("#2468ac");
  await page.screenshot({
    path: testInfo.outputPath("personal-palette-light.png"),
  });
  await page.keyboard.press("Escape");

  popup = await picker(page, "elementBackground");
  await popup.getByRole("button", { name: "使用收藏颜色 #f03a74" }).click();
  await expect
    .poll(() =>
      editorState(page).then((state) => state.elements[0].backgroundColor),
    )
    .toBe("#f03a74");
  await page.keyboard.press("Escape");
  await page.getByTestId("main-menu-trigger").click();
  popup = await picker(page, "canvasBackground");
  await popup.getByRole("button", { name: "使用收藏颜色 #2468ac" }).click();
  await expect(page.locator('[data-openpopup="canvasBackground"]')).toHaveCSS(
    "--swatch-color",
    "#2468ac",
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await rectangle(page);
  popup = await picker(page);
  await expect(
    popup.getByRole("button", { name: "使用收藏颜色 #2468ac" }),
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: testInfo.outputPath("personal-palette-dark.png"),
  });
});

test("personal palette is keyboard accessible and deletion preserves the selected element", async ({
  page,
  workspace,
}) => {
  void workspace;
  await rectangle(page);
  const popup = await picker(page);
  const hex = popup.locator(".color-picker-input");

  await hex.fill("abc");
  await hex.press("Tab");
  const add = popup.getByRole("button", { name: "收藏当前颜色" });

  await expect(add).toBeFocused();
  await page.keyboard.press("Enter");
  const swatch = popup.getByRole("button", { name: "使用收藏颜色 #aabbcc" });

  await swatch.focus();
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      editorState(page).then((state) => state.elements[0].strokeColor),
    )
    .toBe("#aabbcc");
  await page.keyboard.press("Delete");
  await expect(swatch).toHaveCount(0);
  expect((await editorState(page)).elements).toHaveLength(1);
  await hex.fill("red");
  await add.click();
  await popup.getByRole("button", { name: "从色板移除当前颜色" }).click();
  await expect(
    popup.getByRole("button", { name: "使用收藏颜色 #ff0000" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
});

test("personal palette ignores other accounts, synchronizes storage events and reports write failure", async ({
  page,
  workspace,
}) => {
  void workspace;
  await page.evaluate(() =>
    localStorage.setItem(
      "workspace:color-palette:v1:other-user",
      '["#ff0000"]',
    ),
  );
  await rectangle(page);
  const popup = await picker(page);

  await expect(
    popup.getByRole("button", { name: "使用收藏颜色 #ff0000" }),
  ).toHaveCount(0);
  await page.evaluate((key) => {
    localStorage.setItem(key, '["#112233"]');
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: '["#112233"]',
        storageArea: localStorage,
      }),
    );
  }, storageKey);
  await expect(
    popup.getByRole("button", { name: "使用收藏颜色 #112233" }),
  ).toBeVisible();
  await popup.locator(".color-picker-input").fill("445566");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;

    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("workspace:color-palette:"))
        throw new DOMException("Storage full", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  await popup.getByRole("button", { name: "收藏当前颜色" }).click();
  await expect(popup.getByRole("status")).toContainText("浏览器无法保存色板");
  await popup.getByRole("button", { name: "使用收藏颜色 #445566" }).click();
  await expect
    .poll(() =>
      editorState(page).then((state) => state.elements[0].strokeColor),
    )
    .toBe("#445566");
});

test("switching accounts loads a separate palette and a full palette stays usable on short screens", async ({
  page,
  workspace,
}) => {
  const colors = Array.from(
    { length: 24 },
    (_, index) => `#${(index + 100).toString(16).padStart(6, "0")}`,
  );

  await page.evaluate(
    ({ key, colors }) => {
      localStorage.setItem(key, JSON.stringify(colors));
      localStorage.setItem(
        "workspace:color-palette:v1:other-user",
        '["#ff0000"]',
      );
    },
    { key: storageKey, colors },
  );
  await page.reload();
  await rectangle(page);
  await page.setViewportSize({ width: 1024, height: 420 });
  let popup = await picker(page);

  await expect(
    popup.getByRole("button", { name: /^使用收藏颜色/ }),
  ).toHaveCount(24);
  await expect(
    popup.getByRole("button", { name: "收藏当前颜色" }),
  ).toBeDisabled();
  const last = popup.getByRole("button", {
    name: `使用收藏颜色 ${colors.at(-1)}`,
  });

  await last.focus();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Delete");
  await expect(last).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  workspace.mock.user.id = "other-user";
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), {
    key: announcementKey("other-user", currentRelease.sequence),
    id: currentRelease.id,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await rectangle(page);
  popup = await picker(page);
  await expect(
    popup.getByRole("button", { name: /^使用收藏颜色/ }),
  ).toHaveCount(1);
  await expect(
    popup.getByRole("button", { name: "使用收藏颜色 #ff0000" }),
  ).toBeVisible();
});
