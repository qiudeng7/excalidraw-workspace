import { test, expect, editorState } from "./fixtures";

test("Ctrl and Shift clicks extend and toggle selection, with live settings and original group drilling", async ({
  page,
  workspace: f,
}) => {
  const box = (await page.locator(".excalidraw canvas").last().boundingBox())!;
  const a = { x: box.x + 350, y: box.y + 240 };
  const b = { x: box.x + 600, y: box.y + 240 };

  for (const point of [a, b]) {
    await page.getByTestId("toolbar-rectangle").first().click();
    await page.mouse.move(point.x - 50, point.y - 40);
    await page.mouse.down();
    await page.mouse.move(point.x + 50, point.y + 40);
    await page.mouse.up();
  }

  const selected = (count: number) =>
    expect
      .poll(() =>
        editorState(page).then(
          (state) => Object.keys(state.selectedElementIds).length,
        ),
      )
      .toBe(count);
  const click = async (point: typeof a, modifier?: "Control" | "Shift") => {
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.click(point.x, point.y - 40);
    if (modifier) await page.keyboard.up(modifier);
  };

  await click(a);
  await click(b, "Control");
  await selected(2);
  await click(a, "Control");
  await selected(1);
  await click(a, "Shift");
  await selected(2);
  await click(b, "Shift");
  await selected(1);
  await f.open();
  await f.dialog.getByRole("tab", { name: "编辑器", exact: true }).click();
  const checkbox = f.dialog.getByRole("checkbox", {
    name: "Ctrl 点击多选",
    exact: true,
  });

  await expect(checkbox).toBeChecked();
  await checkbox.locator("..").click();
  await expect.poll(() => f.mock.settings.features.ctrlMultiSelect).toBe(false);
  await f.close();
  await selected(1);
  await click(b, "Control");
  await selected(1);
  await click(a, "Shift");
  await selected(2);
  await page.locator(".excalidraw").focus();
  await page.keyboard.press("Control+g");
  await page.mouse.click(box.x + 850, box.y + 400);
  await click(a);
  await selected(2);
  await click(b, "Control");
  await selected(1);
  await f.open();
  await f.dialog.getByRole("tab", { name: "编辑器", exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.locator("..").click();
  await expect.poll(() => f.mock.settings.features.ctrlMultiSelect).toBe(true);
  await f.close();
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.keyboard.down("Control");
  await page.mouse.move(box.x + 800, box.y + 450);
  await page.mouse.down();
  await page.mouse.move(box.x + 930, box.y + 510);
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect
    .poll(() => editorState(page).then((state) => state.elements.length))
    .toBe(3);
  const third = (await editorState(page)).elements[2];

  expect(Math.abs(third.width - third.height)).toBeGreaterThan(40);
  await page.locator(".excalidraw").focus();
  await page.keyboard.press("Control+s");
  await selected(1);
  await click(a, "Control");
  await selected(3);
});
