import { test, expect, editorState } from "./fixtures";

test("Markdown shortcuts edit formatted text and retain it across Canvas, SVG and re-entry", async ({
  page,
  workspace,
}) => {
  await expect(page.locator(".excalidraw")).toBeVisible();
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await expect(input).toBeVisible();
  await input.pressSequentially("**Bold**", { delay: 25 });
  await expect(input.locator("strong")).toHaveText("Bold");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await document.fonts.load("16px Nunito", "Bold");

        return document.fonts.check("16px Nunito", "Bold");
      }),
    )
    .toBe(true);
  await input.pressSequentially(" plain *italic* `code`");
  await expect(input.locator("em")).toHaveText("italic");
  await expect(input.locator("code")).toHaveText("code");
  await input.press("Enter");
  await input.pressSequentially("中文 emoji 👩‍💻");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  const state = await editorState(page);
  const text = state.elements.find(
    (element: any) => element.type === "text",
  ) as any;

  expect(text.originalText).toBe("Bold plain italic code\n中文 emoji 👩‍💻");
  expect(text.richText.version).toBe(1);
  expect(text.richText.doc.content[0].content[0].marks).toEqual([
    { type: "bold" },
  ]);
  await page.mouse.dblclick(705, 355);
  await expect(input.locator("strong")).toHaveText("Bold");
  await expect(input).not.toContainText("**");
  await input.press("Escape");
  await page.screenshot({ path: "/tmp/rich-text-canvas-prototype.png" });
  const exported = await page.locator(".excalidraw").evaluate(async (node) => {
    const host = node as any;
    let fiber =
      host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

    while (fiber && !fiber.stateNode?.state?.activeTool) fiber = fiber.return;
    const app = fiber.stateNode;
    const actions = app.actionManager.actions;

    await actions.copyAsSvg.perform(
      app.api.getSceneElements(),
      app.state,
      null,
      app,
    );
    const svg = await navigator.clipboard.readText();

    await actions.copyAsPng.perform(
      app.api.getSceneElements(),
      app.state,
      null,
      app,
    );
    const items = await navigator.clipboard.read();
    const png = await items[0].getType("image/png");
    const bitmap = await createImageBitmap(png);

    return {
      svg,
      png: { size: png.size, width: bitmap.width, height: bitmap.height },
    };
  });

  expect(exported.svg).toContain('font-weight="700"');
  expect(exported.svg).toContain('font-style="italic"');
  expect(exported.svg).toContain("ui-monospace");
  expect(exported.svg).not.toContain("foreignObject");
  expect(exported.png.width).toBeGreaterThan(text.width);
  expect(exported.png.height).toBeGreaterThan(text.height);
  expect(exported.png.size).toBeGreaterThan(100);
  await page.mouse.dblclick(705, 355);
  await input.press("ControlOrMeta+A");
  await input.press("ControlOrMeta+\\");
  await expect(input.locator("strong,em,code")).toHaveCount(0);
  await input.press("Escape");
  const cleared = (await editorState(page)).elements.find(
    (element: any) => element.type === "text",
  ) as any;

  expect(cleared.richText).toBeTruthy();
  expect(
    cleared.richText.doc.content[0].content.some(
      (node: any) => node.marks?.length,
    ),
  ).toBe(false);
});

test("undoing an input rule restores literal markers and plain text paste does not format", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially("**literal**", { delay: 20 });
  await expect(input.locator("strong")).toHaveText("literal");
  await input.press("Backspace");
  await expect(input.locator("strong")).toHaveCount(0);
  await expect(input).toContainText("**literal**");
  await input.press("ControlOrMeta+A");
  await input.evaluate((node) => {
    const clipboardData = new DataTransfer();

    clipboardData.setData("text/plain", "**paste**\n*literal*");
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(input).toContainText("**paste**");
  await expect(input.locator("strong,em")).toHaveCount(0);
  await input.press("ControlOrMeta+A");
  await input.pressSequentially("**a *b* c**", { delay: 10 });
  await expect(input.locator("strong em")).toHaveText("b");
  await input.press("ControlOrMeta+A");
  await input.pressSequentially("**مرحبا English**", { delay: 10 });
  await expect(input).toHaveAttribute("dir", "auto");
  await expect(input.locator("strong")).toHaveText("مرحبا English");
  await input.press("Escape");
});

test("bound rich text wraps, IME commits normally, and whole-element clipboard/library preserve formatting", async ({
  page,
  workspace,
}) => {
  workspace.mock.settings.features.disableDefaultSidebar = false;
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await page.getByRole("button", { name: "素材库", exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".excalidraw").evaluate((node) => {
        const host = node as any;
        let fiber =
          host[
            Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!
          ];

        while (fiber && !fiber.stateNode?.api?.getSceneElements)
          fiber = fiber.return;

        return fiber.stateNode.props.libraryReady;
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(700, 350);
  await page.mouse.down();
  await page.mouse.move(900, 450);
  await page.mouse.up();
  await page.mouse.dblclick(800, 400);
  const input = page.locator(".excalidraw-wysiwyg");

  await expect(input).toBeVisible();
  await input.pressSequentially("**");
  const cdp = await page.context().newCDPSession(page);

  await cdp.send("Input.imeSetComposition", {
    text: "中文",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await cdp.send("Input.insertText", { text: "中文" });
  await input.pressSequentially(
    "** bound formatted text continues over several lines",
    { delay: 5 },
  );
  await expect(input.locator("strong")).toHaveText("中文");
  await input.press("Escape");
  const state = await editorState(page);
  const text = state.elements.find(
    (element: any) => element.type === "text",
  ) as any;

  expect(text.containerId).toBeTruthy();
  expect(text.text.split("\n").length).toBeGreaterThan(1);
  expect(text.originalText).toBe(
    "中文 bound formatted text continues over several lines",
  );
  await page.keyboard.press("ControlOrMeta+c");
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );

  expect(
    copied.elements.find((element: any) => element.type === "text").richText,
  ).toEqual(text.richText);
  await page.keyboard.press("ControlOrMeta+v");
  await expect
    .poll(() =>
      editorState(page).then(
        (value) =>
          value.elements.filter((element: any) => element.type === "text")
            .length,
      ),
    )
    .toBe(2);
  const library = await page.locator(".excalidraw").evaluate(async (node) => {
    const host = node as any;
    let fiber =
      host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

    while (fiber && !fiber.stateNode?.api?.getSceneElements)
      fiber = fiber.return;
    const app = fiber.stateNode;

    await app.actionManager.actions.addToLibrary.perform(
      app.api.getSceneElements(),
      app.state,
      null,
      app,
    );
    const items = JSON.parse(
      JSON.stringify(await app.library.getLatestLibrary()),
    );

    await app.api.updateLibrary({ libraryItems: items, merge: false });

    return app.library.getLatestLibrary();
  });

  expect(
    library[0].elements.find((element: any) => element.type === "text")
      .richText,
  ).toEqual(text.richText);
  await page.screenshot({ path: "/tmp/rich-text-bound-ime.png" });
});

test("unknown rich-text versions remain visible and do not leave a stuck editing session", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially("future literal **text**");
  await input.press("Escape");
  await page.locator(".excalidraw").evaluate((node) => {
    const host = node as any;
    let fiber =
      host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

    while (fiber && !fiber.stateNode?.api?.getSceneElements)
      fiber = fiber.return;
    const app = fiber.stateNode;
    const elements = app.api.getSceneElements().map((element: any) => ({
      ...element,
      richText: { version: 2, doc: { future: true } },
    }));

    app.api.updateScene({ elements, captureUpdate: "NEVER" });
  });
  await page.mouse.dblclick(705, 355);
  await expect(input).toHaveCount(0);
  await expect
    .poll(() => editorState(page).then((state) => state.editingTextElement))
    .toBeNull();
  await expect(
    page.getByText("此文字使用了暂不支持的富文本格式，请更新后编辑"),
  ).toBeVisible();
  const state = await editorState(page);

  expect((state.elements[0] as any).richText.version).toBe(2);
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(950, 450);
  await page.mouse.down();
  await page.mouse.move(1050, 520);
  await page.mouse.up();
  expect((await editorState(page)).elements.length).toBe(2);
});
