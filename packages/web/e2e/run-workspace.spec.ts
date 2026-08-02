import { expect, test } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
  expectVisibleBox,
} from "./helpers";

test.describe("linked Session and Run Workspace", () => {
  test("keeps Session conversation separate from the durable Run surface", async ({ page }) => {
    await createWorkspaceViaUi(page, "E2E Run Workspace");
    await addSourceViaUi(page, createTempGitRepo("run-workspace"));
    await page.getByTestId("workspace-subnav-runs").click();
    await expect(page.getByTestId("workspace-agent-page")).toBeVisible();
    await expect(page.getByTestId("workbench-timeline-sidebar")).toContainText(/Sessions/);
    await expect(page.getByTestId("workbench-timeline-sidebar")).toContainText(/Runs/);
    await expect(page.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: "Active Run" })).toBeDisabled();
  });

  test("keeps the linked workbench within the mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    const { name } = await createWorkspaceViaUi(page, "Mobile Run Workspace");
    await expect(page.getByTestId("workbench-shell")).toContainText(name);
    await expect(page.getByTestId("workspace-agent-page")).toBeVisible();
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
