import { test, expect, editorState } from "./fixtures";

test("代码块按围栏语言着色，编辑态与 SVG 导出一致", async ({
  page,
  workspace,
}) => {
  await expect(page.locator(".excalidraw")).toBeVisible();
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await expect(input).toBeVisible();
  await input.pressSequentially("```ts ", { delay: 15 });
  await input.pressSequentially("const answer: number = 42; // 说明", {
    delay: 5,
  });
  await expect(input.locator("code")).toContainText("const");

  // 编辑态的颜色来自纯装饰，文档里仍是纯文本代码块。语法块按需下载，颜色随后到达。
  const editorColors = () =>
    input.evaluate((root) =>
      [
        ...new Set(
          [...root.querySelectorAll("span[style]")].map(
            (span) => getComputedStyle(span).color,
          ),
        ),
      ].sort(),
    );

  await expect
    .poll(async () => (await editorColors()).length)
    .toBeGreaterThanOrEqual(3);
  const colors = await editorColors();

  await input.press("Escape");
  await expect(input).toHaveCount(0);

  const text = (await editorState(page)).elements.find(
    (element: any) => element.type === "text",
  ) as any;

  expect(text.richText.doc.content[0].type).toBe("codeBlock");
  expect(text.richText.doc.content[0].attrs.params).toBe("ts");
  expect(text.originalText).toBe("const answer: number = 42; // 说明");

  const svg = await page.locator(".excalidraw").evaluate(async (node) => {
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

    return navigator.clipboard.readText();
  });
  const fills = new Set(
    [...svg.matchAll(/<text[^>]*fill="([^"]+)"/g)].map((match) => match[1]),
  );

  expect(fills.size).toBeGreaterThanOrEqual(4);
  const hex = (rgb: string) =>
    `#${(rgb.match(/\d+/g) ?? [])
      .slice(0, 3)
      .map((value) => Number(value).toString(16).padStart(2, "0"))
      .join("")}`;

  for (const color of colors) expect(svg.toLowerCase()).toContain(hex(color));
});
