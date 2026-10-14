import { test, expect } from "./fixtures";

for (const accountRole of ["user", "admin"] as const) {
  test.describe(accountRole, () => {
    test.use({ accountRole });
    test("settings opens complete readable notices without leaving the canvas", async ({
      page,
      workspace,
    }) => {
      await workspace.open();
      const row = workspace.dialog
        .locator(".settings-row")
        .filter({ hasText: "开源许可" });
      const popupPromise = page.waitForEvent("popup");

      await row.getByRole("link", { name: "查看声明" }).click();
      const popup = await popupPromise;

      await expect(
        popup.getByRole("heading", { name: "开源许可", exact: true }),
      ).toBeVisible();
      await expect(workspace.dialog).toBeVisible();
      await expect(
        popup
          .locator("pre")
          .filter({ hasText: "Copyright (c) 2020 Excalidraw" }),
      ).toBeVisible();
      const response = await popup.request.get("/licenses.txt");

      expect(response.ok()).toBe(true);
      expect(await response.text()).toContain(
        "Permission is hereby granted, free of charge",
      );
      await popup.close();
    });
  });
}
