import { expect, test } from "@playwright/test";

test.describe("workspace shell accessibility", () => {
  test("command menu opens via trigger and navigates", async ({ page }) => {
    await page.goto("/workspaces");
    await page.getByTestId("command-menu-trigger").evaluate((el: HTMLElement) => el.click());
    const menu = page.getByTestId("command-menu");
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });
});
