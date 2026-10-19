// 验证真实浏览器深色换行渲染、SVG 背景与语义剪贴板往返；工作区 API 为 fixtures 替身，不覆盖真实存储。
import { test, expect, editorState } from "./fixtures";

for (const mode of ["逐字输入", "Markdown 粘贴"]) {
  test(`${mode}中奇数反斜杠转义高亮起始符，偶数反斜杠仍允许高亮`, async ({
    page,
    workspace,
  }) => {
    await page.getByTestId("toolbar-text").first().click();
    await page.mouse.click(700, 350);
    const input = page.locator(".excalidraw-wysiwyg");

    for (const count of [1, 2, 3, 4]) {
      await input.press("ControlOrMeta+A");
      await input.press("ControlOrMeta+\\");
      const source = "\\".repeat(count) + "==重点==";

      if (mode === "逐字输入") {
        await input.pressSequentially(source, { delay: 20 });
      } else {
        await page.evaluate(
          (text) => navigator.clipboard.writeText(text),
          source,
        );
        await input.press("ControlOrMeta+V");
      }

      if (count % 2 === 0) {
        await expect(input.locator("mark")).toHaveText("重点");
      } else {
        await expect(input.locator("mark")).toHaveCount(0);
      }

      const slashes = "\\".repeat(
        mode === "逐字输入" ? count : Math.floor(count / 2),
      );

      await expect(input).toHaveText(
        slashes + (count % 2 === 0 ? "重点" : "==重点=="),
      );
    }
  });
}

test("深色绑定文本的嵌套高亮跨行显示，SVG 每行都有背景", async ({
  page,
  workspace,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("toolbar-rectangle").first().click();
  await page.mouse.move(650, 300);
  await page.mouse.down();
  await page.mouse.move(850, 480);
  await page.mouse.up();
  await page.mouse.dblclick(750, 390);
  const input = page.locator(".excalidraw-wysiwyg");

  await page.evaluate(() =>
    navigator.clipboard.writeText(
      "==高亮开始 **加粗重点** 后续文字需要自动换行，继续显示每一行高亮背景，直到这段文字结束。==",
    ),
  );
  await input.press("ControlOrMeta+V");
  await expect(input.locator("strong")).toHaveText("加粗重点");
  const appearance = await input.evaluate((node) => {
    const marks = [...node.querySelectorAll("mark")];
    const tops = new Set<number>();

    for (const mark of marks) {
      const range = document.createRange();

      range.selectNodeContents(mark);
      for (const rect of range.getClientRects()) {
        tops.add(Math.round(rect.top));
      }
    }

    return {
      lines: tops.size,
      backgrounds: marks.map((mark) => getComputedStyle(mark).backgroundColor),
      inheritsText: marks.every(
        (mark) =>
          getComputedStyle(mark).color ===
          getComputedStyle(mark.parentElement!).color,
      ),
    };
  });

  expect(appearance.lines).toBeGreaterThan(1);
  expect(appearance.backgrounds.length).toBeGreaterThan(0);
  expect(
    appearance.backgrounds.every(
      (color) => color !== "transparent" && color !== "rgba(0, 0, 0, 0)",
    ),
  ).toBe(true);
  expect(appearance.inheritsText).toBe(true);
  await input.press("Escape");
  const exported = await page.locator(".excalidraw").evaluate(async (node) => {
    const host = node as any;
    let fiber =
      host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))!];

    while (fiber && !fiber.stateNode?.state?.activeTool) {
      fiber = fiber.return;
    }

    const app = fiber.stateNode;

    await app.actionManager.actions.copyAsSvg.perform(
      app.api.getSceneElements(),
      { ...app.state, exportWithDarkMode: true },
      null,
      app,
    );
    const svg = await navigator.clipboard.readText();
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const backgrounds = [...document.querySelectorAll("rect")].filter(
      (rect) =>
        Number(rect.getAttribute("width")) > 0 &&
        Number(rect.getAttribute("height")) > 0 &&
        ![null, "none", "#ffffff", "white", "transparent"].includes(
          rect.getAttribute("fill"),
        ),
    );

    return {
      svg,
      backgrounds: backgrounds.length,
      rows: new Set(backgrounds.map((rect) => rect.getAttribute("y"))).size,
    };
  });

  expect(exported.backgrounds).toBeGreaterThan(1);
  expect(exported.rows).toBeGreaterThan(1);
  expect(exported.svg).toContain('font-weight="700"');
  expect(exported.svg).not.toContain("foreignObject");
});

test("字符选区复制生成语义 mark，粘贴保留局部高亮和粗体", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await page.evaluate(() =>
    navigator.clipboard.writeText("普通 ==重点 **加粗**== 结尾"),
  );
  await input.press("ControlOrMeta+V");
  await input.press("ControlOrMeta+A");
  await input.press("ControlOrMeta+C");
  const clipboard = await page.evaluate(async () => {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("text/html")) {
        return (await item.getType("text/html")).text();
      }
    }

    return "";
  });

  expect(clipboard).toContain("<mark");
  expect(clipboard).toContain("<strong");
  await input.press("Backspace");
  await expect(input.locator("mark")).toHaveCount(0);
  await input.press("ControlOrMeta+V");
  await expect(input).toHaveText("普通 重点 加粗 结尾");
  await expect
    .poll(async () => (await input.locator("mark").allTextContents()).join(""))
    .toBe("重点 加粗");
  await expect(input.locator("strong")).toHaveText("加粗");
  await input.press("Escape");
  const text = (await editorState(page)).elements.find(
    (element: any) => element.type === "text",
  ) as any;
  const runs = text.richText.doc.content[0].content;

  expect(
    runs
      .find((run: any) => run.text === "加粗")
      .marks.map((mark: any) => mark.type)
      .sort(),
  ).toEqual(["bold", "highlight"]);
  expect(runs.find((run: any) => run.text === "普通 ").marks ?? []).toEqual([]);
  expect(runs.find((run: any) => run.text === " 结尾").marks ?? []).toEqual([]);
});
