import { test, expect, editorState } from "./fixtures";

test("settings preserve the original tool, selection and Alt+R view mode", async ({
  page,
  workspace: f,
}) => {
  await page.getByTestId("toolbar-rectangle").first().click();
  const preserve = async () => {
    const before = await editorState(page);

    await f.open();
    expect(await editorState(page)).toEqual(before);
    await f.close();
    await expect.poll(() => editorState(page)).toEqual(before);
  };

  await preserve();
  const box = (await page.locator(".excalidraw canvas").last().boundingBox())!;

  await page.mouse.move(box.x + 350, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 320);
  await page.mouse.up();
  await expect
    .poll(() =>
      editorState(page).then(
        (state) => Object.keys(state.selectedElementIds).length,
      ),
    )
    .toBe(1);
  await preserve();
  await page.locator(".excalidraw").focus();
  await page.keyboard.press("Alt+r");
  await expect
    .poll(() => editorState(page).then((state) => state.viewModeEnabled))
    .toBe(true);
  await preserve();
});

test("modal isolates canvas shortcuts and clipboard while inputs accept Chinese text", async ({
  page,
  workspace: f,
}) => {
  await page.getByTestId("toolbar-rectangle").first().click();
  const box = (await page.locator(".excalidraw canvas").last().boundingBox())!;

  await page.mouse.move(box.x + 350, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 320);
  await page.mouse.up();
  await expect
    .poll(() =>
      editorState(page).then(
        (state) => Object.keys(state.selectedElementIds).length,
      ),
    )
    .toBe(1);
  const before = await editorState(page);

  await f.open();
  await f.dialog.getByRole("tab", { name: "通用", exact: true }).focus();
  for (const key of [
    "r",
    "v",
    "Delete",
    "Control+z",
    "Alt+r",
    "Space",
    "Control+s",
    "Control+f",
    "Control+/",
    "Control+p",
  ])
    await page.keyboard.press(key);
  await f.dialog
    .getByRole("tab", { name: "通用", exact: true })
    .evaluate((element) => {
      const data = new DataTransfer();

      data.setData("text/plain", "穿透文本");
      for (const type of ["paste", "copy", "cut"])
        element.dispatchEvent(
          new ClipboardEvent(type, {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          }),
        );
    });
  expect(await editorState(page)).toEqual(before);
  await f.dialog.getByRole("tab", { name: "账号", exact: true }).click();
  const password = f.dialog.getByLabel("原密码", { exact: true });

  await password.fill("隔离中文输入");
  await password.press("Control+a");
  await password.press("Backspace");
  await expect(password).toHaveValue("");
  await page.evaluate(() => navigator.clipboard.writeText("设置内粘贴中文"));
  await password.press("Control+v");
  await expect(password).toHaveValue("设置内粘贴中文");
  expect(await editorState(page)).toEqual(before);
  await f.close();
  await expect.poll(() => editorState(page)).toEqual(before);
});

test("opening settings naturally commits Chinese text on blur and drawing resumes", async ({
  page,
  workspace: f,
}) => {
  const box = (await page.locator(".excalidraw canvas").last().boundingBox())!;

  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(box.x + 350, box.y + 250);
  await page.locator(".excalidraw-wysiwyg").fill("正在编辑的中文文本");
  expect((await editorState(page)).editingTextElement).toBeTruthy();
  await f.open();
  await expect
    .poll(() => editorState(page).then((state) => state.editingTextElement))
    .toBeNull();
  await f.close();
  await expect(page.locator(".excalidraw-wysiwyg")).toHaveCount(0);
  expect(
    (await editorState(page)).elements.find(
      (element: any) => element.type === "text",
    )?.text,
  ).toBe("正在编辑的中文文本");
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(box.x + 500, box.y + 400);
  await page.mouse.down();
  await page.mouse.move(box.x + 600, box.y + 500);
  await page.mouse.up();
  await expect
    .poll(() => editorState(page).then((state) => state.elements.length))
    .toBe(2);
});
