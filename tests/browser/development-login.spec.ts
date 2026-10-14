import { test, expect } from "@playwright/test";

test.skip(
  process.env.DEVELOPMENT_LIVE_TEST !== "1",
  "Requires the unified local devserver",
);

test("development login prefills both accounts, clears registration, and uses normal authentication", async ({
  page,
}) => {
  const response = await page.request.get("/api/bootstrap");
  const bootstrap = await response.json();

  expect(bootstrap.needsSetup).toBe(false);
  await page.goto("/");
  const email = page.getByRole("textbox", { name: "邮箱" });
  const password = page.locator('input[type="password"]');

  await expect(email).toHaveValue(bootstrap.developmentAccounts[0].email);
  await expect(password).toHaveValue(bootstrap.developmentAccounts[0].password);
  expect(
    (await (await page.request.get("/api/session")).json()).user,
  ).toBeNull();
  await page.getByRole("button", { name: "普通用户", exact: true }).click();
  await expect(email).toHaveValue(bootstrap.developmentAccounts[1].email);
  await expect(password).toHaveValue(bootstrap.developmentAccounts[1].password);
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(email).toHaveValue("");
  await expect(password).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "普通用户", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(email).toHaveValue(bootstrap.developmentAccounts[0].email);
  await expect(password).toHaveValue(bootstrap.developmentAccounts[0].password);
  await page.getByRole("button", { name: "进入我的空间", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/session")).json()).user?.role,
    )
    .toBe("admin");
});
