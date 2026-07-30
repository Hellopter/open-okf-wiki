/**
 * Agent Workspace operator surface (ADR 0030 / 0031 WP6).
 *
 * Route + shell, session chrome, and the sole Pi prompt surface.
 * Empty streaming uses waiting-for-events (never Thinking alone).
 *
 * E2E webServer always sets OKF_WIKI_AGENT_MODE=fixture (see playwright.config.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { addSourceViaUi, createTempGitRepo, createWorkspaceViaUi, setChecked } from "./helpers";

/** Assert empty streaming / waiting chrome is not mislabeled as model "Thinking". */
async function expectWaitingNotThinking(page: Page): Promise<void> {
  const waiting = page.getByTestId("waiting-for-events");
  if ((await waiting.count()) === 0) return;
  await expect(waiting.first()).toBeVisible();
  await expect(waiting.first()).toContainText(/Waiting for events|等待事件/i);
  await expect(waiting.first()).not.toContainText(/Thinking|思考中/);
}

test.describe("agent workspace operator surface (ADR 0035 WikiRuns)", () => {
  test("route + shell render after workspace create", async ({ page }) => {
    const { name } = await createWorkspaceViaUi(page, "E2E Agent Shell");

    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-shell")).toBeVisible();
    await expect(page.getByTestId("agent-session-list")).toBeVisible();
    await expect(page.getByTestId("agent-composer")).toBeVisible();
    await expect(page.getByTestId("agent-start-wiki-run")).toHaveCount(0);
    await expect(page.getByTestId("agent-composer-mode")).toHaveCount(0);
    // Hard-cut: no right context pane / collapse rail on the operator surface.
    await expect(page.getByTestId("agent-context-panels")).toHaveCount(0);
    await expect(page.getByTestId("agent-right-collapse")).toHaveCount(0);
    await expect(page.getByTestId("agent-right-rail")).toHaveCount(0);
    await expect(page.getByTestId("agent-workspace-page")).toContainText(name);

    // Boot auto-creates a session when none exist.
    await expect(page.getByTestId("agent-session-item").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/w\/[^/?]+/);
    await expect(page.getByTestId("workspace-subnav-run")).toHaveCount(0);
  });

  test("legacy independent Run route is not an operator surface", async ({ page }) => {
    await createWorkspaceViaUi(page, "E2E Agent Only");
    const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
    expect(id).toBeTruthy();

    await page.goto(`/workspaces/${encodeURIComponent(id!)}/run`);

    await expect(page.getByTestId("workspace-run-page")).toHaveCount(0);
    await expect(page).toHaveURL(/\/workspaces$/);
  });

  test("can create and select an agent session", async ({ page }) => {
    await createWorkspaceViaUi(page, "E2E Agent Session");

    await expect(page.getByTestId("agent-session-list")).toBeVisible();
    const initial = page.getByTestId("agent-session-item");
    await expect(initial.first()).toBeVisible({ timeout: 15_000 });
    const before = await initial.count();

    await page.getByTestId("agent-session-new").click();
    await expect(page.getByTestId("agent-session-item")).toHaveCount(before + 1, {
      timeout: 15_000,
    });

    const active = page.locator('[data-testid="agent-session-item"][data-active="true"]');
    await expect(active).toHaveCount(1);

    const inactive = page.locator('[data-testid="agent-session-item"][data-active="false"]');
    if ((await inactive.count()) > 0) {
      await inactive.first().click();
      await expect(
        page.locator('[data-testid="agent-session-item"][data-active="true"]'),
      ).toHaveCount(1);
    }
  });

  test("prompt drives the genuine wiki_produce gates and publishes the Wiki", async ({ page }) => {
    test.setTimeout(120_000);
    const { name } = await createWorkspaceViaUi(page, "E2E Agent Produce");
    const source = createTempGitRepo("agent-produce");

    await addSourceViaUi(page, source, "appsrc");
    // Plan confirm lives under Configure → General (default section).
    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("configure-page")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("settings-tab-general").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await setChecked(page, "settings-plan-confirm", true);
    await page.getByTestId("settings-save").click();
    // Sonner success toast (role may vary); checkbox staying checked proves patch applied.
    await expect(page.getByTestId("settings-plan-confirm")).toBeChecked({ timeout: 15_000 });

    await page.getByTestId("workspace-subnav-agent").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-session-item")).toHaveCount(1);

    const composerInput = page.getByTestId("agent-composer-input");
    const send = page.getByTestId("agent-send");
    const prompt = "Inspect the sources and produce the wiki.";
    await expect(composerInput).toBeEnabled({ timeout: 15_000 });
    await composerInput.fill(prompt);
    await expect(composerInput).toHaveValue(prompt);
    await expect(send).toBeEnabled();
    await send.click();

    const userMessage = page.locator('[data-testid="agent-message"][data-role="user"]');
    await expect(userMessage.last()).toContainText("Inspect the sources", { timeout: 15_000 });
    await expect(page.locator("[data-product-kind]")).toHaveCount(0);
    await expect(page.getByTestId("agent-start-wiki-run")).toHaveCount(0);

    // ADR 0035: tool details are StartRun receipt only (accepted|failed|cancelled).
    // Live phase/gates come from WikiRuns projection (Active Run bar owns HITL).
    const produceCard = page.locator(
      '[data-testid="tool-execution-card"][data-tool-name="wiki_produce"]',
    );
    const ensureProducePanelOpen = async (): Promise<void> => {
      await expect(produceCard).toBeVisible({ timeout: 30_000 });
      const detailsNow = page.getByTestId("wiki-produce-details");
      if (!(await detailsNow.isVisible().catch(() => false))) {
        await produceCard.locator('[data-slot="collapsible-trigger"], button').first().click();
      }
      await expect(page.getByTestId("wiki-produce-details")).toBeVisible({ timeout: 15_000 });
    };

    await ensureProducePanelOpen();
    const details = page.getByTestId("wiki-produce-details");
    await expect(details).toHaveAttribute("data-wiki-status", "accepted", {
      timeout: 45_000,
    });
    await expect(details).toHaveAttribute("data-wiki-run-id", /.+/);
    // Receipt card is read-only — no gate chrome on the produce card.
    await expect(details.getByTestId("agent-gate-approve")).toHaveCount(0);

    // Active Run bar is the sole HITL surface (agent-gate-approve lives there).
    const runBar = page.getByTestId("active-run-bar");
    await expect(runBar).toBeVisible({ timeout: 30_000 });
    const toolbar = page.getByTestId("workspace-toolbar");
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(toolbar.getByTestId("active-run-toggle-graph")).toBeVisible();
    await toolbar.getByTestId("active-run-toggle-graph").click();
    const cockpitSheet = page.getByTestId("run-cockpit-sheet");
    await expect(cockpitSheet).toBeVisible();
    await cockpitSheet.getByTestId("run-inspector-close").click();
    await expect(cockpitSheet).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });

    await expect(runBar.getByTestId("agent-plan-gate")).toBeVisible({ timeout: 90_000 });
    await expect(runBar).toContainText("Awaiting your action");
    await expect(runBar).not.toContainText("waiting_for_operator");
    const runReceipt = page.getByTestId("wiki-produce-details");
    await expect(runReceipt).toContainText("Awaiting your action");
    await expect(runReceipt).not.toContainText("waiting_for_operator");
    await expect(produceCard).toContainText("Produce wiki");
    await expect(produceCard).not.toContainText("wiki_produce");
    await expect(toolbar.getByTestId("active-run-switcher")).toBeVisible();
    await expect(toolbar.getByTestId("active-run-toggle-graph")).toBeVisible();
    await expect(runBar.getByTestId("active-run-switcher")).toHaveCount(0);
    await expect(runBar.getByTestId("active-run-toggle-graph")).toHaveCount(0);
    await expect(details).toHaveAttribute("data-wiki-run-state", "waiting_for_operator", {
      timeout: 15_000,
    });

    // Sealed Spec lives in the read-only Run Cockpit (expand graph → plan tab).
    const toggleGraph = page.getByTestId("active-run-toggle-graph");
    if ((await page.getByTestId("active-run-details").count()) === 0) {
      await toggleGraph.click();
    }
    await expect(page.getByTestId("active-run-details")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("run-inspector-tab-plan").click();
    await expect(page.getByTestId("spec-review")).toBeVisible({ timeout: 30_000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("run-inspector-close").click();
    await expect(page.getByTestId("active-run-details")).toHaveCount(0);

    // GateAction is never duplicated: desktop keeps it in the Action Dock,
    // tablet moves it to a Sheet, and mobile moves it to a Drawer.
    await page.setViewportSize({ width: 1024, height: 768 });
    await toolbar.getByTestId("active-run-toggle-graph").click();
    await expect(cockpitSheet).toBeVisible();
    await cockpitSheet.getByTestId("run-inspector-close").click();
    await expect(cockpitSheet).toHaveCount(0);
    await expect(runBar.getByTestId("agent-plan-gate")).toHaveCount(0);
    await expect(runBar.getByTestId("active-run-open-gate")).toBeVisible();
    await runBar.getByTestId("active-run-open-gate").click();
    const gateSheet = page.getByTestId("agent-gate-sheet");
    await expect(gateSheet).toBeVisible();
    await expect(gateSheet.getByTestId("agent-plan-gate")).toHaveCount(1);
    await expect(page.getByTestId("agent-plan-gate")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(gateSheet).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(runBar.getByTestId("agent-plan-gate")).toHaveCount(0);
    await runBar.getByTestId("active-run-open-gate").click();
    const gateDrawer = page.getByTestId("agent-gate-drawer");
    await expect(gateDrawer).toBeVisible();
    await expect(gateDrawer.getByTestId("agent-plan-gate")).toHaveCount(1);
    await expect(page.getByTestId("agent-plan-gate")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(gateDrawer).toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(runBar.getByTestId("agent-plan-gate")).toHaveCount(1);

    await page.reload();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await ensureProducePanelOpen();
    await expect(page.getByTestId("active-run-bar")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("active-run-bar").getByTestId("agent-plan-gate")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("wiki-produce-details")).toHaveAttribute(
      "data-wiki-run-state",
      "waiting_for_operator",
      { timeout: 30_000 },
    );
    // Approve on the Active Run bar only (not the produce receipt card).
    await page.getByTestId("active-run-bar").getByTestId("agent-gate-approve").click();

    await expect(page.getByTestId("active-run-bar").getByTestId("agent-publication-gate")).toBeVisible(
      { timeout: 120_000 },
    );
    await expect(page.getByTestId("wiki-produce-details")).toHaveAttribute(
      "data-wiki-run-state",
      "waiting_for_operator",
      { timeout: 15_000 },
    );

    await page.reload();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await ensureProducePanelOpen();
    await expect(page.getByTestId("active-run-bar").getByTestId("agent-publication-gate")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("wiki-produce-details")).toHaveAttribute(
      "data-wiki-run-state",
      "waiting_for_operator",
      { timeout: 30_000 },
    );
    await page.getByTestId("active-run-bar").getByTestId("agent-gate-approve").click();

    await expect(page.getByTestId("wiki-produce-details")).toHaveAttribute(
      "data-wiki-run-state",
      "published",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("wiki-produce-details")).toHaveAttribute(
      "data-wiki-status",
      "accepted",
    );
    await expectWaitingNotThinking(page);

    await page.getByTestId("workspace-subnav-wiki").click();
    await expect(page.getByTestId("wiki-page")).toBeVisible({ timeout: 15_000 });
    // Tree shows page title; path is on data-page (fixture writes overview.md).
    const overviewLink = page.locator(
      '[data-testid="wiki-page-link"][data-page="overview.md"]',
    );
    await expect(overviewLink).toBeVisible({ timeout: 15_000 });
    await overviewLink.click();
    await expect(page.getByTestId("wiki-page-title")).toContainText(name);
    await expect(page.getByTestId("wiki-markdown")).toContainText("fixture mode");
  });

  test("workspaces picker loads and can open agent workspace route", async ({ page }) => {
    await page.goto("/workspaces");
    await expect(page.locator("body")).toBeVisible();
    await page.goto("/w/nonexistent-id");
    await expect(page.locator("body")).toBeVisible();
  });
});
