import { expect, test } from "@playwright/test";

test.describe("relative path rejected", () => {
  test("create with relative rootPath shows error toast", async ({ page }) => {
    await page.goto("/workspaces");
    await page
      .getByRole("button", { name: /^create( workspace)?$/i })
      .first()
      .click();
    await expect(page.getByTestId("workspace-create-form")).toBeVisible();

    await page.getByTestId("workspace-name-input").fill("Relative Root WS");
    await page.getByTestId("workspace-root-input").fill("relative/not-absolute");
    await page.getByTestId("workspace-max-active-runs-input").fill("1");
    await page.getByTestId("workspace-max-concurrent-attempts-input").fill("1");
    await page.getByTestId("workspace-create-submit").click();

    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: /absolute|rootPath|400/i })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    // Should stay on workspaces page, not navigate away
    await expect(page.getByTestId("workspaces-page")).toBeVisible();
  });
});
