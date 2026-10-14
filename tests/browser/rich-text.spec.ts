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
  await expect(input).toHaveCSS("font-synthesis", "weight style");
  await expect(input.locator("strong")).toHaveCSS(
    "font-synthesis",
    "weight style",
  );
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
  expect(text.richText.version).toBe(2);
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
  await page.evaluate(() =>
    navigator.clipboard.writeText("**paste**\n*literal*"),
  );
  await input.press("ControlOrMeta+Shift+V");
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
      richText: { version: 99, doc: { future: true } },
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

  expect((state.elements[0] as any).richText.version).toBe(99);
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(950, 450);
  await page.mouse.down();
  await page.mouse.move(1050, 520);
  await page.mouse.up();
  expect((await editorState(page)).elements.length).toBe(2);
});

// Use the browser clipboard, so paste modifier handling is exercised as well as parsing.
test("Markdown blocks survive edit, save and reload; SVG and PNG use formatted layout", async ({
  page,
  workspace,
}) => {
  let savedScene: any;

  await page.route("**/api/canvases/test-canvas", async (route) => {
    if (route.request().method() === "PUT") {
      savedScene = route.request().postDataJSON().scene;

      return route.fallback();
    }

    return route.fallback();
  });
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(550, 200);
  const input = page.locator(".excalidraw-wysiwyg");
  const markdown = [
    "# Heading",
    "",
    "A **bold** and *italic* with `inline` and ~~deleted~~ [link](https://example.com).",
    "",
    "- alpha",
    "- beta",
    "",
    "3. third",
    "4. fourth",
    "",
    "> quoted",
    "",
    "```js",
    "const x = '**literal**';",
    "```",
  ].join("\n");

  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await input.press("ControlOrMeta+V");
  await expect(input.locator("h1")).toHaveText("Heading");
  await expect(input.locator("ul li")).toHaveCount(2);
  await expect(input.locator("ol li")).toHaveCount(2);
  await expect(input.locator("blockquote")).toContainText("quoted");
  await expect(input.locator("pre code")).toContainText("**literal**");
  await expect(input.locator("s,del")).toHaveText("deleted");
  await expect(input.locator("a")).toHaveAttribute(
    "href",
    "https://example.com",
  );
  const typography = await input.evaluate((node) => {
    const style = getComputedStyle(node);

    return {
      base: parseFloat(style.fontSize),
      heading: parseFloat(getComputedStyle(node.querySelector("h1")!).fontSize),
      margins: Array.from(node.querySelectorAll("p")).map((p) => [
        getComputedStyle(p).marginTop,
        getComputedStyle(p).marginBottom,
      ]),
    };
  });

  expect(typography.heading).toBeGreaterThan(typography.base);
  expect(
    typography.margins.every(
      ([top, bottom]) => top === "0px" && bottom === "0px",
    ),
  ).toBe(true);
  await input.press("ControlOrMeta+Enter");
  await expect(input).toHaveCount(0);
  const original = (await editorState(page)).elements.find(
    (element: any) => element.type === "text",
  ) as any;

  expect(original.richText.version).toBe(2);
  await expect
    .poll(() =>
      savedScene?.elements?.some(
        (element: any) =>
          element.id === original.id && element.richText?.version === 2,
      ),
    )
    .toBe(true);
  const exported = await page.locator(".excalidraw").evaluate(async (node) => {
    const host = node as any;
    let fiber =
      host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

    while (fiber && !fiber.stateNode?.state?.activeTool) fiber = fiber.return;
    const app = fiber.stateNode;

    await app.actionManager.actions.copyAsSvg.perform(
      app.api.getSceneElements(),
      app.state,
      null,
      app,
    );
    const svg = await navigator.clipboard.readText();

    await app.actionManager.actions.copyAsPng.perform(
      app.api.getSceneElements(),
      app.state,
      null,
      app,
    );
    const [item] = await navigator.clipboard.read();
    const blob = await item.getType("image/png");
    const bitmap = await createImageBitmap(blob);

    return { svg, width: bitmap.width, height: bitmap.height, size: blob.size };
  });

  expect(exported.svg).toContain("Heading");
  expect(exported.svg).toContain("quoted");
  expect(exported.svg).toContain('font-weight="700"');
  expect(exported.svg).not.toContain("foreignObject");
  expect(exported.width).toBeGreaterThan(original.width);
  expect(exported.height).toBeGreaterThan(original.height);
  expect(exported.size).toBeGreaterThan(100);
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect
    .poll(async () =>
      (await editorState(page)).elements.find(
        (element: any) => element.id === original.id,
      ),
    )
    .toMatchObject({ richText: original.richText });
  await page.mouse.dblclick(555, 205);
  await expect(input.locator("h1")).toHaveText("Heading");
  await expect(input.locator("pre code")).toContainText("**literal**");
  await input.press("Escape");
});

test("list Enter, soft breaks, code paste and final ArrowDown follow block semantics", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 300);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially("- first", { delay: 10 });
  await expect(input.locator("ul li")).toHaveCount(1);
  await input.press("Enter");
  await input.pressSequentially("second");
  await expect(input.locator("ul li")).toHaveCount(2);
  await input.press("Shift+Enter");
  await input.pressSequentially("continued");
  await expect(input.locator("ul li")).toHaveCount(2);
  await expect(input.locator("ul li").last()).toHaveText("secondcontinued");
  await input.press("Enter");
  await input.press("Enter");
  await input.pressSequentially("```", { delay: 10 });
  await input.press("Space");
  await expect(input.locator("pre")).toHaveCount(1);
  await page.evaluate(() =>
    navigator.clipboard.writeText("**literal**\n- code"),
  );
  await input.press("ControlOrMeta+V");
  await expect(input.locator("pre")).toContainText("**literal**\n- code");
  await expect(input.locator("pre strong,pre li")).toHaveCount(0);
  await input.press("Enter");
  await input.pressSequentially("last");
  await expect(input.locator("pre")).toContainText("- code\nlast");
  await input.press("ArrowDown");
  await input.pressSequentially("outside");
  await expect(input.locator(":scope > p").last()).toHaveText("outside");
  await expect(input.locator("pre")).not.toContainText("outside");
  await input.press("Escape");
});

for (const alignment of ["left", "center", "right"] as const) {
  test(`bound ${alignment} text keeps its origin, paragraphs and pointer selection at multiple zoom levels`, async ({
    page,
    workspace,
  }) => {
    await page.getByTestId("toolbar-rectangle").first().click();
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(1000, 500);
    await page.mouse.up();
    await page.mouse.dblclick(800, 400);
    const input = page.locator(".excalidraw-wysiwyg");

    await input.pressSequentially("First paragraph");
    await input.press("Enter");
    await input.pressSequentially("Second paragraph");
    await input.press("Escape");
    for (const zoom of [0.75, 1, 1.5]) {
      const point = await page.locator(".excalidraw").evaluate(
        (node, { alignment, zoom }) => {
          const host = node as any;
          let fiber =
            host[
              Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!
            ];

          while (fiber && !fiber.stateNode?.state?.activeTool)
            fiber = fiber.return;
          const app = fiber.stateNode;
          const elements = app.api
            .getSceneElements()
            .map((element: any) =>
              element.type === "text"
                ? { ...element, textAlign: alignment }
                : element,
            );

          app.api.updateScene({
            elements,
            appState: { zoom: { value: zoom }, scrollX: 0, scrollY: 0 },
            captureUpdate: "NEVER",
          });
          const container = elements.find(
            (element: any) => element.type === "rectangle",
          );

          return {
            x:
              (container.x + container.width / 2) * zoom + app.state.offsetLeft,
            y:
              (container.y + container.height / 2) * zoom + app.state.offsetTop,
          };
        },
        { alignment, zoom },
      );

      await page.mouse.dblclick(point.x, point.y);
      await expect(input).toBeVisible();
      const geometry = await input.evaluate((node) => {
        const root = node as HTMLElement;
        const paragraphs = Array.from(root.querySelectorAll("p"));
        const range = document.createRange();

        range.selectNodeContents(paragraphs[0]);
        const first = range.getBoundingClientRect();

        return {
          pointerEvents: getComputedStyle(root).pointerEvents,
          margins: paragraphs.map((p) => [
            getComputedStyle(p).marginTop,
            getComputedStyle(p).marginBottom,
          ]),
          first: {
            x: first.x,
            y: first.y,
            width: first.width,
            height: first.height,
          },
          root: {
            x: root.getBoundingClientRect().x,
            width: root.getBoundingClientRect().width,
          },
        };
      });

      expect(geometry.pointerEvents).toBe("auto");
      expect(geometry.margins).toEqual([
        ["0px", "0px"],
        ["0px", "0px"],
      ]);
      const state = await editorState(page);
      const text = state.elements.find(
        (element: any) => element.type === "text",
      ) as any;
      // The first line occupies the scene text's own box. Using the container width
      // a second time here caused the old center/right horizontal displacement.
      const expectedStart =
        geometry.root.x +
        (alignment === "right"
          ? geometry.root.width - geometry.first.width
          : alignment === "center"
            ? (geometry.root.width - geometry.first.width) / 2
            : 0);

      expect(geometry.first.x).toBeCloseTo(expectedStart, 0);
      expect(geometry.root.width / zoom).toBeCloseTo(text.width, 0);
      await page.mouse.click(
        geometry.first.x + 3 * zoom,
        geometry.first.y + geometry.first.height / 2,
      );
      await expect(input).toBeVisible();
      await expect
        .poll(() =>
          input.evaluate((node) =>
            node.contains(document.getSelection()?.anchorNode ?? null),
          ),
        )
        .toBe(true);
      await page.mouse.move(
        geometry.first.x + 2,
        geometry.first.y + geometry.first.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        geometry.first.x + geometry.first.width - 2,
        geometry.first.y + geometry.first.height / 2,
        { steps: 8 },
      );
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => document.getSelection()?.toString()))
        .not.toBe("");
      await input.press("Escape");
    }
  });
}

// Reading old documents must be lossless; only a document-changing transaction upgrades.
test("v1 is retained on open and close, then upgrades to v2 on actual edit", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially("legacy");
  await input.press("Escape");
  await page.locator(".excalidraw").evaluate((node) => {
    const host = node as any;
    let fiber =
      host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

    while (fiber && !fiber.stateNode?.state?.activeTool) fiber = fiber.return;
    const app = fiber.stateNode;

    app.api.updateScene({
      elements: app.api.getSceneElements().map((element: any) => ({
        ...element,
        richText: {
          version: 1,
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "legacy", marks: [{ type: "bold" }] },
                ],
              },
            ],
          },
        },
      })),
      captureUpdate: "NEVER",
    });
  });
  await page.mouse.dblclick(705, 355);
  await expect(input.locator("strong")).toHaveText("legacy");
  await input.press("Escape");
  expect(((await editorState(page)).elements[0] as any).richText.version).toBe(
    1,
  );
  await page.mouse.dblclick(705, 355);
  await input.press("End");
  await input.pressSequentially(" changed");
  await input.press("Escape");
  expect(((await editorState(page)).elements[0] as any).richText.version).toBe(
    2,
  );
});

test("rotated bound editing shares the scene center with an open library sidebar", async ({
  page,
  workspace,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  workspace.mock.settings.features.disableDefaultSidebar = false;
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(570, 300);
  await page.mouse.down();
  await page.mouse.move(870, 440);
  await page.mouse.up();
  await page.mouse.dblclick(720, 370);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially("Rotated text");
  await input.press("Escape");
  for (const angle of [Math.PI / 6, -Math.PI / 4]) {
    await page.locator(".excalidraw").evaluate((node) => {
      const host = node as any;
      let fiber =
        host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

      while (fiber && !fiber.stateNode?.state?.activeTool) fiber = fiber.return;
      fiber.stateNode.api.updateScene({
        appState: {
          defaultSidebarDockedPreference: true,
          openSidebar: { name: "default", tab: "library" },
        },
        captureUpdate: "NEVER",
      });
    });
    await expect(page.getByTestId("sidebar-close")).toBeVisible();
    const center = await page.locator(".excalidraw").evaluate((node, angle) => {
      const host = node as any;
      let fiber =
        host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

      while (fiber && !fiber.stateNode?.state?.activeTool) fiber = fiber.return;
      const app = fiber.stateNode;
      const elements = app.api
        .getSceneElements()
        .map((element: any) => ({ ...element, angle }));

      app.api.updateScene({ elements, captureUpdate: "NEVER" });
      const text = elements.find((element: any) => element.type === "text");
      const zoom = app.state.zoom.value;

      return {
        x:
          (text.x + text.width / 2 + app.state.scrollX) * zoom +
          app.state.offsetLeft,
        y:
          (text.y + text.height / 2 + app.state.scrollY) * zoom +
          app.state.offsetTop,
      };
    }, angle);

    await page.mouse.dblclick(center.x, center.y);
    await expect(input).toBeVisible();
    await expect(page.getByTestId("sidebar-close")).toBeVisible();
    const bounds = await input.boundingBox();

    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width / 2).toBeCloseTo(center.x, 0);
    expect(bounds!.y + bounds!.height / 2).toBeCloseTo(center.y, 0);
    await input.press("Escape");
  }

  if (!(await page.getByTestId("sidebar-close").isVisible()))
    await page.getByRole("button", { name: "素材库", exact: true }).click();
  await page.getByTestId("sidebar-close").click();
  await expect(page.getByTestId("sidebar-close")).toHaveCount(0);
  await page.mouse.dblclick(720, 370);
  await expect(input).toHaveText("Rotated text");
  await input.press("Escape");
});

for (const containerType of ["arrow", "stickynote"] as const) {
  test(`${containerType} labels retain Markdown, align editor geometry and grow with content`, async ({
    page,
    workspace,
  }) => {
    await expect(page.locator(".excalidraw")).toBeVisible();
    await page.locator(".excalidraw").evaluate((node, type) => {
      const host = node as any;
      let fiber =
        host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

      while (fiber && !fiber.stateNode?.state?.activeTool) fiber = fiber.return;
      fiber.stateNode.api.setActiveTool({ type });
    }, containerType);
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(900, containerType === "arrow" ? 450 : 550, {
      steps: 5,
    });
    await page.mouse.up();
    const input = page.locator(".excalidraw-wysiwyg");

    if (!(await input.count())) {
      await page.mouse.dblclick(750, containerType === "arrow" ? 375 : 425);
    }

    await expect(input).toBeVisible();
    await input.pressSequentially("**Label**");
    await input.press("Enter");
    await input.pressSequentially(
      "中文 wrapping text continues across the label width and onto another line",
    );
    await expect(input.locator("strong")).toHaveText("Label");
    const editing = await editorState(page);
    const text = editing.elements.find(
      (element: any) => element.type === "text",
    ) as any;
    const container = editing.elements.find(
      (element: any) => element.id === text.containerId,
    ) as any;

    expect(container.type).toBe(containerType);
    expect(text.height).toBeGreaterThan(text.fontSize * text.lineHeight);
    const width = await input.evaluate((node) =>
      parseFloat(getComputedStyle(node).width),
    );

    expect(width).toBeCloseTo(text.width, 0);
    await input.press("Escape");
    const point = await page.locator(".excalidraw").evaluate((node) => {
      const host = node as any;
      let fiber =
        host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

      while (fiber && !fiber.stateNode?.state?.activeTool) fiber = fiber.return;
      const app = fiber.stateNode;
      const text = app.api
        .getSceneElements()
        .find((element: any) => element.type === "text");

      return {
        x:
          (text.x + text.width / 2 + app.state.scrollX) * app.state.zoom.value +
          app.state.offsetLeft,
        y:
          (text.y + text.height / 2 + app.state.scrollY) *
            app.state.zoom.value +
          app.state.offsetTop,
      };
    });

    await page.mouse.dblclick(point.x, point.y);
    await expect(input.locator("strong")).toHaveText("Label");
    await expect(input).toContainText("中文 wrapping text");
    await input.press("Escape");
  });
}

for (const markdown of ["- first\n- second", "> quoted\n> content"]) {
  test(`reopening a nested block selects the whole document: ${markdown.split("\n")[0]}`, async ({
    page,
    workspace,
  }) => {
    await page.getByTestId("toolbar-text").first().click();
    await page.mouse.click(700, 350);
    const input = page.locator(".excalidraw-wysiwyg");

    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      markdown,
    );
    await input.press("ControlOrMeta+V");
    await input.press("Escape");
    await page.mouse.dblclick(715, 360);
    await expect(input).toBeVisible();
    await input.pressSequentially("replacement");
    await expect(input).toHaveText("replacement");
    await input.press("Escape");
    const text = (await editorState(page)).elements.find(
      (element: any) => element.type === "text",
    ) as any;

    expect(text.originalText).toBe("replacement");
  });
}

test("bound paragraphs grow and shrink the container during editing, and code Shift+Enter stays in code", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(600, 300);
  await page.mouse.down();
  await page.mouse.move(850, 380);
  await page.mouse.up();
  const baseline = (await editorState(page)).elements.find(
    (element: any) => element.type === "rectangle",
  ) as any;

  await page.mouse.dblclick(725, 340);
  const input = page.locator(".excalidraw-wysiwyg");

  for (let index = 0; index < 8; index++) {
    if (index) await input.press("Enter");
    await input.pressSequentially(`Paragraph ${index + 1}`);
  }

  const expanded = await editorState(page);
  const expandedContainer = expanded.elements.find(
    (element: any) => element.id === baseline.id,
  ) as any;
  const expandedText = expanded.elements.find(
    (element: any) => element.type === "text",
  ) as any;

  expect(expandedContainer.height).toBeGreaterThan(baseline.height);
  expect(expandedContainer.height).toBeGreaterThanOrEqual(expandedText.height);
  const expandedDOMHeight = await input.evaluate(
    (node) => node.getBoundingClientRect().height,
  );

  expect(expandedDOMHeight / expanded.zoom.value).toBeCloseTo(
    expandedText.height,
    0,
  );
  await input.press("ControlOrMeta+A");
  await input.pressSequentially("short");
  await expect
    .poll(async () => {
      const state = await editorState(page);

      return (
        state.elements.find((element: any) => element.id === baseline.id) as any
      ).height;
    })
    .toBeCloseTo(baseline.height, 0);
  const shortened = await editorState(page);
  const shortText = shortened.elements.find(
    (element: any) => element.type === "text",
  ) as any;
  const shortDOMHeight = await input.evaluate(
    (node) => node.getBoundingClientRect().height,
  );

  expect(shortDOMHeight / shortened.zoom.value).toBeCloseTo(
    shortText.height,
    0,
  );
  await input.press("Escape");
  const saved = await editorState(page);

  expect(
    saved.elements.find((element: any) => element.type === "text"),
  ).toMatchObject({ text: "short", height: shortText.height });
  expect(
    saved.elements.find((element: any) => element.id === baseline.id),
  ).toMatchObject({ height: baseline.height });
  await page.mouse.dblclick(725, 340);
  await expect(input).toHaveText("short");
  await input.press("ControlOrMeta+A");
  await page.evaluate(() => navigator.clipboard.writeText("```\nfirst\n```"));
  await input.press("ControlOrMeta+V");
  await expect(input.locator("pre code")).toHaveText("first");
  await input.press("ControlOrMeta+End");
  await input.press("Shift+Enter");
  await input.pressSequentially("second");
  await expect(input.locator("pre code")).toHaveText("first\nsecond");
  await expect(input.locator("pre")).toHaveCount(1);
  await expect(input.locator(":scope > p")).toHaveCount(0);
  await input.press("Escape");
});
