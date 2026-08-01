import { expect, test } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
  expectVisibleBox,
} from "./helpers";

test.describe("Run Workspace", () => {
  test("starts a Run, redirects to its detail workspace, and supports pause/resume", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await createWorkspaceViaUi(page, "E2E Run Workspace");
    await addSourceViaUi(page, createTempGitRepo("run-workspace"));
    await page.getByTestId("workspace-subnav-runs").click();
    await expect(page.getByTestId("run-workspace-index")).toBeVisible();

    await page
      .getByRole("button", { name: /^start run$/i })
      .first()
      .click();
    await expect(page.getByTestId("run-workspace-detail")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/w\/[^/]+\/runs\/[^/]+$/);

    const pause = page.getByRole("button", { name: "Pause Run" });
    await expect(pause).toBeEnabled({ timeout: 20_000 });
    await pause.click();
    await expect(page.getByRole("button", { name: /^resume$/i })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /^resume$/i }).click();
    await expect(page.getByRole("button", { name: "Pause Run" })).toBeVisible({ timeout: 20_000 });
  });

  test("keeps the Run index within the mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    const { name } = await createWorkspaceViaUi(page, "Mobile Run Workspace");
    await expect(page.getByTestId("workbench-shell")).toContainText(name);
    await expect(page.getByTestId("run-workspace-index")).toBeVisible();
    const runs = page.getByTestId("workspace-subnav-runs");
    await expectVisibleBox(runs, { minWidth: 24, minHeight: 20 });
    await expect(runs).toHaveText(/runs/i);
    await expect(page.getByTestId("workspace-subnav-wiki")).toBeVisible();
    await expect(page.getByTestId("workspace-subnav-settings")).toBeVisible();

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
