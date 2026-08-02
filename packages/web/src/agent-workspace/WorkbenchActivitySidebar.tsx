import { MenuIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { PiSessionSummary, WikiRunListItem } from "../api";
import type { MessageTree } from "../i18n";
import { CollapsedTimelineSidebar, TimelineSidebar } from "./TimelineSidebar";

type WorkbenchActivitySidebarProps = {
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  runs: WikiRunListItem[];
  activeRunId: string | null;
  onSelectSession: (id: string) => void;
  onSelectRun: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  creating: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  onShowConversation: () => void;
  onShowRun: () => void;
  t: MessageTree;
};

export function WorkbenchActivitySidebar({
  sessions,
  activeSessionId,
  runs,
  activeRunId,
  onSelectSession,
  onSelectRun,
  onCreateSession,
  onDeleteSession,
  creating,
  collapsed,
  onCollapsedChange,
  mobileOpen,
  onMobileOpenChange,
  onShowConversation,
  onShowRun,
  t,
}: WorkbenchActivitySidebarProps) {
  const timelineProps = {
    sessions,
    activeSessionId,
    runs,
    activeRunId,
    onSelectSession,
    onSelectRun,
    onCreateSession,
    onDeleteSession,
    creating,
    t,
  };

  return (
    <>
      <aside
        className={cn(
          "hidden shrink-0 overflow-hidden border-r border-border bg-muted/20 transition-[width] duration-200 ease-out lg:block",
          collapsed ? "w-12" : "w-72",
        )}
        aria-label={t.workbench.activity}
        data-testid="workbench-timeline-sidebar"
        data-collapsed={collapsed}
      >
        {collapsed ? (
          <CollapsedTimelineSidebar
            onExpand={() => onCollapsedChange(false)}
            onShowConversation={onShowConversation}
            onShowRun={onShowRun}
            t={t}
          />
        ) : (
          <TimelineSidebar {...timelineProps} onCollapse={() => onCollapsedChange(true)} />
        )}
      </aside>
      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <Button
          size="icon-sm"
          variant="ghost"
          className="absolute top-12 left-2 z-10 lg:hidden"
          onClick={() => onMobileOpenChange(true)}
          aria-label={t.workbench.openActivity}
          title={t.workbench.openActivity}
        >
          <MenuIcon />
        </Button>
        <SheetContent side="left" className="w-[min(20rem,85vw)] p-0">
          <SheetHeader>
            <SheetTitle>{t.workbench.activity}</SheetTitle>
          </SheetHeader>
          <TimelineSidebar {...timelineProps} />
        </SheetContent>
      </Sheet>
    </>
  );
}
