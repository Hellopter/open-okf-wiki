/**
 * Full-bleed wiki reader shell (plan §4.8 / ADR 0016).
 * Separate from Operate workbench chrome.
 */

import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ErrorBanner } from "../components/ErrorBanner";
import { useI18n } from "../i18n";
import { operateHref } from "../lib/workspace-path";

export type WikiReaderShellProps = {
  workspaceId: string;
  workspaceName?: string;
  pageLabel?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  error?: unknown;
  onDismissError?: () => void;
  testId?: string;
  className?: string;
};

export function WikiReaderShell({
  workspaceId,
  workspaceName,
  pageLabel,
  actions,
  children,
  error,
  onDismissError,
  testId,
  className,
}: WikiReaderShellProps) {
  const { t } = useI18n();
  const displayName = workspaceName ?? workspaceId;

  return (
    <div
      className={cn("flex h-svh flex-col overflow-hidden bg-background", className)}
      data-testid={testId ?? "wiki-reader-shell"}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button
          size="sm"
          variant="ghost"
          render={<Link to={operateHref(workspaceId)} data-testid="wiki-back-operate" />}
          nativeButton={false}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          {t.subnav.runs}
        </Button>
        <span className="text-muted-foreground/50" aria-hidden>
          /
        </span>
        <span className="min-w-0 truncate text-sm font-medium">{displayName}</span>
        {pageLabel ? (
          <>
            <span className="text-muted-foreground/50" aria-hidden>
              /
            </span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">{pageLabel}</span>
          </>
        ) : null}
        <div className="flex-1" />
        {actions}
      </header>

      {error ? (
        <div className="shrink-0 px-3 pt-2">
          <ErrorBanner error={error} onDismiss={onDismissError} />
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
