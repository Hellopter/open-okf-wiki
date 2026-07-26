/**
 * Workspace workbench shell — Operate / Configure body host.
 * Single top bar with mode switch (plan §3.2). No AppSidebar, no Subnav.
 */

import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ErrorBanner } from "../components/ErrorBanner";
import { useI18n } from "../i18n";
import { configureHref, operateHref, wikiHref } from "../lib/workspace-path";

export type WorkbenchMode = "operate" | "wiki" | "configure";

export type WorkbenchShellProps = {
  workspaceId: string;
  workspaceName?: string;
  mode: WorkbenchMode;
  children: ReactNode;
  /** Optional status chip / phase strip slot (right of mode nav). */
  statusSlot?: ReactNode;
  actions?: ReactNode;
  error?: unknown;
  onDismissError?: () => void;
  /** Full-height immersive body (Operate). */
  immersive?: boolean;
  testId?: string;
  className?: string;
};

export function WorkbenchShell({
  workspaceId,
  workspaceName,
  mode,
  children,
  statusSlot,
  actions,
  error,
  onDismissError,
  immersive = false,
  testId,
  className,
}: WorkbenchShellProps) {
  const { t } = useI18n();
  const displayName = workspaceName ?? workspaceId;

  // data-testid values keep e2e selectors (workspace-subnav-*) stable across shells.
  const modes: { id: WorkbenchMode; label: string; to: string; testId: string }[] = [
    {
      id: "operate",
      label: t.subnav.agent,
      to: operateHref(workspaceId),
      testId: "workspace-subnav-agent",
    },
    {
      id: "wiki",
      label: t.subnav.wiki,
      to: wikiHref(workspaceId),
      testId: "workspace-subnav-wiki",
    },
    {
      id: "configure",
      label: t.subnav.settings,
      to: configureHref(workspaceId),
      testId: "workspace-subnav-settings",
    },
  ];

  return (
    <div
      className={cn("flex h-svh flex-col overflow-hidden bg-background", className)}
      data-testid={testId ?? "workbench-shell"}
      data-mode={mode}
    >
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1 md:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            to="/workspaces"
            className="shrink-0 text-xs text-muted-foreground no-underline hover:text-foreground hover:underline"
            data-testid="workbench-back-workspaces"
          >
            {t.nav.workspaces}
          </Link>
          <span className="text-muted-foreground/50" aria-hidden>
            /
          </span>
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">{displayName}</h1>

          <nav
            className="ml-1 flex min-w-0 items-center gap-0.5 rounded-md border border-border/70 p-0.5"
            aria-label={t.subnav.aria}
            data-testid="workbench-mode-nav"
          >
            {modes.map((item) => (
              <Button
                key={item.id}
                size="xs"
                variant={mode === item.id ? "secondary" : "ghost"}
                render={<NavLink to={item.to} data-testid={item.testId} />}
                className="text-xs"
              >
                {item.label}
              </Button>
            ))}
          </nav>

          {statusSlot ? <div className="min-w-0 shrink-0">{statusSlot}</div> : null}
        </div>

        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>

      {error ? (
        <div className="shrink-0 px-3 pt-2">
          <ErrorBanner error={error} onDismiss={onDismissError} />
        </div>
      ) : null}

      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          immersive ? "overflow-hidden" : "overflow-y-auto p-4 md:p-6",
        )}
      >
        {children}
      </div>
    </div>
  );
}
