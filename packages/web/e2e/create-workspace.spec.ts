import { expect, test } from "@playwright/test";
import { uniqueWorkspaceRoot } from "./helpers";

test.describe("create workspace", () => {
  test("creates workspace with explicit capacity and lands on Run Workspace", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const name = `E2E Workspace ${Date.now()}`;

    await page.goto("/workspaces");
    await expect(page.getByTestId("workspaces-page")).toBeVisible();

    // Open create form (header Create or empty-state button)
    const createToggle = page.getByRole("button", { name: /^create( workspace)?$/i }).first();
    await createToggle.click();
    await expect(page.getByTestId("workspace-create-form")).toBeVisible();

    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-max-active-runs-input").fill("2");
    await page.getByTestId("workspace-max-concurrent-attempts-input").fill("4");
    await page.getByTestId("workspace-create-submit").click();

    await expect(page.getByTestId("run-workspace-index")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("workbench-shell")).toContainText(name);
    // Id-only navigation: land on /w/:id/runs (rootPath is form input only, not URL).
    await expect(page).toHaveURL(/\/w\/[^/?]+\/runs/);
    expect(new URL(page.url()).searchParams.get("rootPath")).toBeNull();
    await expect(page.getByTestId("workspace-subnav-runs")).toBeVisible();
  });
});
