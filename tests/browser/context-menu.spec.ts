import type { Page } from "@playwright/test";
import { test, expect, editorState } from "./fixtures";

async function drawRectangle(page: Page) {
  await page.getByTestId("toolbar-rectangle").first().click();
  const canvas = (await page
    .locator(".excalidraw canvas")
    .last()
    .boundingBox())!;
  const x = canvas.x + canvas.width * 0.55;
  const y = canvas.y + canvas.height * 0.25;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.min(140, canvas.width * 0.25), y + 90);
  await page.mouse.up();
  await expect
    .poll(() => editorState(page).then((state) => state.elements.length))
    .toBe(1);

  return { x: x + 10, y };
}

async function workspaceColors(page: Page) {
  return page.locator(".canvas-host").evaluate((element) => {
    const probe = document.createElement("span");

    element.appendChild(probe);
    const colors = Object.fromEntries(
      ["surface", "text", "muted", "hover", "danger", "danger-bg", "focus"].map(
        (name) => {
          probe.style.color = `var(--app-${name})`;

          return [name, getComputedStyle(probe).color];
        },
      ),
    );

    probe.remove();

    return colors;
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: element and canvas menus follow the workspace theme and preserve keyboard actions`, async ({
    page,
    workspace,
  }, testInfo) => {
    void workspace;
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const point = await drawRectangle(page);

    await page.mouse.click(point.x, point.y, { button: "right" });
    const menu = page.locator(".context-menu-popover");
    const colors = await workspaceColors(page);
    const first = menu.getByRole("button").first();
    const dangerous = menu.locator(".context-menu-item.dangerous");

    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS("background-color", colors.surface);
    await expect(first).toHaveCSS("color", colors.text);
    await expect(
      menu.locator(".context-menu-item__shortcut").first(),
    ).toHaveCSS("color", colors.muted);
    await first.hover();
    await expect(first).toHaveCSS("background-color", colors.hover);
    await dangerous.hover();
    await expect(dangerous).toHaveCSS("background-color", colors["danger-bg"]);
    await expect(dangerous.locator(".context-menu-item__label")).toHaveCSS(
      "color",
      colors.danger,
    );
    await page.mouse.move(point.x - 30, point.y - 20);
    await page.screenshot({
      path: testInfo.outputPath(`${theme}-element.png`),
    });
    await menu.focus();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await expect(first).toHaveCSS("outline-color", colors.focus);
    await expect(first).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await page.mouse.click(point.x, point.y, { button: "right" });
    await menu.getByTestId("duplicateSelection").getByRole("button").focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(2);
    expect((await editorState(page)).editingTextElement).toBeNull();

    const canvas = (await page
      .locator(".excalidraw canvas")
      .last()
      .boundingBox())!;

    await page.mouse.click(canvas.x + canvas.width - 50, canvas.y + 70, {
      button: "right",
    });
    await expect(menu.getByTestId("gridMode")).toBeVisible();
    await menu.getByTestId("gridMode").getByRole("button").focus();
    await page.keyboard.press("Space");
    await expect(menu).toBeHidden();
    await page.mouse.click(canvas.x + canvas.width - 50, canvas.y + 70, {
      button: "right",
    });
    await expect(menu.getByTestId("gridMode").getByRole("button")).toHaveClass(
      /checkmark/,
    );
    await page.screenshot({ path: testInfo.outputPath(`${theme}-canvas.png`) });
    await page.mouse.click(canvas.x + 280, canvas.y + 70);
    await expect(menu).toBeHidden();
  });
}

for (const width of [320, 1024]) {
  test(`${width}x320: the long element menu stays inside the canvas and its last action remains reachable`, async ({
    page,
    workspace,
  }, testInfo) => {
    void workspace;
    await page.setViewportSize({ width, height: 320 });
    const backdrop = page.locator(".sidebar-backdrop");

    if (await backdrop.isVisible())
      await backdrop.click({ position: { x: width - 10, y: 100 } });
    const point = await drawRectangle(page);

    await page.mouse.click(point.x, point.y, { button: "right" });
    const menu = page.locator(".context-menu-popover");

    await expect(menu).toBeVisible();
    const host = (await page.locator(".excalidraw").boundingBox())!;
    const bounds = (await menu.boundingBox())!;

    expect(bounds.x).toBeGreaterThanOrEqual(host.x + 9);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      host.x + host.width - 9,
    );
    expect(bounds.y).toBeGreaterThanOrEqual(host.y + 9);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      host.y + host.height - 9,
    );
    expect(
      await menu.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
      "the narrow menu must not require horizontal scrolling",
    ).toBe(false);
    const last = menu.getByRole("button").last();

    await menu.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 1 });
    await expect(last).toHaveCSS("outline-style", "solid");
    await page.mouse.move(5, 5);
    await page.screenshot({ path: testInfo.outputPath(`${width}-short.png`) });
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect
      .poll(() => editorState(page).then((state) => state.elements.length))
      .toBe(0);
  });
}
