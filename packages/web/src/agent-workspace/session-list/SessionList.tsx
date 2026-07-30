/**
 * Session Navigator for the Agent Workbench.
 *
 * It deliberately owns only Pi session navigation. WikiRun selection and
 * control remain in the Run surface so switching sessions cannot alter the
 * workspace-level Run subscription.
 */

import {
  BookOpenIcon,
  LayoutListIcon,
  MessageSquareIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { PiSessionSummary } from "../../api";
import { formatMessage, useI18n } from "../../i18n";
import { configureHref, operateHref, wikiHref } from "../../lib/workspace-path";

export type AgentSessionSidebarProps = {
  workspaceId: string;
  workspaceName?: string;
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onDelete?: (sessionId: string) => void | Promise<void>;
  creating?: boolean;
  deletingId?: string | null;
  className?: string;
};

function formatLabel(session: PiSessionSummary): string {
  const title = session.title?.trim();
  return title || session.id.slice(0, 10);
}

function formatUpdated(iso?: string, locale?: string): string {
  if (!iso) return "-";
  try {
    const date = new Date(iso);
    const intlLocale = locale === "zh" ? "zh-CN" : locale || undefined;
    const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
    const abs = Math.abs(diffSec);
    const rtf = new Intl.RelativeTimeFormat(intlLocale, { numeric: "auto" });
    if (abs < 60) return rtf.format(diffSec, "second");
    if (abs < 3_600) return rtf.format(Math.round(diffSec / 60), "minute");
    if (abs < 86_400) return rtf.format(Math.round(diffSec / 3_600), "hour");
    if (abs < 86_400 * 7) return rtf.format(Math.round(diffSec / 86_400), "day");
    return date.toLocaleString(intlLocale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function uniqueSessions(sessions: PiSessionSummary[]): PiSessionSummary[] {
  const seenIds = new Set<string>();
  return sessions.filter((session) => {
    if (seenIds.has(session.id)) return false;
    seenIds.add(session.id);
    return true;
  });
}

export function AgentSessionSidebar({
  workspaceId,
  workspaceName,
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  creating = false,
  deletingId = null,
  className,
}: AgentSessionSidebarProps) {
  const { t, locale } = useI18n();
  const { isMobile, setOpenMobile } = useSidebar();
  const [deleteTarget, setDeleteTarget] = useState<PiSessionSummary | null>(null);
  const items = uniqueSessions(sessions);

  const selectSession = (sessionId: string) => {
    onSelect(sessionId);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <Sidebar
        collapsible="icon"
        data-testid="agent-left-pane"
        className={cn(className)}
      >
        <SidebarHeader>
          <SidebarGroupLabel title={workspaceName ?? workspaceId}>
            {workspaceName ?? workspaceId}
          </SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                tooltip={t.agentWorkspace.newSession}
                data-testid="agent-session-new"
                disabled={creating}
                onClick={onCreate}
              >
                <PlusIcon />
                <span>{creating ? t.agentWorkspace.creatingSession : t.agentWorkspace.newSession}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarSeparator />

        <SidebarContent data-testid="agent-session-list">
          <SidebarGroup>
            <SidebarGroupLabel>{t.agentWorkspace.sessions}</SidebarGroupLabel>
            <SidebarGroupContent>
              {items.length === 0 ? (
                <Empty className="border-0 px-3 py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageSquareIcon aria-hidden />
                    </EmptyMedia>
                    <EmptyDescription className="text-xs">
                      {t.agentWorkspace.noSessions}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <SidebarMenu>
                  {items.map((session) => {
                    const active = session.id === activeSessionId;
                    const deleting = deletingId === session.id;
                    return (
                      <SidebarMenuItem
                        key={session.id}
                        data-testid="agent-session-item"
                        data-session-id={session.id}
                        data-active={active ? "true" : "false"}
                        onClick={() => {
                          if (!deleting) selectSession(session.id);
                        }}
                      >
                        <SidebarMenuButton
                          isActive={active}
                          size="lg"
                          tooltip={formatLabel(session)}
                          disabled={deleting}
                        >
                          <MessageSquareIcon />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{formatLabel(session)}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {formatUpdated(session.updatedAt, locale)}
                            </span>
                          </span>
                        </SidebarMenuButton>
                        {onDelete ? (
                          <SidebarMenuAction
                            type="button"
                            showOnHover={false}
                            data-testid="agent-session-delete"
                            data-session-id={session.id}
                            title={t.agentWorkspace.deleteSession}
                            aria-label={t.agentWorkspace.deleteSession}
                            disabled={deleting}
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteTarget(session);
                            }}
                          >
                            <Trash2Icon />
                          </SidebarMenuAction>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarSeparator />

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/workspaces" data-testid="workbench-back-workspaces" />}
                tooltip={t.nav.workspaces}
              >
                <LayoutListIcon />
                <span>{t.nav.workspaces}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive
                render={<Link to={operateHref(workspaceId)} data-testid="workspace-subnav-agent" />}
                tooltip={t.subnav.agent}
              >
                <MessageSquareIcon />
                <span>{t.subnav.agent}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to={wikiHref(workspaceId)} data-testid="workspace-subnav-wiki" />}
                tooltip={t.subnav.wiki}
              >
                <BookOpenIcon />
                <span>{t.subnav.wiki}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link to={configureHref(workspaceId)} data-testid="workspace-subnav-settings" />
                }
                tooltip={t.subnav.settings}
              >
                <SettingsIcon />
                <span>{t.subnav.settings}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail
          data-testid="agent-left-rail"
          aria-label={t.agentWorkspace.toggleSessions}
          title={t.agentWorkspace.toggleSessions}
        />
      </Sidebar>

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t.agentWorkspace.deleteSession}
        description={
          deleteTarget
            ? formatMessage(t.agentWorkspace.deleteSessionConfirm, {
                title: formatLabel(deleteTarget),
              })
            : undefined
        }
        confirmLabel={deletingId ? t.agentWorkspace.deletingSession : t.common.delete}
        cancelLabel={t.common.cancel}
        destructive
        confirmDisabled={deletingId != null}
        data-testid="agent-session-delete-dialog"
        confirmTestId="agent-session-delete-confirm"
        onConfirm={async () => {
          if (!deleteTarget || !onDelete) return;
          const id = deleteTarget.id;
          setDeleteTarget(null);
          await onDelete(id);
        }}
      />
    </>
  );
}

/** @deprecated Use AgentSessionSidebar. */
export const SessionList = AgentSessionSidebar;
