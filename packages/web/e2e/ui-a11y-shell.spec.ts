import { expect, test } from "@playwright/test";
import { createWorkspaceViaUi, expectVisibleBox } from "./helpers";

test.describe("UI shell a11y and polish", () => {
  test("command menu opens via trigger and navigates", async ({ page }) => {
    await page.goto("/workspaces");
    await expect(page.getByTestId("workspaces-page")).toBeVisible();
    await expect(page.getByTestId("command-menu-trigger")).toBeAttached();

    // sr-only trigger sits off-viewport; DOM click is the stable open path.
    await page.getByTestId("command-menu-trigger").evaluate((el: HTMLElement) => el.click());
    const menu = page.getByTestId("command-menu");
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByPlaceholder(/command/i)).toBeVisible();

    // Also assert Escape closes the palette.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await page.getByTestId("command-menu-trigger").evaluate((el: HTMLElement) => el.click());
    await expect(menu).toBeVisible();
    const settingsItem = menu.getByRole("option", { name: /settings/i });
    if ((await settingsItem.count()) > 0) {
      await settingsItem.click();
    } else {
      await menu.getByText(/^settings$/i).click();
    }
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByTestId("global-settings-page")).toBeVisible();
  });

  test("theme hotkey toggles dark class outside form fields", async ({ page }) => {
    await page.goto("/workspaces");
    await expect(page.getByTestId("workspaces-page")).toBeVisible();

    const before = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    await page.keyboard.press("d");
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.classList.contains("dark")))
      .not.toBe(before);

    // Focus a text field — hotkey must be ignored.
    const afterToggle = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    await page
      .getByRole("button", { name: /^create( workspace)?$/i })
      .first()
      .click();
    const nameInput = page.getByTestId("workspace-name-input");
    await nameInput.focus();
    await page.keyboard.press("d");
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(afterToggle);
  });

  test("document metadata and SEO assets are present", async ({ page, request }) => {
    await page.goto("/workspaces");
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
    expect(title.toLowerCase()).toContain("okf-wiki");

    const description = await page.locator('meta[name="description"]').getAttribute("content");
    expect(description?.trim().length ?? 0).toBeGreaterThan(10);

    const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
    expect(ogImage).toBeTruthy();

    const robots = await request.get("/robots.txt");
    expect(robots.ok()).toBeTruthy();
    expect(await robots.text()).toMatch(/User-agent/i);

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.ok()).toBeTruthy();
    expect(await sitemap.text()).toMatch(/urlset/i);
  });

  test("mobile viewport: no horizontal document overflow and subnav menu works", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    const { name } = await createWorkspaceViaUi(page, "Mobile A11y");
    await expect(page.getByTestId("agent-workspace-page")).toContainText(name);

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        clientWidth: doc.clientWidth,
        scrollWidth: doc.scrollWidth,
      };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    const url = new URL(page.url());
    const idMatch = url.pathname.match(/\/w\/([^/]+)/);
    expect(idMatch?.[1]).toBeTruthy();
    const workspaceId = idMatch![1]!;
    // Id-only configure route (no rootPath query).
    await page.goto(`/w/${encodeURIComponent(workspaceId)}/configure`);
    await expect(page.getByTestId("configure-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 15_000 });

    // Configure tabs (sources / workspace settings) — no legacy subnav menu.
    await expect(page.getByTestId("workspace-subnav-sources")).toBeVisible();
    await page.getByTestId("workspace-subnav-sources").click();
    await expect(page.getByTestId("sources-page")).toBeVisible({ timeout: 15_000 });
  });

  test("icon controls and dialogs expose accessible names on agent mobile chrome", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createWorkspaceViaUi(page, "Mobile Chrome");

    // Hard-cut: right context panels removed — only sessions mobile chrome.
    const sessions = page.getByTestId("agent-mobile-sessions");
    await expect(sessions).toBeVisible();
    await expect(page.getByTestId("agent-mobile-panels")).toHaveCount(0);
    await expect(sessions).toHaveAttribute("aria-label", /session/i);

    // Target size ≥ 24 CSS px (WCAG 2.5.8)
    await expectVisibleBox(sessions, { minWidth: 24, minHeight: 24 });

    await sessions.click();
    const sessionsDialog = page.getByRole("dialog");
    await expect(sessionsDialog).toBeVisible();
    // SheetTitle is sr-only — assert accessible name, not visual heading.
    await expect(sessionsDialog).toHaveAttribute("aria-labelledby", /.+/);
    await expect(sessionsDialog.locator('[data-slot="sheet-title"]')).toHaveText(/sessions/i);
    await page.keyboard.press("Escape");
    await expect(sessionsDialog).toBeHidden();
  });

  test("primary interactive chrome has usable pointer targets on desktop", async ({ page }) => {
    await page.goto("/workspaces");
    await expect(page.getByTestId("workspaces-page")).toBeVisible();

    const create = page.getByRole("button", { name: /^create( workspace)?$/i }).first();
    await expectVisibleBox(create, { minWidth: 24, minHeight: 24 });

    const navWorkspaces = page.getByTestId("nav-workspaces");
    if (await navWorkspaces.isVisible()) {
      await expectVisibleBox(navWorkspaces, { minWidth: 24, minHeight: 24 });
    }
  });
});
