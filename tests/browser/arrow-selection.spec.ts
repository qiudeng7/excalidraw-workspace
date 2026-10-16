import { test, expect, editorState } from "./fixtures";

test("arrow path highlight defaults on, toggles immediately without document edits and persists after reload", async ({
  page,
  workspace: f,
}, testInfo) => {
  await expect
    .poll(() => editorState(page).then((s) => s.arrowSelectionHighlight))
    .toBe(true);
  const box = (await page.locator("canvas.interactive").boundingBox())!;

  await page.getByTestId("toolbar-arrow").first().click();
  await page.mouse.move(box.x + 350, box.y + 240);
  await page.mouse.down();
  await page.mouse.move(box.x + 600, box.y + 430);
  await page.mouse.up();
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(box.x + 800, box.y + 240);
  await page.mouse.down();
  await page.mouse.move(box.x + 900, box.y + 340);
  await page.mouse.up();
  await page.getByTestId("toolbar-selection").first().click();
  await page.mouse.click(box.x + 475, box.y + 335);
  await page.keyboard.down("Control");
  await page.mouse.click(box.x + 850, box.y + 240);
  await page.keyboard.up("Control");
  await expect
    .poll(() =>
      editorState(page).then((s) => Object.keys(s.selectedElementIds).length),
    )
    .toBe(2);
  const before = await editorState(page);

  await page.screenshot({ path: testInfo.outputPath("host-multi-on.png") });
  await f.open();
  await f.dialog.getByRole("tab", { name: "编辑器", exact: true }).click();
  const checkbox = f.dialog.getByRole("checkbox", {
    name: "箭头沿线选中高亮",
    exact: true,
  });

  await expect(checkbox).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("settings-on.png") });
  await checkbox.locator("..").click();
  await expect
    .poll(() => editorState(page).then((s) => s.arrowSelectionHighlight))
    .toBe(false);
  await expect
    .poll(() => f.mock.settings.features.arrowSelectionHighlight)
    .toBe(false);
  await f.close();
  const off = await editorState(page);

  expect(off.elements).toEqual(before.elements);
  expect(off.selectedElementIds).toEqual(before.selectedElementIds);
  await page.screenshot({ path: testInfo.outputPath("host-multi-off.png") });
  await page.reload();
  await expect
    .poll(() => editorState(page).then((s) => s.arrowSelectionHighlight))
    .toBe(false);
  await f.open();
  await f.dialog.getByRole("tab", { name: "编辑器", exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.locator("..").click();
  await expect
    .poll(() => editorState(page).then((s) => s.arrowSelectionHighlight))
    .toBe(true);
  await expect
    .poll(() => f.mock.settings.features.arrowSelectionHighlight)
    .toBe(true);
  await f.close();
  await page.reload();
  await expect
    .poll(() => editorState(page).then((s) => s.arrowSelectionHighlight))
    .toBe(true);
});
