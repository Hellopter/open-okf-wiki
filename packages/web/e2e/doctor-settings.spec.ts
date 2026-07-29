import { expect, test } from "@playwright/test";
import { setChecked } from "./helpers";

test.describe("doctor / global settings", () => {
  test("shows models panel, doctor, and health ok after check", async ({ page }) => {
    await page.goto("/settings");

    await expect(page.getByTestId("global-settings-page")).toBeVisible();
    await expect(page.getByTestId("provider-panel")).toBeVisible();
    await expect(page.getByTestId("provider-add")).toBeVisible();

    await page.getByTestId("settings-tab-diagnostics").click();
    await expect(page.getByTestId("doctor-panel")).toBeVisible();
    await expect(page.getByTestId("doctor-status")).toHaveText("ok");

    await expect(page.getByTestId("health-panel")).toBeVisible();
    await page.getByRole("button", { name: /run health check/i }).click();
    await expect(page.getByTestId("health-status")).toHaveText(/^ok · /);
  });

  test("adds a model profile and persists after reload", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("provider-panel")).toBeVisible();

    // Provider-first: create the gateway once, then the model under it.
    await page.getByTestId("provider-add").click();
    await expect(page.getByTestId("provider-editor")).toBeVisible();
    await page.getByTestId("provider-name-input").fill("E2E Gateway");
    await page.getByTestId("provider-base-url").fill("https://e2e-gateway.example.com/v1");
    await setChecked(page, "provider-shape-responses", true);
    await page.getByTestId("provider-api-key").fill("sk-e2e-test-key-not-real");
    await page.getByTestId("provider-save").click();
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: /provider added/i })
        .first(),
    ).toBeVisible();
    // Provider-first: zero-model gateways must still show (not models-empty).
    await expect(page.getByTestId("provider-card").filter({ hasText: "E2E Gateway" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("provider-models-empty").first()).toBeVisible();

    const name = `E2E Model ${Date.now()}`;
    await page.getByTestId("provider-add-model").first().click();
    await expect(page.getByTestId("model-editor")).toBeVisible();
    await page.getByTestId("model-name-input").fill(name);
    await page.getByTestId("model-id-input").fill("openai/e2e-probe-model");
    await page.getByTestId("model-save").click();

    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: /model added/i })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    // Models render under providers-list / model-row (flat models-table is fallback only).
    const modelRow = page.getByTestId("model-row").filter({ hasText: name });
    await expect(modelRow).toBeVisible({ timeout: 10_000 });
    await expect(modelRow).toContainText("openai/e2e-probe-model");

    await page.reload();
    await expect(page.getByTestId("model-row").filter({ hasText: name })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("provider-panel")).toContainText(/responses/i);
  });
});
