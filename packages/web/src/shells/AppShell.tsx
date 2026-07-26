/**
 * Global app shell for list + settings routes.
 * Top bar only — no permanent sidebar (plan §3.1).
 */

import { BookOpenIcon, LanguagesIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { type Locale, useI18n } from "../i18n";
import type { Theme } from "../theme/theme-context";
import { useTheme } from "../theme/use-theme";

export type AppShellProps = {
  children: ReactNode;
  className?: string;
  /** data-testid on main content wrapper */
  testId?: string;
};

export function AppShell({ children, className, testId }: AppShellProps) {
  const { t, locale, setLocale } = useI18n();
  const { theme, resolvedTheme, setTheme } = useTheme();

  function cycleLocale() {
    const next: Locale = locale === "en" ? "zh" : "en";
    setLocale(next);
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background" data-testid="app-shell">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:px-4">
        <Link
          to="/workspaces"
          className="flex min-w-0 items-center gap-2 text-foreground no-underline"
          data-testid="app-brand"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BookOpenIcon className="size-3.5" />
          </span>
          <span className="truncate text-sm font-semibold tracking-tight">{t.app.brand}</span>
        </Link>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <nav className="flex min-w-0 flex-1 items-center gap-1" aria-label={t.app.sidebarAria}>
          <Button
            variant="ghost"
            size="sm"
            render={
              <NavLink
                to="/workspaces"
                data-testid="nav-workspaces"
                className={({ isActive }) => cn(isActive && "bg-muted")}
              />
            }
          >
            {t.nav.workspaces}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            render={
              <NavLink
                to="/settings"
                data-testid="nav-settings"
                className={({ isActive }) => cn(isActive && "bg-muted")}
              />
            }
          >
            <SettingsIcon data-icon="inline-start" />
            {t.nav.settings}
          </Button>
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cycleLocale}
            aria-label={t.locale.switchTo}
            title={`${t.locale.label}: ${locale === "en" ? t.locale.en : t.locale.zh}`}
            data-testid="locale-switch"
          >
            <LanguagesIcon data-icon="inline-start" />
            <span className="tabular-nums">{locale === "en" ? "EN" : "中"}</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.commandMenu.appearance}
                  data-testid="theme-menu"
                />
              }
            >
              {resolvedTheme === "dark" ? <MoonIcon /> : <SunIcon />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuGroup>
                {(
                  [
                    ["system", t.commandMenu.themeSystemName],
                    ["light", t.commandMenu.themeLightName],
                    ["dark", t.commandMenu.themeDarkName],
                  ] as const
                ).map(([value, label]) => (
                  <DropdownMenuItem
                    key={value}
                    data-testid={`theme-${value}`}
                    onClick={() => setTheme(value as Theme)}
                  >
                    <span className={cn(theme === value && "font-medium")}>{label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main
        data-testid={testId}
        className={cn("min-h-0 flex-1 overflow-y-auto", className ?? "p-4 md:p-6 lg:p-8")}
      >
        {children}
      </main>
    </div>
  );
}
