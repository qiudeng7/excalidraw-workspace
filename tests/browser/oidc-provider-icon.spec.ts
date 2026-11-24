// 验证设置页真实表单可以不选图标创建身份源，之后可点按钮选图、预览并提交。
// 管理 API 使用浏览器内替身，不覆盖后端持久化或 OIDC 登录。
import type { OidcProviderRecord } from "../../shared/oidc";
import { expect, test } from "./fixtures";

test("不选图标可创建自定义身份源，之后可编辑并上传图标", async ({
  page,
  workspace,
}) => {
  let provider: OidcProviderRecord | undefined;
  const uploads: { dataUrl: string }[] = [];
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />');
  const dataUrl = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  const endpoint = "/api/admin/oidc-providers";

  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "POST") {
      provider = { ...route.request().postDataJSON(), iconUrl: null };

      return route.fulfill({ status: 201, json: { provider } });
    }

    return route.fulfill({ json: { providers: provider ? [provider] : [] } });
  });
  await page.route(`**${endpoint}/*`, (route) =>
    route.fulfill({ json: { provider } }),
  );
  await page.route(`**${endpoint}/*/icon`, async (route) => {
    uploads.push(route.request().postDataJSON());
    if (provider) {
      provider.iconUrl = "/oidc/gitlab.svg";
    }

    return route.fulfill({ json: { provider } });
  });

  await workspace.open();
  await workspace.dialog.getByRole("tab", { name: "系统设置" }).click();
  await workspace.dialog.getByRole("button", { name: "新建身份源" }).click();
  const dialog = page.getByRole("dialog", { name: "身份源", exact: true });

  await dialog.getByLabel("类型").selectOption("custom");
  await dialog.getByLabel("显示名称").fill("测试身份源");
  await dialog
    .getByLabel("Issuer", { exact: true })
    .fill("https://id.example.test");
  await dialog.getByLabel("客户端 ID").fill("test-client");
  await dialog.getByLabel("客户端密钥").fill("test-secret");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = workspace.dialog.getByRole("row", { name: /测试身份源/ });

  await expect(row).toBeVisible();
  await expect(row.locator("img")).toHaveCount(0);
  expect(provider).toMatchObject({ type: "custom", iconUrl: null });
  expect(uploads).toEqual([]);

  await row.getByRole("button", { name: "编辑" }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "选择图片" }).click(),
  ]);

  await chooser.setFiles({
    name: "icon.svg",
    mimeType: "image/svg+xml",
    buffer: svg,
  });
  await expect(dialog.locator("img")).toHaveAttribute("src", dataUrl);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.locator("img")).toHaveAttribute("src", "/oidc/gitlab.svg");
  expect(uploads).toEqual([{ dataUrl }]);
});
