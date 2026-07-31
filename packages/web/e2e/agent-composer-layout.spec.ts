/**
 * Layout regression: opening the wide-desktop Run Cockpit must keep the
 * chat composer pinned to the bottom of the conversation column.
 *
 * Root cause (fixed): react-resizable-panels v4 inner wrappers use
 * overflow:auto and are not flex columns, so flex-1 content collapsed to
 * intrinsic height and the composer sat under the transcript.
 */
import { expect, test } from "@playwright/test";
import { createWorkspaceViaUi } from "./helpers";

test.describe("agent composer layout with run cockpit", () => {
  test("composer stays bottom-pinned when wide desktop cockpit opens", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await createWorkspaceViaUi(page, "E2E Composer Layout");

    const shell = page.getByTestId("agent-workspace-shell");
    const composer = page.getByTestId("agent-composer");
    const dock = page.getByTestId("agent-action-dock");
    await expect(shell).toBeVisible();
    await expect(composer).toBeVisible();

    const closed = await page.evaluate(() => {
      const shellEl = document.querySelector('[data-testid="agent-workspace-shell"]');
      const dockEl = document.querySelector('[data-testid="agent-action-dock"]');
      if (!shellEl || !dockEl) return null;
      const shellBox = shellEl.getBoundingClientRect();
      const dockBox = dockEl.getBoundingClientRect();
      return {
        shellBottom: shellBox.bottom,
        dockBottom: dockBox.bottom,
        gap: shellBox.bottom - dockBox.bottom,
      };
    });
    expect(closed).not.toBeNull();
    expect(closed!.gap).toBeGreaterThanOrEqual(0);
    expect(closed!.gap).toBeLessThan(8);

    // Force split layout: ?run + ?attempt opens cockpit on wide desktop.
    const url = new URL(page.url());
    url.searchParams.set("run", "layout-regression-run");
    url.searchParams.set("attempt", "1");
    await page.goto(url.pathname + "?" + url.searchParams.toString());

    await expect(shell).toBeVisible();
    await expect(page.getByTestId("active-run-details")).toBeVisible({ timeout: 15_000 });
    await expect(composer).toBeVisible();
    await expect(dock).toBeVisible();

    // Wide desktop keeps the inspector inline, rather than mounting a Sheet/Drawer.
    // The panel primitive's DOM data attributes are implementation details.
    await expect(page.getByTestId("run-cockpit-sheet")).toHaveCount(0);
    await expect(page.getByTestId("run-cockpit-drawer")).toHaveCount(0);

    const open = await page.evaluate(() => {
      const shellEl = document.querySelector('[data-testid="agent-workspace-shell"]');
      const dockEl = document.querySelector('[data-testid="agent-action-dock"]');
      if (!shellEl || !dockEl) return null;
      const shellBox = shellEl.getBoundingClientRect();
      const dockBox = dockEl.getBoundingClientRect();
      return {
        shellBottom: shellBox.bottom,
        dockBottom: dockBox.bottom,
        gap: shellBox.bottom - dockBox.bottom,
        dockTop: dockBox.top,
        shellTop: shellBox.top,
        shellHeight: shellBox.height,
      };
    });
    expect(open).not.toBeNull();
    // Composer/action dock must remain flush with the shell bottom — not mid-column.
    expect(open!.gap, `dock floated up; gap=${open!.gap}`).toBeGreaterThanOrEqual(0);
    expect(open!.gap, `dock floated up; gap=${open!.gap}`).toBeLessThan(8);
    // Sanity: dock lives in the lower half of the shell (not content-height collapse).
    expect(open!.dockTop).toBeGreaterThan(open!.shellTop + open!.shellHeight * 0.5);
  });
});
