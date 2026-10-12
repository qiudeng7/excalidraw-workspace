import { test, expect, categories } from "./fixtures";

test("save failure is visible in every category and survives reopening until retry", async ({
  workspace: f,
}) => {
  await f.open();
  f.mock.mode = "error";
  await f.setBottomToolbar(false);
  await expect(
    f.dialog.getByText("设置保存失败", { exact: true }),
  ).toBeVisible();
  for (const name of categories) {
    await f.dialog.getByRole("tab", { name, exact: true }).click();
    await expect(
      f.dialog.getByText("设置保存失败", { exact: true }),
    ).toBeVisible();
    await expect(
      f.dialog.getByRole("button", { name: "重试同步", exact: true }),
    ).toBeVisible();
  }

  await f.close();
  await f.open();
  f.mock.mode = "ok";
  await f.dialog.getByRole("button", { name: "重试同步", exact: true }).click();
  await expect(
    f.dialog.getByText("设置更改即时生效", { exact: true }),
  ).toBeVisible();
});

for (const choice of ["采用云端设置", "保存当前设置"]) {
  test(`conflict is visible in every category and recovers with ${choice}`, async ({
    workspace: f,
  }) => {
    await f.open();
    f.mock.mode = "conflict";
    const cloud = f.mock.settings.features.bottomToolbar;

    await f.setBottomToolbar(!cloud);
    await expect(
      f.dialog.getByText("设置与云端有冲突", { exact: true }),
    ).toBeVisible();
    for (const name of categories) {
      await f.dialog.getByRole("tab", { name, exact: true }).click();
      for (const action of ["采用云端设置", "保存当前设置"])
        await expect(
          f.dialog.getByRole("button", { name: action, exact: true }),
        ).toBeVisible();
    }

    await f.dialog.getByRole("tab", { name: "通用", exact: true }).click();
    await f.dialog.getByRole("button", { name: choice, exact: true }).click();
    await expect(
      f.dialog.getByText("设置更改即时生效", { exact: true }),
    ).toBeVisible();
    await f.dialog.getByRole("tab", { name: "编辑器", exact: true }).click();
    await expect(
      f.dialog.getByRole("checkbox", { name: "工具栏置底", exact: true }),
    ).toBeChecked({ checked: choice === "采用云端设置" ? cloud : !cloud });
  });
}

test("unloaded cloud settings remain visible in every category and reload from account", async ({
  page,
  workspace: f,
}) => {
  f.mock.mode = "unavailable";
  await page.reload();
  await f.open();
  for (const name of categories) {
    await f.dialog.getByRole("tab", { name, exact: true }).click();
    await expect(
      f.dialog.getByText("未读取云端设置", { exact: true }),
    ).toBeVisible();
    await expect(
      f.dialog.getByRole("button", { name: "重新读取设置", exact: true }),
    ).toBeVisible();
  }

  await f.dialog.getByRole("tab", { name: "账号", exact: true }).click();
  f.mock.mode = "ok";
  await f.dialog
    .getByRole("button", { name: "重新读取设置", exact: true })
    .click();
  await expect(
    f.dialog.getByText("使用原密码验证身份后修改密码", { exact: true }),
  ).toBeVisible();
});
