import { test, expect } from "./fixtures";

const viewports = [
  [1440, 900],
  [1024, 768],
  [768, 900],
  [390, 844],
  [320, 568],
  [844, 390],
  [667, 375],
  [568, 320],
  [1024, 375],
];

for (const [width, height] of viewports) {
  for (const bottom of [true, false]) {
    test(`${width}x${height}: ${bottom ? "bottom" : "top"} toolbar menu stays within canvas and its last item is reachable`, async ({
      page,
      workspace: f,
    }) => {
      await page.setViewportSize({ width, height });
      await f.open();
      await f.setBottomToolbar(bottom);
      await f.close();
      const backdrop = page.locator(".sidebar-backdrop");

      if (await backdrop.isVisible())
        await backdrop.click({
          position: { x: width - 10, y: Math.min(200, height - 10) },
        });
      const mobile = (await page.locator(".excalidraw--mobile").count()) > 0;
      const toolbar = page.locator(
        mobile
          ? ".App-bottom-bar > .App-toolbar"
          : ".shapes-section .App-toolbar",
      );
      const menu = page.locator(".App-toolbar__extra-tools-dropdown");

      await page.locator(".App-toolbar__extra-tools-trigger").click();
      await expect(menu).toBeVisible();
      await expect
        .poll(async () => {
          const host = (await page.locator(".canvas-host").boundingBox())!;
          const bar = (await toolbar.boundingBox())!;
          const extra = (await menu.boundingBox())!;

          return (
            extra.y >= host.y - 1 &&
            extra.y + extra.height <= host.y + host.height + 1 &&
            (bottom
              ? extra.y + extra.height <= bar.y + 1
              : extra.y >= bar.y + bar.height - 1)
          );
        })
        .toBe(true);
      await menu.locator(".dropdown-menu-container").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const lastItem = menu.getByRole("menuitem").last();

      await expect(lastItem).toBeInViewport({ ratio: 1 });
      await lastItem.click({ trial: true });
      const last = (await lastItem.boundingBox())!;
      const host = (await page.locator(".canvas-host").boundingBox())!;

      expect(last.y + last.height).toBeLessThanOrEqual(
        Math.min(host.y + host.height, height) + 1,
      );
    });
  }
}
