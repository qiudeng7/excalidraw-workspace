import { test, expect } from "./fixtures";

for (const accountRole of ["user", "admin"] as const) {
  test.describe(accountRole, () => {
    test.use({ accountRole });
    for (const width of [1280, 320]) {
      test(`${width}px settings names, default category, icons and keyboard navigation`, async ({
        page,
        workspace: f,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await f.open();
        const tab = (name: string) =>
          f.dialog.getByRole("tab", { name, exact: true });
        const labels = [
          "通用",
          "编辑器",
          "账号",
          "更新日志",
          "调试",
          ...(accountRole === "admin" ? ["系统设置"] : []),
        ];

        await expect(f.dialog.getByRole("tab")).toHaveText(labels);
        await expect(tab("通用")).toHaveAttribute("aria-selected", "true");
        await expect(
          f.dialog.getByRole("button", { name: /^外观主题：/ }),
        ).toBeVisible();
        const icons = await f.dialog
          .getByRole("tab")
          .locator("svg path")
          .evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));

        expect(new Set(icons).size).toBe(labels.length);
        await tab("通用").press("End");
        await expect(tab(labels.at(-1)!)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await tab(labels.at(-1)!).press("Home");
        await expect(tab("通用")).toHaveAttribute("aria-selected", "true");
        await tab("通用").press("ArrowDown");
        await expect(tab("编辑器")).toHaveAttribute("aria-selected", "true");
        await expect(
          f.dialog.getByRole("checkbox", { name: "工具栏置底", exact: true }),
        ).toBeChecked();
        await tab("账号").click();
        await expect(
          f.dialog.getByLabel("原密码", { exact: true }),
        ).toBeVisible();
        if (accountRole === "admin") {
          const system = (await tab("系统设置").boundingBox())!;
          const debug = (await tab("调试").boundingBox())!;

          expect(system.y).toBeGreaterThan(debug.y + debug.height + 40);
          await tab("系统设置").click();
          await expect(
            f.dialog.getByRole("checkbox", { name: "开放注册", exact: true }),
          ).toBeVisible();
        }

        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.keyboard.press("Escape");
        await expect(f.dialog).toBeHidden();
      });
    }
  });
}
