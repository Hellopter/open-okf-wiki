import { expect, test } from "@playwright/test";
import { createWorkspaceViaUi, expectVisibleBox } from "./helpers";

test.describe("workspace shell accessibility", () => {
  test("command menu opens via trigger and navigates", async ({ page }) => {
    await page.goto("/workspaces");
    await page.getByTestId("command-menu-trigger").evaluate((el: HTMLElement) => el.click());
    const menu = page.getByTestId("command-menu");
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("mobile Run Workspace has an accessible navigation control", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createWorkspaceViaUi(page, "Mobile Run Chrome");
    const runs = page.getByTestId("workspace-subnav-runs");
    await expectVisibleBox(runs, { minWidth: 24, minHeight: 20 });
    await expect(runs).toHaveText(/runs/i);
    await expect(page.getByTestId("workspace-subnav-wiki")).toBeVisible();
    await expect(page.getByTestId("workspace-subnav-settings")).toBeVisible();
  });
});
