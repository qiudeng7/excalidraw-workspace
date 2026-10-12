import { test, expect, editorState } from "./fixtures";
import type { Page } from "@playwright/test";
import { currentRelease, releases } from "../../src/data/releases";
import {
  announcementKey,
  announcementPrefix,
} from "../../src/lib/releaseProgress";

test.use({ announcementSeen: false });
const popup = (page: Page) =>
  page.getByRole("dialog", { name: "更新公告", exact: true });
const key = announcementKey("test-user", currentRelease.sequence);

async function shown(page: Page) {
  await expect(popup(page)).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
    .toBe(currentRelease.id);
}

test("current announcement appears once, Esc closes it and settings retain historical notes", async ({
  page,
  workspace: f,
}) => {
  await shown(page);
  await expect(
    popup(page).getByText(currentRelease.title, { exact: true }),
  ).toBeVisible();
  await expect(
    popup(page).getByText(releases[1]!.title, { exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popup(page)).toBeHidden();
  await expect(page.locator(".excalidraw")).toBeFocused();
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await f.open();
  await f.dialog.getByRole("tab", { name: "更新日志", exact: true }).click();
  await expect(
    f.dialog.getByText(currentRelease.title, { exact: true }),
  ).toBeVisible();
  await f.dialog
    .locator("summary")
    .filter({ hasText: releases[1]!.title })
    .click();
  await expect(
    f.dialog.getByText(releases[1]!.summary, { exact: true }),
  ).toBeVisible();
  await f.close();
  await expect(popup(page)).toHaveCount(0);
});

test("other tabs reuse shown progress while different accounts get their own announcement", async ({
  page,
  context,
  workspace: f,
}) => {
  await shown(page);
  await popup(page).getByRole("button", { name: "继续绘图" }).click();
  const other = await context.newPage();

  try {
    await other.goto("/");
    await expect(other.locator(".excalidraw")).toBeVisible();
    await expect(
      other.getByRole("button", { name: "设置", exact: true }),
    ).toBeEnabled();
    await expect(popup(other)).toHaveCount(0);
    f.mock.user.id = "other-user";
    await other.reload();
    await expect(popup(other)).toBeVisible();
    await expect
      .poll(() =>
        other.evaluate(
          (key) => localStorage.getItem(key),
          announcementKey("other-user", currentRelease.sequence),
        ),
      )
      .toBe(currentRelease.id);
    await popup(other).getByRole("button", { name: "关闭更新公告" }).click();
    f.mock.user.id = "test-user";
    await other.reload();
    await expect(other.locator(".excalidraw")).toBeVisible();
    await expect(popup(other)).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test("a rollback or a late older mark never shows an older popup", async ({
  page,
  workspace,
}) => {
  await shown(page);
  await popup(page).getByRole("button", { name: "继续绘图" }).click();
  await page.evaluate(
    ({ future, old }) => {
      localStorage.setItem(future, "future-release");
      localStorage.setItem(old, "old-release");
      window.dispatchEvent(
        new StorageEvent("storage", { key: old, newValue: "old-release" }),
      );
    },
    {
      future: announcementKey("test-user", currentRelease.sequence + 1),
      old: announcementKey("test-user", 1),
    },
  );
  await page.reload();
  await workspace.open();
  await workspace.close();
  await expect(popup(page)).toHaveCount(0);
});

test("storage quota failure still allows closing and prevents repeated popups in this page", async ({
  page,
  context,
  workspace: f,
}) => {
  await shown(page);
  await popup(page).getByRole("button", { name: "继续绘图" }).click();
  await page.evaluate((key) => localStorage.removeItem(key), key);
  await context.addInitScript((prefix) => {
    const write = Storage.prototype.setItem;

    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix))
        throw new DOMException("full", "QuotaExceededError");

      return write.call(this, key, value);
    };
  }, announcementPrefix("test-user"));
  await page.reload();
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole("button", { name: "继续绘图" }).click();
  await f.open();
  await f.close();
  await expect(popup(page)).toHaveCount(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), key),
  ).toBeNull();
});

test("failed dialog opening does not mark success and can be retried", async ({
  page,
  context,
  workspace,
}) => {
  await shown(page);
  await popup(page).getByRole("button", { name: "继续绘图" }).click();
  await page.evaluate((key) => localStorage.removeItem(key), key);
  await context.addInitScript(() => {
    const show = HTMLDialogElement.prototype.showModal;
    let fail = true;

    HTMLDialogElement.prototype.showModal = function () {
      if (this.classList.contains("release-dialog") && fail) {
        fail = false;
        throw new DOMException("test failure", "InvalidStateError");
      }

      show.call(this);
    };
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "重试公告" })).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), key),
  ).toBeNull();
  await page.getByRole("button", { name: "重试公告" }).click();
  await shown(page);
  await popup(page).getByRole("button", { name: "继续绘图" }).click();
  await workspace.open();
  await workspace.close();
});

for (const accountRole of ["user", "admin"] as const) {
  test.describe(accountRole, () => {
    test.use({ accountRole });
    test("mobile announcement scrolls and update history works when cloud settings fail", async ({
      page,
      workspace: f,
    }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await shown(page);
      const dimensions = await popup(page).evaluate((element) => {
        const body = element.querySelector(".release-body")!;

        return {
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          scrollable: body.scrollHeight > body.clientHeight,
        };
      });

      expect(dimensions.width).toBeLessThanOrEqual(320);
      expect(dimensions.height).toBeLessThanOrEqual(568);
      expect(dimensions.scrollable).toBe(true);
      await popup(page).getByRole("button", { name: "继续绘图" }).click();
      f.mock.mode = "unavailable";
      await page.reload();
      await f.open();
      await f.dialog
        .getByRole("tab", { name: "更新日志", exact: true })
        .click();
      await expect(
        f.dialog.getByText(currentRelease.title, { exact: true }),
      ).toBeVisible();
      await expect(
        f.dialog.getByRole("button", { name: "重新读取设置" }),
      ).toBeEnabled();
      await f.close();
    });
  });
}

test("a delayed announcement preserves edits, in-flight autosave, shortcuts and undo", async ({
  page,
  context,
  workspace,
}) => {
  await shown(page);
  await popup(page).getByRole("button", { name: "继续绘图" }).click();
  await page.evaluate(
    async ({ key, lock }) => {
      localStorage.removeItem(key);
      await new Promise<void>((resolve) => {
        void navigator.locks.request(lock, async () => {
          resolve();
          await new Promise<void>((release) => {
            (window as any).releaseAnnouncementLock = release;
          });
        });
      });
    },
    { key, lock: `${announcementPrefix("test-user")}display` },
  );
  const other = await context.newPage();
  let releaseSave!: () => void;
  let saving = false;
  const gate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });

  try {
    await other.route("**/api/canvases/test-canvas", async (route) => {
      if (route.request().method() === "PUT") {
        saving = true;
        await gate;
      }

      await route.fallback();
    });
    await other.goto("/");
    await expect(other.getByTestId("toolbar-rectangle").first()).toBeVisible();
    await other.getByTestId("toolbar-rectangle").first().click();
    const box = (await other
      .locator(".excalidraw canvas")
      .last()
      .boundingBox())!;

    await other.mouse.move(box.x + 350, box.y + 200);
    await other.mouse.down();
    await other.mouse.move(box.x + 500, box.y + 320);
    await other.mouse.up();
    await expect.poll(() => saving).toBe(true);
    const before = await editorState(other);

    await page.evaluate(() => (window as any).releaseAnnouncementLock());
    await shown(other);
    for (const shortcut of [
      "Delete",
      "Control+z",
      "Alt+r",
      "Control+s",
      "Control+f",
    ])
      await other.keyboard.press(shortcut);
    expect(await editorState(other)).toEqual(before);
    releaseSave();
    await expect(other.locator(".save-state")).toHaveText("已保存");
    await popup(other).getByRole("button", { name: "继续绘图" }).click();
    expect(await editorState(other)).toEqual(before);
    await other.locator(".excalidraw").focus();
    await other.keyboard.press("Control+z");
    await expect
      .poll(() => editorState(other).then((state) => state.elements.length))
      .toBe(0);
  } finally {
    releaseSave();
    await page.evaluate(() => (window as any).releaseAnnouncementLock());
    await other.close();
  }
});
