import { expect, test } from "@playwright/test";
import { chooseOption, uniqueWorkspaceRoot } from "./helpers";

test.describe("workspace settings", () => {
  test("selects configured model from dropdown and persists", async ({ page }) => {
    // 1. Provider-first: one gateway, two models under it
    await page.goto("/settings");
    await page.getByTestId("provider-add").click();
    await expect(page.getByTestId("provider-editor")).toBeVisible();
    await page.getByTestId("provider-name-input").fill("E2E Settings Gateway");
    await page.getByTestId("provider-base-url").fill("https://settings-gateway.example.com/v1");
    await page.getByTestId("provider-api-key").fill("sk-e2e-settings-not-real");
    await page.getByTestId("provider-save").click();
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: /provider added/i })
        .first(),
    ).toBeVisible();
    await expect(page.getByTestId("provider-card").first()).toBeVisible();

    await page.getByTestId("provider-add-model").first().click();
    await page.getByTestId("model-name-input").fill("Alpha Model");
    await page.getByTestId("model-id-input").fill("openai/alpha-model");
    await page.getByTestId("model-save").click();
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: /model added/i })
        .first(),
    ).toBeVisible();

    await page.getByTestId("provider-add-model").first().click();
    await page.getByTestId("model-name-input").fill("Beta Model");
    await page.getByTestId("model-id-input").fill("openai/beta-model");
    await page.getByTestId("model-save").click();
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: /model added/i })
        .first(),
    ).toBeVisible();

    // 2. Create workspace selecting Beta
    const rootPath = uniqueWorkspaceRoot();
    const originalName = `E2E Settings WS ${Date.now()}`;
    const updatedName = `${originalName} Renamed`;

    await page.goto("/workspaces");
    await page
      .getByRole("button", { name: /^create( workspace)?$/i })
      .first()
      .click();
    await page.getByTestId("workspace-name-input").fill(originalName);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-max-active-runs-input").fill("2");
    await page.getByTestId("workspace-max-concurrent-attempts-input").fill("4");
    await chooseOption(page, "model-profile-select", /Beta Model/);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("run-workspace-index")).toBeVisible({
      timeout: 20_000,
    });

    // 3. Switch to Alpha in workspace settings
    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.getByTestId("settings-name-input").fill(updatedName);
    await chooseOption(page, "settings-model-select", /Alpha Model/);
    await page.getByTestId("settings-save").click();
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: /saved/i }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("configure-page").getByRole("heading", { level: 1 })).toHaveText(
      updatedName,
    );

    await page.reload();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("settings-name-input")).toHaveValue(updatedName);
    await expect(page.getByTestId("settings-model-input")).toHaveValue("openai/alpha-model");

    // Adaptive/reviewer toggles removed (ADR 0028); plan confirm remains.
    await expect(page.getByTestId("settings-adaptive")).toHaveCount(0);
    await expect(page.getByTestId("settings-reviewer")).toHaveCount(0);
    await expect(page.getByTestId("settings-plan-confirm")).toBeVisible();
  });
});
