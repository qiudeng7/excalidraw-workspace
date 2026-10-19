// 验证真实 Chromium 编辑器的输入、粘贴、重新进入和导出；工作区 API 使用 fixtures 替身，不覆盖真实服务端存储。
import { test, expect, editorState } from "./fixtures";
import type { Locator } from "@playwright/test";

const placeCaretAtStart = async (input: Locator, offset = 0) => {
  // 使用真实键盘让编辑器同步 selection；初始化/重排覆盖光标时重做定位，不重试业务输入。
  await expect(async () => {
    await input.press("Control+Home");
    for (let index = 0; index < offset; index++) {
      await input.press("ArrowRight");
    }

    const position = await input.evaluate(async (node) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const selection = window.getSelection();

      if (!selection?.anchorNode || !selection.isCollapsed) {
        return -1;
      }

      const prefix = document.createRange();

      prefix.selectNodeContents(node);
      prefix.setEnd(selection.anchorNode, selection.anchorOffset);

      return prefix.toString().length;
    });

    expect(position).toBe(offset);
  }).toPass({ timeout: 8000 });
};

for (const mode of ["逐字输入", "Markdown 粘贴"]) {
  test(`${mode}允许高亮内容包含单个等号，但转义结束分隔符不触发高亮`, async ({
    page,
    workspace,
  }) => {
    await page.getByTestId("toolbar-text").first().click();
    await page.mouse.click(700, 350);
    const input = page.locator(".excalidraw-wysiwyg");
    const enter = async (source: string) => {
      if (mode === "逐字输入") {
        await input.pressSequentially(source, { delay: 20 });
      } else {
        await page.evaluate(
          (text) => navigator.clipboard.writeText(text),
          source,
        );
        await input.press("ControlOrMeta+V");
      }
    };

    await enter("==a=b==");
    await expect(input.locator("mark")).toHaveText("a=b");
    await expect(input).toHaveText("a=b");
    await input.press("ControlOrMeta+A");
    await input.press("ControlOrMeta+\\");
    await enter("==重点\\==");
    await expect(input.locator("mark")).toHaveCount(0);
    // 粘贴会解析 Markdown 转义，逐字输入未触发格式规则时保留原始反斜杠。
    await expect(input).toHaveText(
      mode === "逐字输入" ? "==重点\\==" : "==重点==",
    );
  });
}

test("行内代码中逐字输入高亮分隔符保持字面文本", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially("`前后`", { delay: 20 });
  await expect(input.locator("code")).toHaveText("前后");
  await placeCaretAtStart(input, 1);
  await input.pressSequentially("==重点==", { delay: 20 });
  await expect(input.locator("code")).toHaveText("前==重点==后");
  await expect(input.locator("mark")).toHaveCount(0);
  await input.press("Escape");
  const text = (await editorState(page)).elements.find(
    (element: any) => element.type === "text",
  ) as any;

  expect(text.originalText).toBe("前==重点==后");
  expect(text.richText.doc.content[0].content).toEqual([
    { type: "text", text: "前==重点==后", marks: [{ type: "code" }] },
  ]);
});

test("输入局部高亮后重进与刷新保留格式，SVG 和 PNG 绘制背景且清除格式可移除高亮", async ({
  page,
  workspace,
}) => {
  await expect(page.locator(".excalidraw")).toBeVisible();
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially("plain ==重点== tail", { delay: 25 });
  await expect(input.locator("mark")).toHaveText("重点");
  await expect(input).toHaveText("plain 重点 tail");
  await input.press("Escape");
  const original = (await editorState(page)).elements.find(
    (element: any) => element.type === "text",
  ) as any;

  expect(original.originalText).toBe("plain 重点 tail");
  expect(original.richText.doc.content[0].content).toEqual([
    { type: "text", text: "plain " },
    { type: "text", text: "重点", marks: [{ type: "highlight" }] },
    { type: "text", text: " tail" },
  ]);
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
      app.state,
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
    ).length;

    await app.actionManager.actions.copyAsPng.perform(
      app.api.getSceneElements(),
      app.state,
      null,
      app,
    );
    const [item] = await navigator.clipboard.read();
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;

    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let coloredPixels = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (
        data[i + 3] > 128 &&
        Math.max(data[i], data[i + 1], data[i + 2]) -
          Math.min(data[i], data[i + 1], data[i + 2]) >
          35
      ) {
        coloredPixels++;
      }
    }

    bitmap.close();

    return { svg, backgrounds, coloredPixels };
  });

  expect(exported.svg).not.toContain("foreignObject");
  expect(exported.backgrounds).toBeGreaterThan(0);
  expect(exported.coloredPixels).toBeGreaterThan(20);
  await page.mouse.dblclick(705, 355);
  await expect(input.locator("mark")).toHaveText("重点");
  await input.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const response = await fetch("/api/canvases/test-canvas");
        const saved = await response.json();

        return saved.canvas.scene.elements.find(
          (element: any) => element.id === id,
        )?.richText;
      }, original.id),
    )
    .toEqual(original.richText);
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect
    .poll(async () =>
      (await editorState(page)).elements.find(
        (element: any) => element.id === original.id,
      ),
    )
    .toMatchObject({ richText: original.richText });
  await page.mouse.dblclick(705, 355);
  await expect(input.locator("mark")).toHaveText("重点");
  await input.press("ControlOrMeta+A");
  await input.press("ControlOrMeta+\\");
  await expect(input.locator("mark")).toHaveCount(0);
  await expect(input).toHaveText("plain 重点 tail");
  await input.press("Escape");
  const cleared = (await editorState(page)).elements.find(
    (element: any) => element.id === original.id,
  ) as any;

  expect(
    cleared.richText.doc.content[0].content.some(
      (node: any) => node.marks?.length,
    ),
  ).toBe(false);
});

test("粘贴 Markdown 高亮可与加粗共存，纯文本粘贴及代码保持等号原样", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await page.evaluate(() =>
    navigator.clipboard.writeText("==重点 **粗体**== `==代码==`"),
  );
  await input.press("ControlOrMeta+V");
  await expect
    .poll(async () => (await input.locator("mark").allTextContents()).join(""))
    .toBe("重点 粗体");
  await expect(input.locator("strong")).toHaveText("粗体");
  await expect(input.locator("code")).toHaveText("==代码==");
  await input.press("Escape");
  const pasted = (await editorState(page)).elements.find(
    (element: any) => element.type === "text",
  ) as any;
  const bold = pasted.richText.doc.content[0].content.find(
    (node: any) => node.text === "粗体",
  );

  expect(bold.marks.map((mark: any) => mark.type).sort()).toEqual([
    "bold",
    "highlight",
  ]);
  await page.mouse.dblclick(705, 355);
  await input.press("ControlOrMeta+A");
  await page.evaluate(() => navigator.clipboard.writeText("==原样=="));
  await input.press("ControlOrMeta+Shift+V");
  await expect(input).toHaveText("==原样==");
  await expect(input.locator("mark")).toHaveCount(0);
  await input.press("ControlOrMeta+A");
  await input.pressSequentially("==撤销==", { delay: 20 });
  await expect(input.locator("mark")).toHaveText("撤销");
  await input.press("Backspace");
  await expect(input).toHaveText("==撤销==");
  await expect(input.locator("mark")).toHaveCount(0);
});

test("补全行首列表标记保留粗体和高亮，撤销转换恢复原标记且再次转换后光标不跳尾", async ({
  page,
  workspace,
}) => {
  await page.getByTestId("toolbar-text").first().click();
  await page.mouse.click(700, 350);
  const input = page.locator(".excalidraw-wysiwyg");

  await input.pressSequentially(" **粗体** ==重点==", { delay: 20 });
  await expect(input.locator("strong")).toHaveText("粗体");
  await expect(input.locator("mark")).toHaveText("重点");
  await placeCaretAtStart(input);
  await input.pressSequentially("-");
  await expect(input.locator("ul li")).toHaveText("粗体 重点");
  await expect(input.locator("li strong")).toHaveText("粗体");
  await expect(input.locator("li mark")).toHaveText("重点");
  await input.press("Backspace");
  await expect(input.locator("ul")).toHaveCount(0);
  await expect(input).toHaveText("- 粗体 重点");
  await expect(input.locator("strong")).toHaveText("粗体");
  await expect(input.locator("mark")).toHaveText("重点");
  // 不约束原生撤销的光标位置；显式移到 '-' 后，删除该字符再输入。
  await placeCaretAtStart(input, 1);
  await input.press("Backspace");
  await expect(input).toHaveText(" 粗体 重点");
  await input.pressSequentially("-");
  await expect(input.locator("ul li")).toHaveText("粗体 重点");
  await input.pressSequentially("新增");
  await expect(input.locator("ul li")).toHaveText("新增粗体 重点");
  await expect(input.locator("li strong")).toContainText("粗体");
  await expect(input.locator("li mark")).toHaveText("重点");
  await input.press("Escape");
  const text = (await editorState(page)).elements.find(
    (element: any) => element.type === "text",
  ) as any;
  const runs = text.richText.doc.content[0].content[0].content[0].content;

  expect(
    runs.some(
      (run: any) =>
        run.text.includes("粗体") &&
        run.marks?.some((mark: any) => mark.type === "bold"),
    ),
  ).toBe(true);
  expect(
    runs.some(
      (run: any) =>
        run.text === "重点" &&
        run.marks?.some((mark: any) => mark.type === "highlight"),
    ),
  ).toBe(true);
});

for (const context of ["代码块", "已有列表"]) {
  test(`${context}内补齐减号和已有空格保持原结构，不意外生成列表或嵌套列表`, async ({
    page,
    workspace,
  }) => {
    await page.getByTestId("toolbar-text").first().click();
    await page.mouse.click(700, 350);
    const input = page.locator(".excalidraw-wysiwyg");

    if (context === "代码块") {
      await input.pressSequentially("```");
      await input.press("Enter");
    } else {
      await input.pressSequentially("- ");
    }

    await input.pressSequentially(" 已有内容");
    await placeCaretAtStart(input);
    await input.pressSequentially("-");
    if (context === "代码块") {
      await expect(input.locator("pre code")).toHaveText("- 已有内容");
      await expect(input.locator("ul")).toHaveCount(0);
    } else {
      await expect(input.locator("ul")).toHaveCount(1);
      await expect(input.locator("li")).toHaveCount(1);
      await expect(input.locator("li")).toHaveText("- 已有内容");
      await expect(input.locator("li ul")).toHaveCount(0);
    }
  });
}

for (const initial of ["已有内容", " 已有内容"]) {
  test(`已有文字 ${JSON.stringify(initial)} 在行首补齐标记后成为列表且保留光标`, async ({
    page,
    workspace,
  }) => {
    await expect(page.locator(".excalidraw")).toBeVisible();
    await page.getByTestId("toolbar-text").first().click();
    await page.mouse.click(700, 350);
    const input = page.locator(".excalidraw-wysiwyg");

    await input.pressSequentially(initial);
    await placeCaretAtStart(input);
    await input.pressSequentially(initial.startsWith(" ") ? "-" : "- ");
    await expect(input.locator("ul li")).toHaveText("已有内容");
    await input.pressSequentially("新增");
    await expect(input.locator("ul li")).toHaveText("新增已有内容");
    await input.press("Escape");
    const text = (await editorState(page)).elements.find(
      (element: any) => element.type === "text",
    ) as any;

    expect(text.originalText).toBe("新增已有内容");
    expect(text.richText.doc.content[0].type).toBe("bulletList");
  });
}
